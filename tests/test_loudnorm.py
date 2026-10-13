"""Regression tests for FFmpeg loudnorm statistics and fallback."""
from __future__ import annotations

import math
import struct
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from common import DEFAULT_SETTINGS, ffmpeg_path
from processor import loudnorm_measure, master_audio


def make_wav(path: Path, *, seconds: float = 1.0, silent: bool = False):
    sample_rate = 48000
    with wave.open(str(path), "wb") as sound:
        sound.setnchannels(2)
        sound.setsampwidth(2)
        sound.setframerate(sample_rate)
        samples = bytearray()
        for index in range(round(sample_rate * seconds)):
            value = 0 if silent else int(10000 * math.sin(2 * math.pi * 440 * index / sample_rate))
            samples.extend(struct.pack("<hh", value, value))
        sound.writeframes(samples)


STATS = {
    "input_i": "-16.78",
    "input_tp": "-4.20",
    "input_lra": "2.40",
    "input_thresh": "-26.78",
    "target_offset": "-1.22",
}


class LoudnormTests(unittest.TestCase):
    def setUp(self):
        self.settings = {
            **DEFAULT_SETTINGS,
            "denoise_mode": "off",
            "highpass_enabled": False,
            "compressor_enabled": False,
            "loudnorm_enabled": True,
        }
        self.lines = []
        self.cancel = threading.Event()

    def test_parses_json_despite_extra_ffmpeg_lines_and_field_order(self):
        import json
        payload = {"output_i": "-18.00", "target_offset": "-1.22", **STATS}
        with patch("processor._run", return_value="ffmpeg diagnostics\n" + json.dumps(payload)):
            stats = loudnorm_measure(Path("test.wav"), [], self.settings,
                                     self.lines.append, self.cancel)
        self.assertEqual(stats["input_i"], "-16.78")

    def test_missing_statistics_falls_back_instead_of_crashing(self):
        with patch("processor._run", return_value="ffmpeg printed no loudnorm JSON") as runner:
            stats = loudnorm_measure(Path("test.wav"), [], self.settings,
                                     self.lines.append, self.cancel)
        self.assertIsNone(stats)
        self.assertTrue(any("Диагностика loudnorm" in s for s in self.lines))
        self.lines.clear()
        with patch("processor.loudnorm_measure", return_value=None), patch("processor._run") as render:
            master_audio(Path("in.wav"), Path("out.wav"), self.settings,
                         self.lines.append, self.cancel)
        command = render.call_args.args[0]
        chain = command[command.index("-af") + 1]
        self.assertIn("loudnorm=", chain)
        self.assertNotIn("measured_I", chain)
        self.assertIn("print_format=summary", chain)

    def test_non_finite_lufs_is_not_used_for_second_pass(self):
        import json
        for value in ("-inf", "nan", "invalid"):
            with self.subTest(value=value):
                self.lines.clear()
                stat = {**STATS, "input_i": value}
                with patch("processor._run", return_value=json.dumps(stat)):
                    result = loudnorm_measure(Path("test.wav"), [], self.settings,
                                              self.lines.append, self.cancel)
                self.assertIsNone(result)

    def test_normal_signal_uses_two_pass_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            target = Path(directory) / "normalized.wav"
            make_wav(source)
            master_audio(source, target, self.settings, self.lines.append, self.cancel)
            self.assertTrue(target.exists())
            with wave.open(str(target), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 2)
                self.assertGreater(wav.getnframes(), 40000)
            self.assertTrue(any("Громкость до" in s for s in self.lines))

    def test_silence_does_not_crash_master_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silent.wav"
            target = Path(directory) / "silent_normalized.wav"
            make_wav(source, silent=True)
            master_audio(source, target, self.settings, self.lines.append, self.cancel)
            self.assertTrue(target.exists())
            with wave.open(str(target), "rb") as wav:
                self.assertGreater(wav.getnframes(), 40000)


if __name__ == "__main__":
    unittest.main()
