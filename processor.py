from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from common import APP_ROOT, ffmpeg_path, ffprobe_path


AUDIO_EXTS = {
    ".wav", ".flac", ".mp3", ".aac", ".m4a", ".ogg", ".opus",
    ".wma", ".aiff", ".aif", ".alac", ".ac3", ".eac3", ".dts",
}

VIDEO_EXTS = {
    ".mkv", ".mp4", ".mov", ".avi", ".webm", ".m4v", ".ts", ".m2ts",
    ".mts", ".wmv", ".flv", ".mpg", ".mpeg",
}


class Cancelled(Exception):
    pass


@dataclass
class AudioStream:
    index: int
    codec: str
    channels: int | None
    channel_layout: str
    sample_rate: int | None
    language: str
    title: str
    bitrate: int | None

    def label(self) -> str:
        bits = [f"#{self.index}", self.codec.upper()]
        if self.channels:
            bits.append(f"{self.channels} ch")
        if self.sample_rate:
            bits.append(f"{self.sample_rate} Hz")
        if self.language:
            bits.append(self.language)
        if self.title:
            bits.append(self.title)
        return " · ".join(bits)


def _run(cmd, log: Callable[[str], None], cancel_event: threading.Event | None = None):
    log("> " + " ".join(map(str, cmd)))
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.Popen(
        list(map(str, cmd)),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )

    lines = []
    assert proc.stdout is not None
    while True:
        if cancel_event and cancel_event.is_set():
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()
            raise Cancelled("Операция отменена.")

        line = proc.stdout.readline()
        if line:
            line = line.rstrip()
            lines.append(line)
            log(line)

        if proc.poll() is not None:
            rest = proc.stdout.read()
            if rest:
                for line in rest.splitlines():
                    lines.append(line)
                    log(line)
            break

    if proc.returncode != 0:
        raise RuntimeError(
            f"Команда завершилась с кодом {proc.returncode}.\n"
            + "\n".join(lines[-20:])
        )

    return "\n".join(lines)


def probe(path: Path) -> dict:
    cmd = [
        ffprobe_path(),
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
        creationflags=creationflags,
    )
    return json.loads(result.stdout)


def inspect_media(path: Path) -> tuple[bool, list[AudioStream]]:
    info = probe(path)
    has_video = any(s.get("codec_type") == "video" for s in info.get("streams", []))
    streams: list[AudioStream] = []

    for s in info.get("streams", []):
        if s.get("codec_type") != "audio":
            continue
        tags = s.get("tags") or {}
        try:
            sample_rate = int(s.get("sample_rate")) if s.get("sample_rate") else None
        except Exception:
            sample_rate = None
        try:
            bitrate = int(s.get("bit_rate")) if s.get("bit_rate") else None
        except Exception:
            bitrate = None

        streams.append(
            AudioStream(
                index=int(s["index"]),
                codec=s.get("codec_name") or "unknown",
                channels=s.get("channels"),
                channel_layout=s.get("channel_layout") or "",
                sample_rate=sample_rate,
                language=(tags.get("language") or "").strip(),
                title=(tags.get("title") or "").strip(),
                bitrate=bitrate,
            )
        )

    return has_video, streams


def dbfs(value: float) -> float:
    if value <= 1e-12:
        return -120.0
    return 20.0 * math.log10(value)


def spectral_flatness(samples: np.ndarray) -> float:
    samples = np.asarray(samples, dtype=np.float64)
    if samples.size < 1024:
        return 0.0
    window = np.hanning(samples.size)
    spectrum = np.abs(np.fft.rfft(samples * window))
    spectrum = np.maximum(spectrum, 1e-12)
    geometric = np.exp(np.mean(np.log(spectrum)))
    arithmetic = np.mean(spectrum)
    return float(geometric / arithmetic) if arithmetic > 1e-12 else 0.0


def analyse_noise(path: Path, settings: dict, log: Callable[[str], None]) -> tuple[bool, float, float]:
    with sf.SoundFile(str(path)) as audio:
        sr = audio.samplerate
        total = len(audio)
        frames = max(1024, int(sr * 0.5))
        max_pos = max(0, total - frames)
        positions = np.linspace(0, max_pos, 80, dtype=np.int64) if max_pos else np.array([0])
        measures = []

        for pos in positions:
            audio.seek(int(pos))
            data = audio.read(frames, dtype="float32", always_2d=True)
            if data.size == 0:
                continue
            mono = np.mean(data, axis=1)
            rms = float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))
            level = dbfs(rms)
            if level < -85:
                continue
            measures.append((level, spectral_flatness(mono)))

    if not measures:
        return False, -120.0, 0.0

    measures.sort(key=lambda x: x[0])
    count = max(3, int(len(measures) * 0.15))
    quiet = measures[:count]
    floor = float(np.median([x[0] for x in quiet]))
    flatness = float(np.median([x[1] for x in quiet]))

    detected = (
        floor > float(settings["noise_floor_threshold_db"])
        and flatness > float(settings["noise_flatness_threshold"])
    )
    log(f"Noise floor: {floor:.1f} dBFS; flatness: {flatness:.3f}; detected: {detected}")
    return detected, floor, flatness


