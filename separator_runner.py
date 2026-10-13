"""Resilient model downloads for the ACL audio-separator subprocess.

Only the downloader is replaced. Model selection, inference and separation remain
implemented by the installed audio-separator package.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

MAX_ATTEMPTS = 5
CHUNK_SIZE = 1024 * 1024


class ModelDownloadError(RuntimeError):
    pass


def download_model(self, url: str, output_path: str) -> None:
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.is_file() and target.stat().st_size > 0:
        # A cached manifest must be valid; a failed older download could have
        # left a truncated JSON file with a nonzero size.
        if target.suffix.lower() == ".json":
            try:
                json.loads(target.read_text(encoding="utf-8"))
                return
            except (ValueError, UnicodeError):
                self.logger.warning("Cached model manifest is damaged: %s", target)
                target.unlink()
        else:
            return

    part = target.with_name(target.name + ".part")
    last_error = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        offset = part.stat().st_size if part.exists() else 0
        headers = {"User-Agent": "AnimeAudioCleaner/1.0", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"

        try:
            self.logger.info(
                "Model download %d/%d: %s%s",
                attempt, MAX_ATTEMPTS, target.name,
                f" (resume at {offset:,} bytes)" if offset else "",
            )
            with requests.get(
                url, headers=headers, stream=True, timeout=(15, 90),
                allow_redirects=True,
            ) as response:
                if response.status_code == 416 and offset:
                    # Stale partial file or unsupported range; start clean.
                    part.unlink(missing_ok=True)
                    raise ValueError("The server rejected the saved partial download")
                if response.status_code in (403, 404):
                    raise ModelDownloadError(
                        f"ACL_DOWNLOAD_FAILED: HTTP {response.status_code} при загрузке "
                        f"«{target.name}» с {url}. Проверьте доступ к серверу моделей."
                    )
                response.raise_for_status()

                append = offset > 0 and response.status_code == 206
                if append:
                    content_range = response.headers.get("Content-Range", "")
                    if not content_range.startswith(f"bytes {offset}-"):
                        part.unlink(missing_ok=True)
                        raise ValueError("Unexpected Content-Range from download server")
                elif response.status_code != 200:
                    raise ValueError(f"Unexpected HTTP {response.status_code}")

                if target.suffix.lower() not in (".json", ".yaml", ".yml"):
                    content_type = response.headers.get("Content-Type", "").lower()
                    if "text/html" in content_type:
                        part.unlink(missing_ok=True)
                        raise ValueError("Server returned an HTML page instead of model weights")

                received = 0
                with part.open("ab" if append else "wb") as handle:
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if chunk:
                            handle.write(chunk)
                            received += len(chunk)

                content_length = response.headers.get("Content-Length")
                if (content_length is not None
                        and response.headers.get("Content-Encoding", "identity").lower() == "identity"
                        and received != int(content_length)):
                    raise IOError(
                        f"Incomplete download: {received:,} of {int(content_length):,} bytes"
                    )
                if part.stat().st_size == 0:
                    raise IOError("Empty download")

                if target.suffix.lower() == ".json":
                    json.loads(part.read_text(encoding="utf-8"))

                # Never expose a half-downloaded model as a complete cache file.
                os.replace(part, target)
                self.logger.info("Model file ready: %s", target.name)
                return

        except (requests.RequestException, OSError, ValueError, UnicodeError) as exc:
            last_error = exc
            self.logger.warning(
                "Download attempt %d/%d failed for %s: %s",
                attempt, MAX_ATTEMPTS, target.name, exc,
            )
            if attempt < MAX_ATTEMPTS:
                time.sleep(min(2 ** (attempt - 1), 12))

    raise ModelDownloadError(
        "ACL_DOWNLOAD_FAILED: Не удалось загрузить файл модели "
        f"«{target.name}» после {MAX_ATTEMPTS} попыток. "
        f"Кеш: {target.parent}. "
        "Проверьте интернет и доступ к GitHub, затем повторите обработку. "
        "Частично скачанный файл сохранён для продолжения загрузки. "
        f"Последняя ошибка: {last_error}"
    ) from last_error


def main() -> None:
    from audio_separator.separator import Separator
    from audio_separator.utils.cli import main as cli_main

    Separator.download_file_if_not_exists = download_model
    cli_main()


if __name__ == "__main__":
    main()
