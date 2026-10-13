"""JSON-lines IPC server. Stdout is reserved for protocol messages."""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_write = threading.Lock()
_tasks: dict[str, threading.Event] = {}
_tasks_lock = threading.Lock()
_pending_cancels: set[str] = set()
_processing_lock = threading.Lock()


def emit(message: dict) -> None:
    with _write:
        print(json.dumps(message, ensure_ascii=False), flush=True)


def dispatch(request_id: str, method: str, args: dict):
    from common import DEFAULT_SETTINGS, POST_PROFILES, load_settings, save_settings
    from backend.media import inspect, thumbnail, source_path
    if method == "system.hello":
        return {"platform": sys.platform, "protocol": 3, "python": sys.version.split()[0],
                "features": ["audio.effects", "audio.export", "media.waveform.detail"]}
    if method == "settings.get":
        return load_settings()
    if method == "settings.save":
        state = load_settings()
        state.update({key: value for key, value in args.get("settings", {}).items()
                      if key in DEFAULT_SETTINGS})
        if state.get('post_profile') in POST_PROFILES:
            state.update(POST_PROFILES[state['post_profile']])
        save_settings(state)
        return state
    if method == "task.cancel":
        with _tasks_lock:
            task = _tasks.get(str(args["requestId"]))
            if task:
                task.set()
            else:
                _pending_cancels.add(str(args["requestId"]))
                if len(_pending_cancels) > 128:
                    _pending_cancels.clear()
        return {"cancelRequested": True}
    if method == "settings.profiles":
        return POST_PROFILES
    if method == "process.preflight":
        from backend.preflight import verify_runtime
        return verify_runtime(load_settings() | {
            k: v for k, v in (args.get("settings") or {}).items()
            if k in DEFAULT_SETTINGS
        })
    if method == "media.inspect":
        return inspect(args["path"])
    if method == "media.thumbnail":
        return thumbnail(args["path"], int(args.get("atMs", 0)))
    if method not in ("media.waveform", "media.waveform.detail", "process.start", "audio.export", "audio.effects"):
        raise ValueError(f"Неизвестный метод: {method}")
    source = source_path(args["path"])
    cancel = threading.Event()
    with _tasks_lock:
        _tasks[request_id] = cancel
        if request_id in _pending_cancels:
            cancel.set()
            _pending_cancels.discard(request_id)
    def event(name: str, data: dict) -> None:
        emit({"type": "event", "event": name, "requestId": request_id, **data})
    try:
        if method in ("media.waveform", "media.waveform.detail"):
            from backend.waveform import decode_peaks
            if method == "media.waveform.detail":
                start_ms = int(args.get("startMs", 0))
                duration_ms = int(args.get("durationMs", 1000))
                interval_ms = int(args.get("intervalMs", 5))
                # Return only a viewport-sized set of peaks, not the entire video.
                if duration_ms / max(1, interval_ms) > 5000:
                    raise ValueError("Запрошено слишком много пиков для видимой области")
                values: list[list[float]] = []
                meta = decode_peaks(source, int(args["stream"]),
                                    lambda chunk: values.extend(chunk), cancel,
                                    start_ms, duration_ms, interval_ms)
                if cancel.is_set():
                    return {"cancelled": True, "peaks": []}
                return {**meta, "peaks": values}
            # Keep progressive chunks for a responsive first paint, but return
            # a complete authoritative overview too. Electron's event messages
            # and invoke replies use different IPC paths and may be delivered
            # out of order; otherwise only the first chunk can remain visible.
            duration_hint = max(0, int(args.get("durationMs", 0)))
            interval_ms = 100 if duration_hint > 30 * 60 * 1000 else 20
            overview: list[list[float]] = []
            def overview_chunk(values: list[list[float]]) -> None:
                overview.extend(values)
                event("waveform.chunk", {"peaks": values})
            meta = decode_peaks(source, int(args["stream"]),
                                overview_chunk, cancel, interval_ms=interval_ms)
            if meta.get("cancelled") or cancel.is_set():
                return {"cancelled": True, "samples": 0,
                        "intervalMs": interval_ms, "peaks": []}
            return {**meta, "peaks": overview}
        if method == "audio.effects":
            from backend.audio_effects import apply_lane_effects
            return apply_lane_effects(args,cancel)
        if method == "audio.export":
            from backend.audio_export import export_audio
            return export_audio(args, cancel, lambda stage:event(
                "export.progress", {"stage":stage}))
        if not _processing_lock.acquire(blocking=False):
            raise RuntimeError("Другая обработка уже выполняется. Дождись её завершения.")
        start = threading.Event()
        def heartbeat():
            import time
            begun = time.monotonic()
            while not start.wait(1.):
                event("process.heartbeat", {
                    "elapsed": round(time.monotonic() - begun),
                    "cancelling": cancel.is_set(),
                })
        threading.Thread(target=heartbeat, daemon=True).start()
        try:
            event("process.progress", {"stage": "Запуск обработчика", "percent": 0})
            event("process.log", {"message": "Python получил задачу. Подготовка параметров и зависимостей…"})
            if cancel.is_set():
                raise RuntimeError("Операция отменена до запуска.")
            from backend.preflight import verify_runtime
            from common import DEFAULT_SETTINGS, load_settings
            settings = load_settings() | {
                k: v for k, v in (args.get("settings") or {}).items()
                if k in DEFAULT_SETTINGS
            }
            preflight = verify_runtime(settings)
            for warning in preflight["warnings"]:
                event("process.log", {"message": "Предупреждение: " + warning})
            if not preflight["ok"]:
                raise RuntimeError("Не выполнены условия запуска:\n" +
                                   "\n".join(preflight["errors"]))
            event("process.log", {"message": "Зависимости и FFmpeg проверены. Загрузка ядра…"})
            from backend.processing import process
            return process(
                source, int(args["stream"]), args.get("target"),
                args.get("settings", {}), cancel, event,
                args.get("rangeStartMs"), args.get("rangeEndMs"),
            )
        finally:
            start.set()
            _processing_lock.release()
    finally:
        with _tasks_lock:
            _tasks.pop(request_id, None)


def run_request(packet: dict) -> None:
    request_id = str(packet.get("id", ""))
    try:
        result = dispatch(request_id, str(packet["method"]), packet.get("params") or {})
        emit({"type": "result", "id": request_id, "ok": True, "result": result})
    except Exception as exc:
        emit({"type": "result", "id": request_id, "ok": False,
              "error": f"{type(exc).__name__}: {exc}"})


def main() -> None:
    emit({"type": "event", "event": "backend.ready", "protocol": 2})
    for line in sys.stdin:
        try:
            packet = json.loads(line)
            threading.Thread(target=run_request, args=(packet,), daemon=True).start()
        except Exception as exc:
            emit({"type": "event", "event": "backend.error", "message": str(exc)})


if __name__ == "__main__":
    main()
