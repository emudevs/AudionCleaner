"""FFmpeg integration regressions: complete waveform and muted export."""
from __future__ import annotations

import math
import struct
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from backend.audio_export import export_audio
from backend.service import dispatch
from backend.waveform import decode_peaks


class WaveformIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="acl-waveform-check-")
        cls.folder = Path(cls.directory.name)
        cls.source = cls.folder / "synthetic-original.wav"
        cls.duration_seconds = 9
        sample_rate = 8000
        with wave.open(str(cls.source), "wb") as sound:
            sound.setnchannels(1)
            sound.setsampwidth(2)
            sound.setframerate(sample_rate)
            # Constant 440Hz tone across the whole file; a missing final 6s
            # cannot be mistaken for silence in the source material.
            samples = (int(12000 * math.sin(2 * math.pi * 440 * i / sample_rate))
                       for i in range(sample_rate * cls.duration_seconds))
            sound.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_decoder_covers_the_entire_source(self):
        parts = []
        meta = decode_peaks(self.source, 0, lambda batch: parts.append(batch),
                            threading.Event())
        peaks = [peak for batch in parts for peak in batch]
        self.assertEqual(meta["intervalMs"], 20)
        self.assertEqual(meta["samples"], 450)
        self.assertEqual(len(peaks), 450)
        self.assertGreater(len(parts), 1, "Must cover multiple async chunks")
        self.assertGreater(peaks[0][0], .1)
        self.assertGreater(peaks[-1][0], .1, "End of clip must be present")

    def test_ipc_reply_contains_complete_overview(self):
        events = []
        with patch("backend.service.emit", side_effect=events.append):
            response = dispatch("wave-test", "media.waveform", {
                "path": str(self.source),
                "stream": 0,
                "durationMs": 9000,
            })
        parts = [event["peaks"] for event in events
                 if event.get("event") == "waveform.chunk"]
        self.assertGreater(len(parts), 1)
        self.assertEqual(response["intervalMs"], 20)
        self.assertEqual(response["samples"], 450)
        self.assertEqual(len(response["peaks"]), 450)
        self.assertEqual(response["peaks"], [p for part in parts for p in part])
        self.assertGreater(response["peaks"][-1][0], .1)

    def test_long_recording_uses_coarser_bins(self):
        seen = []
        def fake_decode(_path, _stream, send, _cancel, *args, **kwargs):
            seen.append(kwargs["interval_ms"])
            send([[.2, .2]] * 3)
            return {"samples": 3, "intervalMs": kwargs["interval_ms"]}
        with (patch("backend.waveform.decode_peaks", side_effect=fake_decode),
              patch("backend.service.emit")):
            response = dispatch("long-test", "media.waveform", {
                "path": str(self.source),
                "stream": 0,
                "durationMs": 3 * 3600000,
            })
        self.assertEqual(seen, [100])
        self.assertEqual(response["peaks"], [[.2, .2]] * 3)

    @staticmethod
    def amplitude(path: Path) -> int:
        with wave.open(str(path), "rb") as source:
            assert source.getsampwidth() == 3
            data = source.readframes(2000)
        return max((abs(int.from_bytes(data[i:i+3], "little", signed=True))
                    for i in range(0, len(data) - 2, 3)), default=0)

    def test_muted_original_exports_silence(self):
        muted = self.folder / "muted.wav"
        active = self.folder / "active.wav"
        original = {
            "path": str(self.source),
            "streamIndex": 0,
            "offsetMs": 0,
            "sourceStartMs": 0,
            "durationMs": 1500,
            "muted": True,
            "solo": False,
            "gain": 1,
            "pan": 0,
        }
        export_audio({"target": str(muted), "durationMs": 1500, "tracks": [original]})
        self.assertEqual(self.amplitude(muted), 0, "Muted Original must be silent")
        export_audio({"target": str(active), "durationMs": 1500,
                      "tracks": [{**original, "muted": False}]})
        self.assertGreater(self.amplitude(active), 2000, "Enabled Original must sound")


if __name__ == "__main__":
    unittest.main()
