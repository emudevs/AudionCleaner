# Anime Audio Cleaner

A Windows desktop app for reducing dialogue and vocals in anime, film, and other media while preserving background music and sound effects. It combines AI audio separation with configurable cleanup and exports a stereo WAV file for editing.

The interface uses a compact, Premiere Pro-inspired panel layout. This is a standalone application; Adobe Premiere Pro is not required. The current GUI labels are in Russian.

![Anime Audio Cleaner interface with effect controls, output properties, and processing log](GUI.png)

## Features

- Import video or audio using drag and drop or the file picker.
- Choose an audio track when a video contains multiple tracks.
- Separate voices using `audio-separator` and RoFormer ensemble presets.
- Adjust high-pass filtering, denoising, de-clicking, loudness normalization, compression, and limiting.
- Export WAV at a configurable sample rate in 16-bit PCM, 24-bit PCM, or 32-bit float.
- Optionally keep the prepared input and raw AI separation output.
- Follow processing in a persistent log panel and cancel the current job.
- Reuse downloaded models and saved settings between sessions.

Processing runs locally, one file at a time. Setup and initial model downloads require an internet connection.

## Requirements

- **Windows** with **Python 3.12 x64** installed. Enable **Add Python to PATH** during Python installation.
- An internet connection for dependency installation and model downloads.
- Enough free disk space for Python dependencies, model weights, temporary audio, and output files. Long videos can require substantial temporary storage.
- An NVIDIA GPU is optional. The installer selects the GPU dependency path when it detects NVIDIA through `nvidia-smi`; otherwise, it installs the CPU path. The GPU path installs CUDA 13.0 PyTorch wheels and requires a compatible NVIDIA driver.

FFmpeg and FFprobe are detected from `PATH` or installed locally by the bootstrap script.

## Quick start

1. Extract the project into a writable folder, such as `D:\Tools\AnimeAudioCleaner`.
2. Run **`start.bat`**.
3. Allow the first-time setup to finish. It creates `.venv`, installs PyTorch, `audio-separator==0.47.0`, ONNX Runtime, and supporting packages, then prepares FFmpeg.
4. Review your processing and output settings. **Auto-start after import is enabled by default**; disable it if you want to review each file before processing.
5. Click **Import** (`Импорт…`) or drag a media file onto the source panel.
6. If prompted, select the audio track to process.
7. With auto-start disabled, click **Process** (`Обработать`).

The first run of a separation preset may download additional model weights into `models/`. Later runs reuse the cached files.

By default, the result is saved beside the source:

```text
Episode_01.mkv  ->  Episode_01_Clear.wav
```

Use **Browse** (`Обзор…`) in the output panel to choose a different destination. The app asks before overwriting an existing output file.

## Interface guide

| Panel | Purpose |
| --- | --- |
| Source / Import | Load a media file and view the selected audio track. |
| Voice separation | Choose the AI preset, numerical precision, and Torch compile option. |
| Post-processing | Configure cleanup, high-frequency blending, loudness, and dynamics. |
| System | Adjust separator settings, select the model cache folder, and access diagnostics or repair. |
| Properties / Output | Choose the output path, WAV format, auto-start behavior, and intermediate files to keep. |
| Processing log | Read progress messages and error details. |

Parameter groups can be collapsed. Panel dividers can be dragged to adjust the workspace, and long parameter lists can be scrolled.

## Choosing a separation preset

Start with **`instrumental_full`** for anime and film. It prioritizes retaining the original background sound. If too much dialogue remains, try `instrumental_balanced`, then `instrumental_clean`.

| Preset | Intended use |
| --- | --- |
| `instrumental_full` | Preserve as much music and ambience as possible. Default starting point. |
| `instrumental_balanced` | Balance background preservation and voice removal. |
| `instrumental_clean` | More aggressive voice removal, with a greater risk of artifacts. |
| `instrumental_low_resource` | Reduce resource requirements, with a quality tradeoff. |
| `karaoke` | Target lead singing vocals; generally less suited to dialogue. |
| `vocal_balanced`, `vocal_clean`, `vocal_full`, `vocal_rvc` | Alternative vocal-oriented ensembles. The app uses their instrumental output. |

