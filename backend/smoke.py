"""Manual real-engine smoke test on a short local excerpt.

Usage: .venv/Scripts/python.exe -m backend.smoke "path/to/video.mkv" --seconds 8
This test WILL load/download neural models if they are not cached.
"""
from __future__ import annotations

import argparse
import subprocess
import tempfile
import threading
import wave
from pathlib import Path

from backend.media import inspect
from backend.preflight import verify_runtime
from backend.processing import process
from common import ffmpeg_path


def main() -> None:
    parser = argparse.ArgumentParser(description="ACL AI processing smoke test")
    parser.add_argument("source", type=Path, help="Local video/audio file")
    parser.add_argument("--seconds", type=int, default=8)
    parser.add_argument("--stream", type=int, default=None)
    args = parser.parse_args()
    readiness = verify_runtime()
    if not readiness["ok"]:
        raise SystemExit("Отсутствуют зависимости:\n" + "\n".join(readiness["errors"]))
    for warning in readiness["warnings"]:
        print("WARN:", warning, flush=True)
    info = inspect(str(args.source))
    if not info["audioStreams"]:
        raise SystemExit("Нет аудиодорожек")
    index = args.stream if args.stream is not None else info["audioStreams"][0]["index"]
    cancel = threading.Event()
    with tempfile.TemporaryDirectory(prefix="acl_smoke_") as directory:
        folder = Path(directory)
        clip = folder / "test_input.wav"
        print(f"Подготовка {args.seconds} сек. из потока #{index}…", flush=True)
        subprocess.run(
            [ffmpeg_path(), "-nostdin", "-hide_banner", "-v", "error",
             "-y", "-i", str(args.source), "-map", f"0:{index}", "-t",
             str(max(1, min(30, args.seconds))), "-ac", "2", "-ar", "48000",
             "-c:a", "pcm_f32le", str(clip)],
            check=True, timeout=180,
        )
        print(f"Входной тестовый фрагмент: {clip.stat().st_size:,} байт", flush=True)
        try:
            result = process(
                clip, 0, str(folder / "clean.wav"), {"post_profile": "off"},
                cancel,
                lambda name, payload: print(name, payload, flush=True),
            )
            file = Path(result["path"])
            with wave.open(str(file), "rb") as audio:
                assert audio.getnframes() > 0, "Пустой WAV"
                print(
                    f"OK: channels={audio.getnchannels()}, "
                    f"sample_rate={audio.getframerate()}, "
                    f"frames={audio.getnframes()}, bytes={file.stat().st_size:,}",
                    flush=True,
                )
        except KeyboardInterrupt:
            cancel.set()
            print("Тест прерван. Очистка временных файлов…", flush=True)
            raise SystemExit(130)


if __name__ == "__main__":
    main()
