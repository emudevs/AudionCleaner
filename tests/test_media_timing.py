"""FFprobe must preserve real audio-stream timing and tolerate N/A metadata."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.media import _milliseconds, inspect


class MediaTimingTests(unittest.TestCase):
    def test_optional_time_fields(self):
        self.assertIsNone(_milliseconds(None))
        self.assertIsNone(_milliseconds("N/A"))
        self.assertIsNone(_milliseconds("nan"))
        self.assertEqual(_milliseconds("53.4567"), 53457)

    def test_audio_can_end_before_video(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"episode.mp4"
            path.write_bytes(b"fake")
            probe={
                "format":{"duration":"56.280"},
                "streams":[
                    {"index":0,"codec_type":"video","duration":"56.280"},
                    {"index":1,"codec_type":"audio","duration":"53.850",
                     "start_time":"0.000","channels":2,"codec_name":"aac"},
                ],
            }
            with patch("backend.media.subprocess.run",
                       return_value=SimpleNamespace(stdout=json.dumps(probe))):
                result=inspect(str(path))
            self.assertEqual(result["durationMs"],56280)
            self.assertEqual(result["audioStreams"][0]["durationMs"],53850)
            self.assertEqual(result["audioStreams"][0]["startMs"],0)

    def test_unknown_stream_duration_does_not_crash(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"unknown.mkv"
            path.write_bytes(b"fake")
            probe={
                "format":{"duration":"56.280"},
                "streams":[{"index":0,"codec_type":"audio","duration":"N/A",
                            "start_time":"N/A","codec_name":"aac"}],
            }
            with patch("backend.media.subprocess.run",
                       return_value=SimpleNamespace(stdout=json.dumps(probe))):
                result=inspect(str(path))
            self.assertIsNone(result["audioStreams"][0]["durationMs"])
            self.assertIsNone(result["audioStreams"][0]["startMs"])


if __name__=="__main__":
    unittest.main()
