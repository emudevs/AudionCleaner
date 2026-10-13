"""Stream real stereo PCM peaks in 20ms bins, without synthetic samples."""
from __future__ import annotations
import os
import struct
import subprocess
import threading
from pathlib import Path
from typing import Callable

from common import ffmpeg_path


def decode_peaks(
    path: Path,
    stream_index: int,
    send: Callable[[list[list[float]]], None],
    cancel: threading.Event,
    start_ms: int = 0,
    duration_ms: int | None = None,
    interval_ms: int = 20,
) -> dict:
    if not (1 <= interval_ms <= 100):
        raise ValueError("Некорректная детализация волны")
    if start_ms < 0 or (duration_ms is not None and not (1 <= duration_ms <= 180000)):
        raise ValueError("Некорректный временной отрезок")
    sample_rate = 8000 if interval_ms <= 5 else 2000
    samples_per_bin = max(1, round(sample_rate * interval_ms / 1000))
    bytes_per_bin = samples_per_bin * 2 * 4
    command = [ffmpeg_path(), "-nostdin", "-hide_banner", "-v", "error",
               "-i", str(path)]
    if start_ms:
        command += ["-ss", f"{start_ms/1000:.3f}"]
    if duration_ms is not None:
        command += ["-t", f"{duration_ms/1000:.3f}"]
    command += ["-map", f"0:{stream_index}", "-vn", "-sn", "-dn",
                "-ac", "2", "-ar", str(sample_rate), "-f", "f32le", "pipe:1"]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen(
        command, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=flags, bufsize=0,
    )
    watcher_stop = threading.Event()
    def watch_cancel() -> None:
        while not watcher_stop.is_set():
            if cancel.wait(0.15):
                if proc.poll() is None:
                    proc.terminate()
                return
    threading.Thread(target=watch_cancel, daemon=True).start()
    pending = b""
    batch: list[list[float]] = []
    count = 0
    try:
        while not cancel.is_set():
            data = proc.stdout.read(16384)
            if not data:
                break
            pending += data
            byte_count = (len(pending) // bytes_per_bin) * bytes_per_bin
            processed, pending = pending[:byte_count], pending[byte_count:]
            for start in range(0, byte_count, bytes_per_bin):
                pcm = struct.unpack_from(f"<{samples_per_bin*2}f", processed, start)
                left = min(4.0, max(abs(x) for x in pcm[::2]))
                right = min(4.0, max(abs(x) for x in pcm[1::2]))
                batch.append([round(left, 5), round(right, 5)])
                count += 1
                if len(batch) >= 160:
                    send(batch)
                    batch = []
        if cancel.is_set():
            proc.terminate()
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: proc.kill()
            return {"cancelled": True}
        proc.wait(timeout=15)
        if proc.returncode:
            raise RuntimeError(proc.stderr.read().decode("utf-8", "replace")[-900:])
        if batch:
            send(batch)
        if count == 0:
            raise RuntimeError('FFmpeg не смог декодировать аудиопоток: поток пустой')
        return {"samples": count, "intervalMs": interval_ms, "startMs": start_ms}
    finally:
        watcher_stop.set()
        try:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=3)
        finally:
            # Closing the child does not close the parent's pipe descriptors.
            # Without this, each waveform job leaks both FFmpeg pipe handles.
            if proc.stdout is not None:
                proc.stdout.close()
            if proc.stderr is not None:
                proc.stderr.close()
