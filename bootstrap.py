from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

from common import (
    APP_ROOT,
    APP_VERSION,
    INSTALL_SCHEMA,
    RUNTIME_FILE,
    TOOLS_DIR,
    save_runtime,
)

VENV = APP_ROOT / ".venv"
MARKER = APP_ROOT / ".installed.json"

FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
AUDIO_SEPARATOR_VERSION = "0.47.0"


def log(message: str) -> None:
    print(message, flush=True)


def run(cmd, *, check=True, capture=False):
    log("> " + " ".join(map(str, cmd)))
    return subprocess.run(
        list(map(str, cmd)),
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )


def venv_python() -> Path:
    return VENV / "Scripts" / "python.exe" if os.name == "nt" else VENV / "bin" / "python"


def venv_pip() -> list[str]:
    return [str(venv_python()), "-m", "pip"]


def has_nvidia() -> bool:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return False
    try:
        result = subprocess.run(
            [exe, "--query-gpu=name", "--format=csv,noheader"],
            text=True,
            capture_output=True,
            timeout=10,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False


def make_venv(force=False) -> None:
    if force and VENV.exists():
        log("Удаляю старое виртуальное окружение...")
        shutil.rmtree(VENV, ignore_errors=True)

    if not venv_python().exists():
        log("Создаю .venv...")
        subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)


