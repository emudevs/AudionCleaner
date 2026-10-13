"""Cross-platform FFmpeg media inspection and first-frame extraction."""
from __future__ import annotations

import base64
import json
import math
import subprocess
from pathlib import Path

from common import ffmpeg_path, ffprobe_path


def source_path(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Медиафайл не найден: {path}")
    return path


def _milliseconds(value: object) -> int | None:
    """FFprobe may omit timing fields or report 'N/A' for some containers."""
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return round(number * 1000) if math.isfinite(number) else None


def inspect(raw: str) -> dict:
    path = source_path(raw)
    command = [
        ffprobe_path(), "-v", "error", "-show_format", "-show_streams",
        "-of", "json", str(path),
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=45)
    probe = json.loads(result.stdout)
    streams = probe.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if not audios:
        raise ValueError("Не найдено ни одной аудиодорожки")
    first = videos[0] if videos else None
    duration = (_milliseconds(probe.get("format", {}).get("duration")) or 0) / 1000
    if duration <= 0:
        duration = max(((_milliseconds(s.get("duration")) or 0) / 1000 for s in streams), default=0)
    return {
        "path": str(path),
        "name": path.name,
        "hasVideo": first is not None,
        "durationMs": max(0, round(duration * 1000)),
        "sizeBytes": path.stat().st_size,
        "video": ({
            "width": first.get("width"),
            "height": first.get("height"),
            "codec": first.get("codec_name"),
            "frameRate": first.get("avg_frame_rate") or first.get("r_frame_rate"),
        } if first else None),
        "audioStreams": [
            {
                "index": int(s["index"]),
                "codec": s.get("codec_name", ""),
                "channels": s.get("channels", 2),
                "language": (s.get("tags") or {}).get("language", ""),
                "title": (s.get("tags") or {}).get("title", ""),
                "bitrate": s.get("bit_rate"),
                "durationMs": _milliseconds(s.get("duration")),
                "startMs": _milliseconds(s.get("start_time")),
            }
            for s in audios
        ],
    }


def thumbnail(raw: str, timestamp_ms: int = 0) -> dict:
    path = source_path(raw)
    timestamp = max(0, min(int(timestamp_ms), 24 * 60 * 60 * 1000))
    command = [
        ffmpeg_path(), "-nostdin", "-hide_banner", "-v", "error",
        "-ss", f"{timestamp / 1000:.3f}", "-i", str(path),
        "-map", "0:v:0", "-frames:v", "1",
        "-vf", "scale=960:-2", "-vcodec", "mjpeg",
        "-f", "image2pipe", "pipe:1",
    ]
    result = subprocess.run(command, capture_output=True, timeout=50)
    if result.returncode or not result.stdout:
        message = result.stderr.decode("utf-8", "replace")[-700:]
        raise RuntimeError(message or "Не удалось прочитать кадр видео")
    return {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(result.stdout).decode("ascii")}
