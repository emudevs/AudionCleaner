# ACL v2 architecture

```text
desktop/electron/main.cjs   (desktop host, file dialogs, Python child process)
desktop/electron/preload.cjs (allowlisted IPC bridge)
desktop/src/               (React UI, CSS, timeline, Web Audio engine, future)
backend/service.py         (line-delimited JSON RPC)
processor.py               (existing local separation and mastering)
separator_runner.py        (model runner)
common.py                  (settings and tool resolution)
```

## Non-negotiable requirements

1. Windows, macOS, Linux must share the same UI and feature set. Maintain a CI build matrix across OSes, architectures and available accelerators.
2. Media files and model cache remain local; no cloud uploading. Do not put platform-specific filesystem paths in the renderer.
3. FFmpeg probes, thumbnail extraction, audio-waveform generation and all processing are background jobs with cancellation. Never block Electron's main thread.
4. Each processing run produces an independent file and independent timeline track. Removing a track must not silently delete the WAV file.
5. A real PCM-backed Web Audio mixer must implement per-channel level, mute, solo, pan and gain. Do not emulate sound meters.
6. All settings must be sourced from `common.DEFAULT_SETTINGS`; changes are only considered implemented when the backend consumes them.
7. Electron uses context isolation, no node integration in renderer, no unrestricted shell IPC.
8. Paths/resources resolved via `app.getPath('userData')`, `process.resourcesPath` and OS-native tooling. No assumptions that `E:\\` exists.
9. Tests: inspect and load on all 3 OSes; decode MKV/MP4/HEVC, verify sync after seeking, select audio streams, test output processing; validate installer in clean VM.
10. Do not call a partially functional shell a released product.

## Migration phases

- 0. Preserve user data, isolate legacy code, establish clean project layout. (Started)
- 1. Platform Python runtime packaging and IPC, configurable FFmpeg/ffprobe. (Partial)
- 2. Pixel-matched controls using SVG from `Icons/`, screen references from `screens/`. (Partial)
- 3. Real media decoding + audio editor and mixing.
- 4. Process/export workflow, robust cancellation, track persistence.
- 5. OS-specific signing, packaged runtime and clean-machine QA.
