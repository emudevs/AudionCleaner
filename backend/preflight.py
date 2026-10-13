"""Fast, import-free environment diagnostics for the real separation pipeline."""
from __future__ import annotations

import importlib.util
import os
import shutil
from pathlib import Path

from common import APP_ROOT, ffmpeg_path, ffprobe_path, load_settings


def verify_runtime(settings: dict | None = None) -> dict:
    """Validate executables and Python modules without importing Torch or NumPy.

    Model weights may be fetched by audio-separator, so a missing cache is
    reported as a warning, not incorrectly treated as a fatal failure.
    """
    settings = settings or load_settings()
    errors: list[str] = []
    warnings: list[str] = []
    executables: dict[str, str] = {}
    for label, resolve in (("FFmpeg", ffmpeg_path), ("FFprobe", ffprobe_path)):
        try:
            value = resolve()
            if not (Path(value).is_file() or shutil.which(value)):
                raise FileNotFoundError(value)
            executables[label] = value
        except (FileNotFoundError, OSError) as exc:
            errors.append(f"{label}: исполняемый файл не найден ({exc})")

    modules: dict[str, bool] = {}
    for name in ("numpy", "soundfile", "torch", "audio_separator", "requests"):
        try:
            ok = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            ok = False
        modules[name] = ok
        if not ok:
            errors.append(
                f"Модуль Python «{name}» отсутствует в окружении бэкенда. "
                "Установи зависимости ACL в используемый Python."
            )

    if not (APP_ROOT / "separator_runner.py").is_file():
        errors.append("Не найден separator_runner.py рядом с ядром ACL.")

    preset = str(settings.get("separator_preset") or "instrumental_full")
    folder = Path(settings.get("model_cache_dir") or APP_ROOT / "models").expanduser()
    local_files = 0
    for location in (folder, APP_ROOT / "models"):
        if location.is_dir():
            try:
                local_files = max(
                    local_files,
                    sum(1 for p in location.iterdir() if p.is_file() and
                        p.suffix.lower() in (".onnx", ".ckpt", ".pth", ".pt", ".safetensors")),
                )
            except OSError:
                pass
    if not local_files:
        warnings.append(
            "В локальном кеше не обнаружены файлы моделей. "
            "audio-separator может начать загрузку из интернета."
        )

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "preset": preset,
        "modelCache": str(folder),
        "modelFilesSeen": local_files,
        "modules": modules,
        "executables": executables,
        "python": os.sys.executable,
    }
