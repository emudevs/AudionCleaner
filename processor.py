from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
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


def _run(cmd, log: Callable[[str], None], cancel_event: threading.Event | None = None, *, env=None):
    """Stream subprocess logs while cancellation can interrupt a blocked readline.

    On Windows the entire process tree is stopped (model runner may have
    spawned children); POSIX subprocesses use their own process group.
    """
    import signal
    log("> " + " ".join(map(str, cmd)))
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    environment = dict(os.environ if env is None else env)
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    environment["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        list(map(str, cmd)),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
        creationflags=creationflags,
        start_new_session=(os.name != "nt"),
        env=environment,
        bufsize=1,
    )

    stopped = threading.Event()
    def stop_process():
        if proc.poll() is not None:
            return
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=8, creationflags=subprocess.CREATE_NO_WINDOW,
                )
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except OSError:
                proc.terminate()

    def cancel_watcher():
        if cancel_event is None:
            return
        while not stopped.is_set():
            if cancel_event.wait(.15):
                stop_process()
                return
    watcher = threading.Thread(target=cancel_watcher, daemon=True)
    watcher.start()

    lines = []
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            clean_line = line.rstrip()
            if clean_line:
                lines.append(clean_line)
                if len(lines) > 200:
                    lines = lines[-200:]
                log(clean_line)
            if cancel_event and cancel_event.is_set():
                break
        if cancel_event and cancel_event.is_set():
            stop_process()
            raise Cancelled("Операция отменена.")
        code = proc.wait()
        if code:
            marker = "ACL_DOWNLOAD_FAILED:"
            download_error = next(
                (line.split(marker, 1)[1].strip()
                 for line in reversed(lines) if marker in line), None
            )
            if download_error:
                raise RuntimeError(download_error)
            raise RuntimeError(
                f"Команда завершилась с кодом {code}.\\n" + "\\n".join(lines[-20:])
            )
        return "\\n".join(lines)
    finally:
        stopped.set()
        if proc.poll() is None:
            stop_process()
        proc.stdout.close()

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
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
):
    cmd = [
        ffmpeg_path(), "-nostdin", "-hide_banner", "-y",
        "-i", str(source),
    ]
    if range_start_ms is not None and range_end_ms is not None:
        # Output-side trim for sample-accurate cuts, independent of video keyframes.
        cmd += ["-ss", f"{range_start_ms/1000:.3f}",
                "-t", f"{(range_end_ms-range_start_ms)/1000:.3f}"]
    cmd += [
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


def preset_model_names(preset: str) -> list[str]:
    """Read the actual model list shipped with the installed audio-separator."""
    try:
        from importlib import resources
        preset_file = resources.files("audio_separator").joinpath("ensemble_presets.json")
        with preset_file.open("r", encoding="utf-8") as handle:
            models = json.load(handle).get("presets", {}).get(preset, {}).get("models", [])
        return [name for name in models if isinstance(name, str)]
    except (ImportError, OSError, ValueError, TypeError, KeyError):
        return []


def resolve_model_cache_dir(settings: dict, log) -> Path:
    """Prefer an existing complete preset cache over an empty configured path.

    Preserve the user's configured cache whenever it already has the models.
    Do not modify settings.json or copy multi-gigabyte model files.
    """
    configured = Path(settings.get("model_cache_dir") or (APP_ROOT / "models")).expanduser()
    bundled = APP_ROOT / "models"
    required = preset_model_names(settings.get("separator_preset", "instrumental_full"))

    def available(folder: Path) -> int:
        return sum(
            (folder / filename).is_file()
            and (folder / filename).stat().st_size > 1024 * 1024
            for filename in required
        )

    selected = configured
    if required and configured.resolve() != bundled.resolve():
        configured_count = available(configured)
        bundled_count = available(bundled)
        if bundled_count > configured_count:
            selected = bundled
            log(
                f"Кеш {configured}: {configured_count}/{len(required)} моделей; "
                f"кеш проекта {bundled}: {bundled_count}/{len(required)}. "
                "Использую более полный локальный кеш."
            )

    selected.mkdir(parents=True, exist_ok=True)
    log(f"Папка моделей: {selected}")
    if required:
        log(f"Модели пресета: {available(selected)}/{len(required)} уже в кеше.")
    return selected


def run_separator(
    prepared: Path,
    out_dir: Path,
    settings: dict,
    log,
    cancel_event,
) -> Path:
    model_dir = resolve_model_cache_dir(settings, log)

    cmd = [
        os.sys.executable,
        str(APP_ROOT / "separator_runner.py"),
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

    environment = os.environ.copy()
    environment["AUDIO_SEPARATOR_MODEL_DIR"] = str(model_dir)
    try:
        _run(cmd, log, cancel_event, env=environment)
    except RuntimeError as exc:
        details = str(exc)
        if "Не удалось загрузить файл модели" in details:
            raise
        if any(token in details for token in (
            "ConnectionResetError", "Connection aborted", "ReadTimeout",
            "ConnectTimeout", "RemoteDisconnected", "Max retries exceeded",
        )):
            raise RuntimeError(
                "Не удалось загрузить модель: сетевое соединение было разорвано. "
                f"Проверьте доступ к GitHub или используйте уже скачанные модели в {model_dir}. "
                "После восстановления соединения повторите обработку."
            ) from exc
        raise

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

    # FFmpeg usually prints one JSON object at the end of the log, but
    # different builds may reorder fields or include additional diagnostics.
    required = ("input_i", "input_lra", "input_tp", "input_thresh", "target_offset")
    stats = None
    for found in re.finditer(r"\\{[^{}]*\\}", output, re.DOTALL):
        try:
            candidate = json.loads(found.group())
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and all(k in candidate for k in required):
            stats = candidate

    if stats is None:
        log("Предупреждение: FFmpeg не выдал полную статистику loudnorm. "
            "Перехожу на однопроходную нормализацию.")
        if output.strip():
            log("Диагностика loudnorm: " + output.strip()[-1500:])
        return None

    # Silence and very short segments can produce -inf/inf or nan LUFS.
    # These cannot be used as measured_... in a second pass.
    try:
        finite = all(math.isfinite(float(stats[key])) for key in required)
    except (ValueError, TypeError, OverflowError):
        finite = False
    if not finite:
        log("Предупреждение: измеренная громкость не определена "
            "(тишина или слишком короткий фрагмент). "
            "Перехожу на однопроходную нормализацию.")
        return None
    return stats

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
        ln = (
            "loudnorm="
            f"I={float(settings['target_lufs'])}:"
            f"LRA={float(settings['target_lra'])}:"
            f"TP={float(settings['true_peak_db'])}"
        )
        if stats is not None:
            log(
                f"Громкость до: {stats['input_i']} LUFS; "
                f"True Peak: {stats['input_tp']} dBTP; "
                f"LRA: {stats['input_lra']} LU"
            )
            ln += (
                f":measured_I={stats['input_i']}"
                f":measured_LRA={stats['input_lra']}"
                f":measured_TP={stats['input_tp']}"
                f":measured_thresh={stats['input_thresh']}"
                f":offset={stats['target_offset']}"
                ":linear=true"
            )
        else:
            # Keep the output audible and avoid a failed render when a valid
            # measurement is impossible, e.g. a silent source.
            log("Второй проход недоступен; применяю обычный loudnorm.")
        filters.append(ln + ":print_format=summary")

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
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
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
            range_start_ms=range_start_ms,
            range_end_ms=range_end_ms,
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
        # A failed/cancelled file copy must never expose a partial WAV as a
        # completed audio track. Stage on the same volume, then atomic rename.
        staged = output.with_name(f".{output.name}.{uuid.uuid4().hex}.part")
        try:
            with mastered.open("rb") as source_handle, staged.open("wb") as output_handle:
                while True:
                    if cancel_event.is_set():
                        raise Cancelled("Отменено во время сохранения WAV.")
                    block = source_handle.read(1024 * 1024)
                    if not block:
                        break
                    output_handle.write(block)
            if cancel_event.is_set():
                raise Cancelled("Отменено перед сохранением WAV.")
            os.replace(staged, output)
        finally:
            staged.unlink(missing_ok=True)

        if settings.get("keep_prepared_audio"):
            shutil.copy2(prepared, output.with_name(output.stem + "_Prepared.wav"))
        if settings.get("keep_raw_separated"):
            shutil.copy2(raw_clear, output.with_name(output.stem + "_Raw.wav"))

        phase("Готово", 100)
        return output
