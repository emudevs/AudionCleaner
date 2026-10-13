"""Regression tests for non-destructive lane effects."""
import tempfile
import unittest
import wave
from pathlib import Path

from backend.audio_effects import build_effect_filters, apply_lane_effects
from common import ffmpeg_path
import shutil


class LaneEffectsTests(unittest.TestCase):
    def test_filter_mapping(self):
        config={
            "highpass_enabled":True,"highpass_hz":110,
            "denoise_mode":"always","denoise_reduction_db":7,
            "declick_enabled":True,
            "loudnorm_enabled":True,"target_lufs":-18,
            "target_lra":14,"true_peak_db":-2,
            "compressor_enabled":True,"compressor_threshold_db":-16,
            "compressor_ratio":3,"compressor_attack_ms":10,
            "compressor_release_ms":150,
            "limiter_enabled":True,"limiter_limit":.90,
        }
        filters=build_effect_filters(config)
        self.assertTrue(any(v.startswith("highpass=f=110") for v in filters))
        self.assertTrue(any(v.startswith("afftdn=") for v in filters))
        self.assertIn("adeclick",filters)
        self.assertTrue(any(v.startswith("loudnorm=") for v in filters))
        self.assertTrue(any(v.startswith("acompressor=") for v in filters))
        self.assertTrue(any(v.startswith("alimiter=") for v in filters))

    def test_high_end_recovery_requires_original_source(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/"source.wav"
            source.write_bytes(b"input")
            with self.assertRaisesRegex(ValueError,"оригинальный видеофайл"):
                apply_lane_effects({
                    "path":str(source),"stream":0,
                    "settings":{"high_end_recovery":True},
                })

    def test_effects_trim_only_requested_fragment(self):
        exe=ffmpeg_path()
        if not (Path(exe).exists() or shutil.which(exe)):
            self.skipTest("FFmpeg unavailable")
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/"scene.wav"
            with wave.open(str(source),"wb") as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(48000)
                wav.writeframes(bytes(4*48000))
            result=apply_lane_effects({
                "path":str(source),"stream":0,
                "startMs":250,"durationMs":350,
                "settings":{"highpass_enabled":True,"highpass_hz":100}
            })
            with wave.open(result["path"],"rb") as wav:
                self.assertEqual(wav.getnchannels(),2)
                self.assertAlmostEqual(wav.getnframes()/48000,0.35,delta=.01)
            self.assertEqual(result["startMs"],250)
            self.assertEqual(result["durationMs"],350)
            with wave.open(str(source),"rb") as wav:
                self.assertEqual(wav.getnframes(),48000)

    def test_backend_exposes_fx_capability(self):
        from backend.service import dispatch
        hello=dispatch("probe","system.hello",{})
        self.assertIn("audio.effects",hello["features"])

    def test_render_wav_preserves_original(self):
        exe=ffmpeg_path()
        if not (Path(exe).exists() or shutil.which(exe)):
            self.skipTest("FFmpeg unavailable")
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/"source.wav"
            with wave.open(str(source),"wb") as wav:
                wav.setnchannels(2)
                wav.setsampwidth(2)
                wav.setframerate(48000)
                wav.writeframes(b"\0\0"*2*9600)
            before=source.read_bytes()
            result=apply_lane_effects({
                "path":str(source),"stream":0,
                "settings":{"highpass_enabled":True,"highpass_hz":80}
            })
            target=Path(result["path"])
            self.assertNotEqual(target,source)
            self.assertEqual(source.read_bytes(),before)
            with wave.open(str(target),"rb") as wav:
                self.assertEqual(wav.getnchannels(),2)
                self.assertGreater(wav.getnframes(),9000)


if __name__=="__main__":
    unittest.main()
