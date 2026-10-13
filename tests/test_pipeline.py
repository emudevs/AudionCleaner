"""Fast orchestration/worker tests without loading neural model weights."""
from __future__ import annotations

import io
import json
import sys
import tempfile
import threading
import types
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from backend.processing import output_path, process
from backend.preflight import verify_runtime


def synthetic_wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00\x00\x00" * 1600)


class PipelineTests(unittest.TestCase):
    def test_processing_generates_unique_names(self):
        with tempfile.TemporaryDirectory() as temp:
            original = Path(temp) / "sample.mp4"
            original.write_bytes(b"video")
            first = output_path(original)
            self.assertEqual(first.name, "sample_Clear.wav")
            first.write_bytes(b"old-result")
            self.assertEqual(output_path(original).name, "sample_Clear_002.wav")
            self.assertEqual(first.read_bytes(), b"old-result")

    def test_orchestration_passes_settings_to_isolated_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            original = Path(temp) / "source.mp4"
            original.write_bytes(b"video")
            events = []

            def simulate_worker(source, stream, target, settings, cancel, emit, start=None, end=None):
                self.assertEqual(source, original)
                self.assertEqual(stream, 4)
                self.assertEqual(settings["precision"], "fp32")
                self.assertEqual(settings["separator_preset"], "instrumental_full")
                self.assertFalse(cancel.is_set())
                emit("process.progress", {"stage": "Тест worker", "percent": 50})
                synthetic_wav(target)
                return target

            with patch("backend.processing._execute_worker", side_effect=simulate_worker):
                result = process(original, 4, None, {"precision": "fp32"},
                                 threading.Event(),
                                 lambda event, data: events.append((event, data)))
            self.assertTrue(Path(result["path"]).is_file())
            self.assertEqual(result["name"], "source_Clear.wav")
            self.assertIn(("process.progress", {"stage": "Тест worker", "percent": 50}), events)

    def test_off_profile_disables_filters_in_worker_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            original = Path(temp) / "input.mp4"
            original.write_bytes(b"source")
            def simulate_worker(source, stream, target, settings, cancel, emit, start=None, end=None):
                self.assertEqual(settings["post_profile"], "off")
                for key in ("highpass_enabled", "loudnorm_enabled",
                            "declick_enabled", "high_end_recovery",
                            "compressor_enabled", "limiter_enabled"):
                    self.assertFalse(settings[key], key)
                self.assertEqual(settings["denoise_mode"], "off")
                synthetic_wav(target)
                return target
            with patch("backend.processing._execute_worker", side_effect=simulate_worker):
                result = process(original, 0, None,
                                 {"post_profile": "off", "loudnorm_enabled": True},
                                 threading.Event(), lambda *_: None)
            self.assertTrue(Path(result["path"]).is_file())

    def test_segment_range_passed_to_worker_and_unique_output(self):
        with tempfile.TemporaryDirectory() as temp:
            original = Path(temp) / "episode.mp4"
            original.write_bytes(b"video")
            def simulate_worker(source, stream, target, settings, cancel, emit, start, end):
                self.assertEqual((start, end), (10100, 17500))
                self.assertIn("000010100-000017500", target.name)
                synthetic_wav(target)
                return target
            with patch("backend.processing._execute_worker", side_effect=simulate_worker):
                result = process(original, 0, None, {}, threading.Event(),
                                 lambda *_: None, 10100, 17500)
            self.assertTrue(Path(result["path"]).exists())
            # Processing the same selection again must not overwrite the old WAV.
            next_name = output_path(original, None, 10100, 17500)
            self.assertTrue(next_name.name.endswith("_002.wav"))

    def test_bad_selection_rejected_without_starting_worker(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "episode.mp4"
            source.write_bytes(b"video")
            with patch("backend.processing._execute_worker") as worker:
                for begin, end in ((1000, 1000), (2000, 1500), (-100, 200), (0, 50)):
                    with self.subTest(begin=begin,end=end):
                        with self.assertRaises(ValueError):
                            process(source, 0, None, {}, threading.Event(),
                                    lambda *_: None, begin, end)
                worker.assert_not_called()

    def test_ffmpeg_segment_trim_arguments(self):
        from processor import prepare_audio
        with patch("processor._run") as runner, patch("processor.ffmpeg_path",return_value="ffmpeg"):
            prepare_audio(Path("source.mkv"),2,Path("clip.wav"),44100,
                          lambda *_:None,threading.Event(),1200,5600)
        args=runner.call_args.args[0]
        self.assertEqual(args[args.index("-ss")+1],"1.200")
        self.assertEqual(args[args.index("-t")+1],"4.400")
        self.assertEqual(args[args.index("-map")+1],"0:2")

    def test_worker_json_line_protocol_with_synthetic_engine(self):
        from backend import processing_worker
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            destination = root / "output.wav"
            fake = types.ModuleType("processor")
            def fake_process_one(source, stream, target, settings, on_log, on_phase, cancel, **kwargs):
                on_log("Synthetic processor is running")
                on_phase("Синтетический этап", 70)
                synthetic_wav(target)
                return target
            fake.process_one = fake_process_one
            packet = json.dumps({
                "source": str(root / "input.mp4"),
                "target": str(destination),
                "stream": 0, "settings": {"precision": "fp32"}
            })
            captured = io.StringIO()
            with patch.dict(sys.modules, {"processor": fake}), \
                 patch("sys.stdin", io.StringIO(packet + "\n")), \
                 patch("sys.stdout", captured):
                exit_code = processing_worker.main()
            messages = [json.loads(line) for line in captured.getvalue().splitlines()]
            self.assertEqual(exit_code, 0)
            self.assertTrue(destination.exists())
            self.assertTrue(any(x.get("type") == "done" for x in messages))
            self.assertTrue(any(x.get("percent") == 70 for x in messages
                                if x.get("type") == "progress"))

    def test_missing_required_runtime_is_actionable(self):
        with patch("backend.preflight.ffmpeg_path", side_effect=FileNotFoundError("ffmpeg")), \
             patch("backend.preflight.ffprobe_path", side_effect=FileNotFoundError("ffprobe")), \
             patch("backend.preflight.importlib.util.find_spec", return_value=None):
            result = verify_runtime({"separator_preset": "instrumental_full"})
        self.assertFalse(result["ok"])
        self.assertTrue(any("FFmpeg" in message for message in result["errors"]))
        self.assertTrue(any("audio_separator" in message for message in result["errors"]))


if __name__ == "__main__":
    unittest.main()
