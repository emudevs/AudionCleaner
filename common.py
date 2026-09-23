from __future__ import annotations

import json
import shutil
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
TOOLS_DIR = APP_ROOT / "tools"
RUNTIME_FILE = APP_ROOT / "runtime.json"
SETTINGS_FILE = APP_ROOT / "settings.json"

APP_VERSION = "1.0.0"
INSTALL_SCHEMA = 1


DEFAULT_SETTINGS = {
    "separator_preset": "instrumental_full",
    "separator_sample_rate": 48000,
    "separator_normalization": 0.90,
    "separator_amplification": 0.00,
    "separator_invert_spect": False,
    "separator_use_soundfile": True,
    "precision": "fp32",
    "torch_compile": False,

    "post_profile": "safe",
    "highpass_enabled": True,
    "highpass_hz": 20.0,

    "denoise_mode": "auto",
    "denoise_reduction_db": 4.0,
    "noise_floor_threshold_db": -50.0,
    "noise_flatness_threshold": 0.45,

    "declick_enabled": False,

    "high_end_recovery": False,
    "high_end_cutoff_hz": 12000.0,
    "high_end_gain_db": -18.0,

    "loudnorm_enabled": True,
    "target_lufs": -18.0,
    "target_lra": 20.0,
    "true_peak_db": -1.5,

    "compressor_enabled": False,
    "compressor_threshold_db": -18.0,
    "compressor_ratio": 2.0,
    "compressor_attack_ms": 20.0,
    "compressor_release_ms": 250.0,

    "limiter_enabled": False,
    "limiter_limit": 0.95,

    "output_sample_rate": 48000,
    "output_bit_depth": "24-bit PCM",
    "auto_start": True,
    "keep_prepared_audio": False,
    "keep_raw_separated": False,
    "last_dir": "",
    "model_cache_dir": str(APP_ROOT / "models"),
}


POST_PROFILES = {
    "off": {
        "highpass_enabled": False,
        "denoise_mode": "off",
        "declick_enabled": False,
        "high_end_recovery": False,
        "loudnorm_enabled": False,
        "compressor_enabled": False,
        "limiter_enabled": False,
    },
    "safe": {
        "highpass_enabled": True,
        "highpass_hz": 20.0,
        "denoise_mode": "auto",
        "denoise_reduction_db": 4.0,
        "noise_floor_threshold_db": -50.0,
        "noise_flatness_threshold": 0.45,
        "declick_enabled": False,
        "high_end_recovery": False,
        "loudnorm_enabled": True,
        "target_lufs": -18.0,
        "target_lra": 20.0,
        "true_peak_db": -1.5,
        "compressor_enabled": False,
        "limiter_enabled": False,
    },
    "restoration": {
        "highpass_enabled": True,
        "highpass_hz": 20.0,
        "denoise_mode": "auto",
        "denoise_reduction_db": 3.0,
        "noise_floor_threshold_db": -48.0,
        "noise_flatness_threshold": 0.50,
        "declick_enabled": False,
        "high_end_recovery": True,
        "high_end_cutoff_hz": 12000.0,
        "high_end_gain_db": -20.0,
        "loudnorm_enabled": True,
        "target_lufs": -18.0,
        "target_lra": 20.0,
        "true_peak_db": -1.5,
        "compressor_enabled": False,
        "limiter_enabled": False,
    },
}


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_settings() -> dict:
    data = DEFAULT_SETTINGS.copy()
    data.update(load_json(SETTINGS_FILE, {}))
    return data


def save_settings(settings: dict) -> None:
    save_json(SETTINGS_FILE, settings)


def load_runtime() -> dict:
    return load_json(RUNTIME_FILE, {})


def save_runtime(runtime: dict) -> None:
    save_json(RUNTIME_FILE, runtime)


def ffmpeg_path() -> str:
    runtime = load_runtime()
    p = runtime.get("ffmpeg")
    if p and Path(p).exists():
        return p

    p = shutil.which("ffmpeg")
    if p:
        return p

    local = TOOLS_DIR / "ffmpeg" / "bin" / "ffmpeg.exe"
    if local.exists():
        return str(local)

    raise FileNotFoundError("FFmpeg не найден. Запусти repair.bat.")


def ffprobe_path() -> str:
    runtime = load_runtime()
    p = runtime.get("ffprobe")
    if p and Path(p).exists():
        return p

    p = shutil.which("ffprobe")
    if p:
        return p

    local = TOOLS_DIR / "ffmpeg" / "bin" / "ffprobe.exe"
    if local.exists():
        return str(local)

    raise FileNotFoundError("FFprobe не найден. Запусти repair.bat.")
