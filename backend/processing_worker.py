"""Isolated neural separator worker. Stdout emits only JSON-line protocol messages.

The Electron-facing Python server must never import NumPy, Torch or the
separator package as part of a request thread. Heavy code lives here.
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
import traceback
from pathlib import Path

_write_lock = threading.Lock()


def report(kind: str, **data: object) -> None:
    with _write_lock:
        sys.stdout.write(json.dumps({"type": kind, **data}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def main() -> int:
    packet = json.loads(sys.stdin.readline())
    source = Path(packet["source"])
    target = Path(packet["target"])
    settings = packet["settings"]
    stream = int(packet["stream"])
    range_start_ms = packet.get("rangeStartMs")
    range_end_ms = packet.get("rangeEndMs")
    report("log", message="Дочерний процесс очистки запущен. PID: " + str(os.getpid()))
    report("progress", stage="Загрузка Python-библиотек", percent=1)

    finished = threading.Event()
    cancelled = threading.Event()
    if os.name != "nt":
        signal.signal(signal.SIGTERM, lambda *_args: cancelled.set())
    phase = {"name": "Импорт ядра", "since": time.monotonic()}

    def watchdog() -> None:
        # Output every 15 seconds even if native import stalls. The parent
        # monitors its own heartbeat separately, so this identifies a live
        # subprocess that is not making useful progress.
        while not finished.wait(15):
            seconds = round(time.monotonic() - phase["since"])
            report("log", message=f"Ожидание: {phase['name']} ({seconds} сек)")
    threading.Thread(target=watchdog, name="ACL-worker-watchdog", daemon=True).start()

    try:
        imported = time.monotonic()
        report("log", message="Импорт processor.py начат")
        from processor import process_one
        report("log", message=f"Импорт processor.py завершён за {time.monotonic()-imported:.1f} сек")
        phase.update(name="Подготовка аудио", since=time.monotonic())
        report("progress", stage="Подготовка аудио", percent=5)

        def on_log(message: str) -> None:
            report("log", message=str(message)[-1300:])

        def on_phase(name: str, percent: int) -> None:
            phase.update(name=name, since=time.monotonic())
            report("progress", stage=name, percent=int(percent))

        output = process_one(
            source, stream, target, settings, on_log, on_phase, cancelled,
            range_start_ms=range_start_ms, range_end_ms=range_end_ms,
        )
        output = Path(output)
        if not output.is_file() or output.stat().st_size < 44:
            raise RuntimeError("Движок завершился, но готового WAV нет")
        report("done", path=str(output), name=output.name)
        return 0
    except BaseException as exc:
        report("error", message=f"{type(exc).__name__}: {exc}",
               details="".join(traceback.format_exception(exc))[-4500:])
        return 1
    finally:
        finished.set()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BaseException as exc:
        if isinstance(exc, SystemExit):
            raise
        report("error", message=f"Ошибка запуска worker: {type(exc).__name__}: {exc}")
        raise SystemExit(1)