Separation quality depends on the source. Voices may remain, and music or effects that overlap with voices may be weakened or distorted.

## Post-processing profiles

| Profile | Behavior |
| --- | --- |
| `off` | Disable post-processing effects; output format conversion still applies. |
| `safe` | Apply a 20 Hz high-pass filter, conservative automatic denoising, and EBU R128 loudness normalization. Compression and high-frequency blending are off. |
| `restoration` | Apply cleanup and loudness normalization, then include a quiet high-frequency contribution from the original audio. This can also reintroduce sibilants or voice remnants. |
| `custom` | Adjust individual processing parameters manually. |

High-frequency recovery blends filtered original audio into the separated result. It does not reconstruct information removed by the AI model.

### Default output settings

| Setting | Default |
| --- | --- |
| Separation preset | `instrumental_full` |
| Precision | `fp32` |
| Post-processing profile | `safe` |
| Output sample rate | 48,000 Hz |
| Output bit depth | 24-bit PCM |
| Loudness target | -18 LUFS |
| Loudness range target | 20 LU |
| True peak target | -1.5 dBTP |

`autocast` and `native_fp16` provide alternative precision modes. Their speed, memory use, and output quality depend on the hardware and model. Torch compile can help repeated runs but adds startup overhead.

## Files and storage

| Path | Purpose |
| --- | --- |
| `start.bat` | Set up dependencies if needed, then launch the app. |
| `repair.bat` | Recreate the Python environment and reinstall dependencies. |
| `app.py` | Tkinter GUI and job controls. |
| `processor.py` | Media inspection, separation, and post-processing pipeline. |
| `bootstrap.py` | Environment setup and dependency installation. |
| `common.py` | Defaults, profiles, and configuration helpers. |
| `settings.json` | Saved processing preferences and paths. |
| `runtime.json` | Detected environment information and tool paths. |
| `models/` | Default model cache; configurable in the GUI. |
| `tools/` | Locally downloaded tools, when needed. |
| `.venv/` | Application Python environment. |

Temporary processing files use the system temporary directory. Optional intermediate exports are saved beside the result as `*_Clear_Prepared.wav` and `*_Clear_Raw.wav` when the default output naming is used.

## Troubleshooting

### Python is not found

Install Python 3.12 x64 with **Add Python to PATH** enabled, then run `start.bat` again. The launcher first tries Python 3.12 through the `py` launcher, then falls back to `python` on `PATH`.

### Setup fails or dependencies stop working

Read the setup console output for the failing package or download. Run **`repair.bat`** to rebuild `.venv` and reinstall dependencies. Repair requires an internet connection; the model cache is kept separately.

### GPU processing is unavailable

Open **System > Diagnostics** (`Система > Диагностика`) to inspect the detected environment. Check that the NVIDIA driver is installed and `nvidia-smi` works. If GPU detection or dependencies have changed, run repair.

### Processing runs out of GPU memory

Try `instrumental_low_resource` or a lower-precision mode, and close other GPU-heavy applications. Memory requirements vary by model and source.

### Voices remain or the result sounds damaged

Compare `instrumental_full`, `instrumental_balanced`, and `instrumental_clean`. More aggressive removal can damage background audio. Disable high-frequency recovery if voice remnants return, and use the `off` post-processing profile to evaluate the AI output separately.

### Drag and drop does not work

Use the Import button. Drag and drop depends on the optional `tkinterdnd2` integration; the file picker remains available without it.

## Scope and limitations

- Processes one file at a time; there is no batch queue.
- Converts the selected input track to stereo for separation; it does not preserve a surround-channel layout.
- Exports audio only. It does not replace the audio track in the source video or export a new video.
- For video with multiple audio tracks, the app asks which track to use. For audio-only files, it uses the first audio track.
- AI separation is not guaranteed to remove every voice or preserve every sound effect. Review the result before using it in an edit.