def prepare_audio(
    source: Path,
    stream_index: int,
    target: Path,
    sample_rate: int,
    log,
    cancel_event,
):
    cmd = [
        ffmpeg_path(), "-hide_banner", "-y",
        "-i", str(source),
        "-map", f"0:{stream_index}",
        "-vn", "-sn", "-dn",
        "-ac", "2",
        "-ar", str(sample_rate),
        "-c:a", "pcm_f32le",
        str(target),
    ]
    _run(cmd, log, cancel_event)


def separator_exe() -> Path:
    exe = Path(os.sys.executable).parent / "audio-separator.exe"
    if exe.exists():
        return exe
    exe = Path(os.sys.executable).parent / "audio-separator"
    if exe.exists():
        return exe
    raise FileNotFoundError("audio-separator executable не найден в .venv.")


def run_separator(
    prepared: Path,
    out_dir: Path,
    settings: dict,
    log,
    cancel_event,
) -> Path:
    model_dir = Path(settings.get("model_cache_dir") or (APP_ROOT / "models"))
    model_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        separator_exe(),
        str(prepared),
        "--ensemble_preset", settings["separator_preset"],
        "--single_stem", "Instrumental",
        "--output_format", "WAV",
        "--sample_rate", str(int(settings["separator_sample_rate"])),
        "--output_dir", str(out_dir),
        "--model_file_dir", str(model_dir),
        "--normalization", str(float(settings["separator_normalization"])),
        "--amplification", str(float(settings["separator_amplification"])),
        "--custom_output_names", json.dumps({"Instrumental": "separated_raw"}),
        "--log_level", "INFO",
    ]

    if settings.get("separator_invert_spect"):
        cmd.append("--invert_spect")
    if settings.get("separator_use_soundfile"):
        cmd.append("--use_soundfile")

    precision = settings.get("precision", "fp32")
    if precision == "autocast":
        cmd.append("--use_autocast")
    elif precision == "native_fp16":
        cmd.append("--use_native_fp16")

    if settings.get("torch_compile"):
        cmd.append("--use_torch_compile")

    _run(cmd, log, cancel_event)

    candidates = [
        out_dir / "separated_raw.wav",
        out_dir / "separated_raw.WAV",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate

    wavs = sorted(out_dir.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
    if wavs:
        return wavs[0]

    raise RuntimeError("audio-separator завершился, но выходной WAV не найден.")


def recover_high_end(
    clean: Path,
    original: Path,
    target: Path,
    settings: dict,
    log,
    cancel_event,
):
    cutoff = float(settings["high_end_cutoff_hz"])
    gain = float(settings["high_end_gain_db"])
    filt = (
        f"[1:a]highpass=f={cutoff},volume={gain}dB[hf];"
        "[0:a][hf]amix=inputs=2:normalize=0:duration=first[m]"
    )
    cmd = [
        ffmpeg_path(), "-hide_banner", "-y",
        "-i", str(clean),
        "-i", str(original),
        "-filter_complex", filt,
        "-map", "[m]",
        "-c:a", "pcm_f32le",
        str(target),
    ]
    _run(cmd, log, cancel_event)


def base_filters(settings: dict, source_for_noise: Path, log) -> list[str]:
    filters = []

    if settings.get("highpass_enabled"):
        filters.append(f"highpass=f={float(settings['highpass_hz'])}")

    denoise_mode = settings.get("denoise_mode", "off")
    denoise = denoise_mode == "always"
    if denoise_mode == "auto":
        denoise, _, _ = analyse_noise(source_for_noise, settings, log)

    if denoise:
        nr = max(0.01, float(settings["denoise_reduction_db"]))
        filters.append(
            "afftdn="
            f"nr={nr}:nf=-70:tn=1:ad=0.8:gs=8"
        )

    if settings.get("declick_enabled"):
        filters.append("adeclick")

    if settings.get("compressor_enabled"):
        filters.append(
            "acompressor="
            f"threshold={float(settings['compressor_threshold_db'])}dB:"
            f"ratio={float(settings['compressor_ratio'])}:"
            f"attack={float(settings['compressor_attack_ms'])}:"
            f"release={float(settings['compressor_release_ms'])}"
        )

    if settings.get("limiter_enabled") and not settings.get("loudnorm_enabled"):
        filters.append(f"alimiter=limit={float(settings['limiter_limit'])}")

    return filters


def loudnorm_measure(source: Path, filters: list[str], settings: dict, log, cancel_event) -> dict:
    target = (
        "loudnorm="
        f"I={float(settings['target_lufs'])}:"
        f"LRA={float(settings['target_lra'])}:"
        f"TP={float(settings['true_peak_db'])}:"
        "print_format=json"
    )
    chain = ",".join(filters + [target])

    cmd = [
        ffmpeg_path(), "-hide_banner", "-nostats",
        "-i", str(source),
        "-af", chain,
        "-f", "null", "-",
    ]
    output = _run(cmd, log, cancel_event)

    matches = re.findall(r"\{\s*\"input_i\".*?\}", output, re.DOTALL)
    if not matches:
        raise RuntimeError("Не удалось получить статистику loudnorm.")
    return json.loads(matches[-1])


def output_codec(bit_depth: str) -> str:
    return {
        "16-bit PCM": "pcm_s16le",
        "24-bit PCM": "pcm_s24le",
        "32-bit float": "pcm_f32le",
    }.get(bit_depth, "pcm_s24le")


def master_audio(
    source: Path,
    target: Path,
    settings: dict,
    log,
    cancel_event,
):
    filters = base_filters(settings, source, log)

    if settings.get("loudnorm_enabled"):
        log("Первый проход EBU R128...")
        stats = loudnorm_measure(source, filters, settings, log, cancel_event)
        log(
            f"Громкость до: {stats.get('input_i')} LUFS; "
            f"True Peak: {stats.get('input_tp')} dBTP; "
            f"LRA: {stats.get('input_lra')} LU"
        )

        ln = (
            "loudnorm="
            f"I={float(settings['target_lufs'])}:"
            f"LRA={float(settings['target_lra'])}:"
            f"TP={float(settings['true_peak_db'])}:"
            f"measured_I={stats['input_i']}:"
            f"measured_LRA={stats['input_lra']}:"
            f"measured_TP={stats['input_tp']}:"
            f"measured_thresh={stats['input_thresh']}:"
            f"offset={stats['target_offset']}:"
            "linear=true:print_format=summary"
        )
        filters.append(ln)

    out_sr = int(settings["output_sample_rate"])
    filters.append(f"aresample={out_sr}")

    cmd = [
        ffmpeg_path(), "-hide_banner", "-y",
        "-i", str(source),
        "-vn",
    ]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += [
        "-ac", "2",
        "-ar", str(out_sr),
        "-c:a", output_codec(settings["output_bit_depth"]),
        str(target),
    ]
    _run(cmd, log, cancel_event)


def process_one(
    source: Path,
    stream_index: int,
    output: Path,
    settings: dict,
    log: Callable[[str], None],
    phase: Callable[[str, int], None],
    cancel_event: threading.Event,
):
    source = Path(source)
    output = Path(output)

    with tempfile.TemporaryDirectory(prefix="AnimeAudioCleaner_") as td:
        tmp = Path(td)
        prepared = tmp / "prepared_input.wav"
        separated_dir = tmp / "separated"
        separated_dir.mkdir()
        recovered = tmp / "recovered.wav"
        mastered = tmp / "mastered.wav"

        phase("Подготовка аудио", 10)
        prepare_audio(
            source,
            stream_index,
            prepared,
            int(settings["separator_sample_rate"]),
            log,
            cancel_event,
        )

        if cancel_event.is_set():
            raise Cancelled()

        phase("Удаление голосов", 30)
        raw_clear = run_separator(prepared, separated_dir, settings, log, cancel_event)

        working = raw_clear

        if settings.get("high_end_recovery"):
            phase("Восстановление верхнего спектра", 72)
            log(
                "ВНИМАНИЕ: high-end recovery подмешивает тихий ВЧ-слой оригинала "
                "и может слегка вернуть сибилянты/голос."
            )
            recover_high_end(raw_clear, prepared, recovered, settings, log, cancel_event)
            working = recovered

        phase("Финальная обработка", 82)
        master_audio(working, mastered, settings, log, cancel_event)

        if cancel_event.is_set():
            raise Cancelled()

        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(mastered, output)

        if settings.get("keep_prepared_audio"):
            shutil.copy2(prepared, output.with_name(output.stem + "_Prepared.wav"))
        if settings.get("keep_raw_separated"):
            shutil.copy2(raw_clear, output.with_name(output.stem + "_Raw.wav"))

        phase("Готово", 100)
        return output
