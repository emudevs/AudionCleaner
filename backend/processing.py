"""Run the neural engine in an isolated process, keeping IPC responsive."""
from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable


def output_path(
    source: Path,
    requested: str | None = None,
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
) -> Path:
    if requested:
        base = Path(requested).expanduser().resolve()
    else:
        suffix = (
            f"_Clear_{range_start_ms:09d}-{range_end_ms:09d}"
            if range_start_ms is not None and range_end_ms is not None
            else "_Clear"
        )
        base = source.with_name(source.stem + suffix + ".wav")
    if base.suffix.lower() != ".wav":
        raise ValueError("Результат очистки должен быть WAV")
    if base == source:
        raise ValueError("Нельзя перезаписывать исходный файл")
    if not base.exists():
        return base
    index = 2
    while index <= 9999:
        candidate = base.with_name(f"{base.stem}_{index:03d}{base.suffix}")
        if not candidate.exists() and candidate != source:
            return candidate
        index += 1
    raise RuntimeError("Не удалось найти свободное имя файла")


def _stop_tree(proc: subprocess.Popen[str]) -> None:
    """Cooperatively stop children first, then force-kill after a grace period."""
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
        return
    try:
        # The worker traps SIGTERM, sets its cancellation event and
        # terminates the separator's separately started process group.
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=4)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    except ProcessLookupError:
        pass


def _execute_worker(
    source: Path,
    stream: int,
    target: Path,
    settings: dict,
    cancel: threading.Event,
    emit: Callable[[str, dict], None],
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
) -> Path:
    cmd = [sys.executable, "-u", "-m", "backend.processing_worker"]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    environment = dict(os.environ)
    environment.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8",
                       PYTHONUNBUFFERED="1")
    emit("process.progress", {"stage": "Запуск изолированного обработчика", "percent": 1})
    proc = subprocess.Popen(
        cmd, cwd=str(Path(__file__).resolve().parents[1]),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        creationflags=flags, start_new_session=(os.name != "nt"),
        env=environment,
    )
    messages: queue.Queue[str | None] = queue.Queue(maxsize=1024)
    def read_output() -> None:
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                # A full queue should not retain unlimited subprocess logs.
                try:
                    messages.put(line.rstrip("\r\n"), timeout=2)
                except queue.Full:
                    pass
        finally:
            try:
                messages.put(None, timeout=2)
            except queue.Full:
                pass
    reader = threading.Thread(target=read_output, daemon=True,
                              name="ACL-separator-output")
    reader.start()
    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps({
            "source": str(source), "target": str(target),
            "stream": stream, "settings": settings,
            "rangeStartMs": range_start_ms, "rangeEndMs": range_end_ms
        }, ensure_ascii=False) + "\n")
        proc.stdin.close()
        started = time.monotonic()
        last_output = started
        last_warning = started
        finished: Path | None = None
        error: str | None = None
        last_logs: list[str] = []
        while True:
            if cancel.is_set():
                emit("process.log", {"message": "Останавливаю обработчик и дочерние процессы…"})
                _stop_tree(proc)
                raise RuntimeError("Обработка отменена")
            try:
                item = messages.get(timeout=.4)
            except queue.Empty:
                if proc.poll() is not None and not reader.is_alive():
                    break
                now = time.monotonic()
                if now-last_output > 20 and now-last_warning > 15:
                    emit("process.log", {
                        "message": f"Worker PID {proc.pid} активен, но новых сообщений нет "
                                   f"{int(now-last_output)} сек. Возможно, зависла загрузка модели."
                    })
                    last_warning = now
                continue
            if item is None:
                break
            if not item:
                continue
            last_output = time.monotonic()
            try:
                message = json.loads(item)
            except (ValueError, TypeError):
                # Some AI libraries still print plain messages to stdout.
                emit("process.log", {"message": item[-700:]})
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "log":
                line = str(message.get("message", ""))[-1200:]
                if line:
                    emit("process.log", {"message": line})
                    last_logs.append(line)
                    last_logs = last_logs[-16:]
            elif kind == "progress":
                emit("process.progress", {
                    "stage": str(message.get("stage", "Обработка")),
                    "percent": max(0,min(100,int(message.get("percent", 0)))),
                })
            elif kind == "error":
                error = str(message.get("message", "Неизвестная ошибка worker"))
                diagnostic = str(message.get("details", ""))[-1800:]
                if diagnostic:
                    emit("process.log", {"message": diagnostic})
            elif kind == "done":
                finished = Path(str(message["path"]))
        try:
            status = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _stop_tree(proc)
            raise RuntimeError("Дочерний обработчик не завершился после закрытия stdout")
        if cancel.is_set():
            raise RuntimeError("Обработка отменена")
        if error or status != 0:
            tail = " | ".join(last_logs[-4:])
            raise RuntimeError(error or f"Worker завершился с кодом {status}: {tail}")
        if not finished or not finished.is_file() or finished.stat().st_size < 44:
            raise RuntimeError("Worker завершился без готового WAV-файла")
        return finished
    finally:
        if proc.poll() is None:
            _stop_tree(proc)
        if proc.stdout:
            proc.stdout.close()
        reader.join(timeout=1)


def process(
    source: Path,
    stream: int,
    requested: str | None,
    overrides: dict,
    cancel: threading.Event,
    emit: Callable[[str, dict], None],
    range_start_ms: int | None = None,
    range_end_ms: int | None = None,
) -> dict:
    from common import DEFAULT_SETTINGS, POST_PROFILES, load_settings
    if cancel.is_set():
        raise RuntimeError("Обработка отменена до запуска")
    settings = DEFAULT_SETTINGS | load_settings()
    settings.update({key: value for key, value in overrides.items() if key in DEFAULT_SETTINGS})
    profile = settings.get("post_profile", "custom")
    if profile in POST_PROFILES:
        settings.update(POST_PROFILES[profile])
        emit("process.log", {"message": f"Профиль постобработки: {profile}"})
    if (range_start_ms is None) != (range_end_ms is None):
        raise ValueError("Для обработки фрагмента нужны начало и конец")
    if range_start_ms is not None and range_end_ms is not None:
        range_start_ms, range_end_ms = int(range_start_ms), int(range_end_ms)
        if range_start_ms < 0 or range_end_ms <= range_start_ms:
            raise ValueError("Неверный временной диапазон обработки")
        if range_end_ms - range_start_ms < 100:
            raise ValueError("Минимальная длительность обработки — 100 мс")
        emit("process.log", {"message":
            f"Обрабатываю фрагмент: {range_start_ms/1000:.3f}–{range_end_ms/1000:.3f} сек"})
    target = output_path(source, requested, range_start_ms, range_end_ms)
    emit("process.log", {"message": "Выходной файл: " + str(target)})
    output = _execute_worker(
        source, stream, target, settings, cancel, emit, range_start_ms, range_end_ms
    )
    return {"path": str(output), "name": output.name}