def install_packages(force=False) -> dict:
    gpu = os.name == "nt" and has_nvidia()

    if force:
        marker_ok = False
    else:
        marker_ok = False
        if MARKER.exists():
            try:
                marker = json.loads(MARKER.read_text(encoding="utf-8"))
                marker_ok = (
                    marker.get("schema") == INSTALL_SCHEMA
                    and marker.get("app_version") == APP_VERSION
                    and marker.get("audio_separator") == AUDIO_SEPARATOR_VERSION
                    and marker.get("gpu") == gpu
                )
            except Exception:
                marker_ok = False

    if marker_ok:
        log("Python-зависимости уже установлены.")
        return {"gpu_expected": gpu}

    pip = venv_pip()
    run(pip + ["install", "--upgrade", "pip", "setuptools", "wheel"])

    if gpu:
        log("NVIDIA найдена. Ставлю PyTorch CUDA 13.0...")
        run(
            pip
            + [
                "install",
                "--upgrade",
                "torch",
                "torchvision",
                "torchaudio",
                "--index-url",
                "https://download.pytorch.org/whl/cu130",
            ]
        )

        run(
            pip
            + [
                "install",
                "--upgrade",
                f"audio-separator[gpu]=={AUDIO_SEPARATOR_VERSION}",
                "audioread",
                "librosa<1.0",
                "soundfile",
                "numpy",
                "tkinterdnd2",
                "onnxruntime-gpu[cuda,cudnn]>=1.27",
            ]
        )
    else:
        log("NVIDIA не найдена. Ставлю CPU-режим.")
        run(
            pip
            + [
                "install",
                "--upgrade",
                "torch",
                "torchvision",
                "torchaudio",
                f"audio-separator[cpu]=={AUDIO_SEPARATOR_VERSION}",
                "audioread",
                "librosa<1.0",
                "soundfile",
                "numpy",
                "tkinterdnd2",
                "onnxruntime",
            ]
        )

    MARKER.write_text(
        json.dumps(
            {
                "schema": INSTALL_SCHEMA,
                "app_version": APP_VERSION,
                "audio_separator": AUDIO_SEPARATOR_VERSION,
                "gpu": gpu,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return {"gpu_expected": gpu}


def download_ffmpeg(archive: Path) -> None:
    urls = []
    try:
        request = urllib.request.Request("https://api.github.com/repos/GyanD/codexffmpeg/releases/latest",
                                         headers={"User-Agent": "AnimeAudioCleaner"})
        with urllib.request.urlopen(request, timeout=15) as response:
            release = json.load(response)
        urls = [a["browser_download_url"] for a in release.get("assets", [])
                if a["name"].endswith("-essentials_build.zip")
                and a["browser_download_url"].startswith("https://github.com/GyanD/codexffmpeg/")]
    except Exception as exc:
        log(f"GitHub download discovery unavailable: {exc}")
    urls.append(FFMPEG_URL)
    errors = []
    for url in urls:
        try:
            log(f"Downloading FFmpeg: {url}")
            started = time.monotonic()
            with urllib.request.urlopen(url, timeout=20) as response, archive.open("wb") as target:
                while True:
                    if time.monotonic() - started > 300:
                        raise TimeoutError("FFmpeg download exceeded five minutes")
                    chunk = response.read1(1024 * 1024)
                    if not chunk:
                        break
                    target.write(chunk)
            if not zipfile.is_zipfile(archive):
                raise RuntimeError("Server did not return a ZIP archive")
            return
        except Exception as exc:
            errors.append(str(exc))
            log(f"Download failed, trying alternate source: {exc}")
    raise RuntimeError("; ".join(errors))


def valid_media_tool(path: Path) -> bool:
    try:
        result = subprocess.run([str(path), "-version"], capture_output=True,
                                timeout=15, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def install_ffmpeg(force=False) -> tuple[str, str]:
    if os.name != "nt":
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        if ffmpeg and ffprobe and all(valid_media_tool(Path(p)) for p in (ffmpeg, ffprobe)):
            return ffmpeg, ffprobe
        brew = shutil.which("brew") if sys.platform == "darwin" else None
        if brew:
            log("Installing FFmpeg + FFprobe with Homebrew...")
            run([brew, "install", "ffmpeg"])
            ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
            if ffmpeg and ffprobe and all(valid_media_tool(Path(p)) for p in (ffmpeg, ffprobe)):
                return ffmpeg, ffprobe
        raise RuntimeError("Install Homebrew (brew.sh) on macOS, then relaunch to install FFmpeg automatically.")

    local_root = TOOLS_DIR / "ffmpeg"
    binaries = [local_root / "bin" / name for name in ("ffmpeg.exe", "ffprobe.exe")]
    if force or not all(valid_media_tool(p) for p in binaries):
        TOOLS_DIR.mkdir(parents=True, exist_ok=True)
        log("Installing local FFmpeg + FFprobe (first launch or repair)...")
        try:
            with tempfile.TemporaryDirectory(dir=TOOLS_DIR) as temporary:
                staging = Path(temporary)
                archive = staging / "ffmpeg.zip"
                download_ffmpeg(archive)
                unpack = staging / "unpack"
                with zipfile.ZipFile(archive) as zf:
                    for item in zf.infolist():
                        target = (unpack / item.filename).resolve()
                        if not target.is_relative_to(unpack.resolve()):
                            raise RuntimeError("Unsafe FFmpeg archive path")
                    zf.extractall(unpack)
                candidates = list(unpack.glob("*/bin/ffmpeg.exe"))
                if len(candidates) != 1:
                    raise RuntimeError("FFmpeg archive does not contain the expected binaries")
                package = candidates[0].parent.parent
                if not all(valid_media_tool(package / "bin" / name) for name in ("ffmpeg.exe", "ffprobe.exe")):
                    raise RuntimeError("Downloaded FFmpeg/FFprobe failed the launch check")
                shutil.copytree(package, local_root, dirs_exist_ok=True)
        except Exception as exc:
            raise RuntimeError(f"FFmpeg installation failed: {exc}. Check your connection and rerun start.bat/the EXE.") from exc
    if not all(valid_media_tool(p) for p in binaries):
        raise RuntimeError("Local FFmpeg/FFprobe could not be started. Close running jobs and retry setup.")
    # Available to dependency diagnostics and all subprocesses of this bootstrap.
    os.environ["PATH"] = str(binaries[0].parent) + os.pathsep + os.environ.get("PATH", "")
    log("Local FFmpeg and FFprobe are ready.")
    return tuple(str(p) for p in binaries)


def environment_report() -> dict:
    script = r"""
import json
result = {}
try:
    import torch
    result["torch"] = torch.__version__
    result["torch_cuda"] = torch.version.cuda
    result["cuda_available"] = bool(torch.cuda.is_available())
    result["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
except Exception as e:
    result["torch_error"] = repr(e)

try:
    import onnxruntime as ort
    try:
        ort.preload_dlls()
    except Exception:
        try:
            ort.preload_dlls(directory="")
        except Exception:
            pass
    result["onnxruntime"] = ort.__version__
    result["providers"] = ort.get_available_providers()
except Exception as e:
    result["ort_error"] = repr(e)

try:
    import audio_separator
    result["audio_separator_import"] = True
except Exception as e:
    result["audio_separator_error"] = repr(e)

print(json.dumps(result, ensure_ascii=False))
"""
    result = run([str(venv_python()), "-c", script], capture=True, check=False)
    output = (result.stdout or "").strip().splitlines()
    if not output:
        return {"error": "Нет вывода диагностики"}
    try:
        return json.loads(output[-1])
    except Exception:
        return {"raw": "\n".join(output)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repair", action="store_true")
    args = parser.parse_args()

    if sys.version_info < (3, 10):
        log("Нужен Python 3.10+ (рекомендуется 3.12).")
        return 2

    try:
        log(f"Anime Audio Cleaner {APP_VERSION}")
        log("=" * 64)

        ffmpeg, ffprobe = install_ffmpeg(force=args.repair)
        make_venv(force=args.repair)
        install_info = install_packages(force=args.repair)

        report = environment_report()
        runtime = {
            "app_version": APP_VERSION,
            "ffmpeg": ffmpeg,
            "ffprobe": ffprobe,
            "gpu_expected": install_info.get("gpu_expected", False),
            "environment": report,
        }
        save_runtime(runtime)

        log("\nДиагностика:")
        log(json.dumps(report, ensure_ascii=False, indent=2))

        if install_info.get("gpu_expected") and not report.get("cuda_available", False):
            log(
                "\n[ВНИМАНИЕ] NVIDIA обнаружена, но PyTorch CUDA не активна. "
                "Программа запустится на CPU. Используй repair.bat после обновления драйвера."
            )

        log("\nГотово.")
        return 0

    except Exception as exc:
        log("\n[ОШИБКА УСТАНОВКИ]")
        log(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
