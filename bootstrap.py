from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
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
    return VENV / "Scripts" / "python.exe"


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
    gpu = has_nvidia()

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


def install_ffmpeg(force=False) -> tuple[str, str]:
    system_ffmpeg = shutil.which("ffmpeg")
    system_ffprobe = shutil.which("ffprobe")

    if not force and system_ffmpeg and system_ffprobe:
        log("FFmpeg найден в PATH.")
        return system_ffmpeg, system_ffprobe

    local_root = TOOLS_DIR / "ffmpeg"
    ffmpeg_exe = local_root / "bin" / "ffmpeg.exe"
    ffprobe_exe = local_root / "bin" / "ffprobe.exe"

    if not force and ffmpeg_exe.exists() and ffprobe_exe.exists():
        log("Локальный FFmpeg уже установлен.")
        return str(ffmpeg_exe), str(ffprobe_exe)

    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    log("Скачиваю FFmpeg essentials...")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        archive = tmp / "ffmpeg.zip"
        urllib.request.urlretrieve(FFMPEG_URL, archive)

        unpack = tmp / "unpack"
        unpack.mkdir()
        with zipfile.ZipFile(archive, "r") as zf:
            zf.extractall(unpack)

        roots = [p for p in unpack.iterdir() if p.is_dir()]
        if not roots:
            raise RuntimeError("Не удалось распаковать FFmpeg.")

        src = roots[0]
        if local_root.exists():
            shutil.rmtree(local_root, ignore_errors=True)
        shutil.copytree(src, local_root)

    if not ffmpeg_exe.exists() or not ffprobe_exe.exists():
        raise RuntimeError("FFmpeg скачан, но ffmpeg.exe/ffprobe.exe не найдены.")

    return str(ffmpeg_exe), str(ffprobe_exe)


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

        make_venv(force=args.repair)
        install_info = install_packages(force=args.repair)
        ffmpeg, ffprobe = install_ffmpeg(force=False)

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
