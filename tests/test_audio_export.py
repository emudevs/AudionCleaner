"""Non-destructive multitrack export regression tests."""
from __future__ import annotations

import math
import shutil
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from backend.audio_export import build_mix_command, export_audio
from common import ffmpeg_path


def make_stereo(path: Path, seconds:float=0.5) -> None:
    import struct
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        values = bytearray()
        for i in range(int(48000*seconds)):
            v=int(5000*math.sin(2*math.pi*440*i/48000))
            values.extend(struct.pack("<hh",v,v))
        wav.writeframes(values)


class ExportTests(unittest.TestCase):
    def test_mix_filter_has_trim_pan_fade_gain_and_delay(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"input.wav"
            make_stereo(source)
            clips=[
                dict(path=str(source),streamIndex=0,sourceStartMs=0,
                     offsetMs=0,durationMs=200,fadeInMs=30,fadeOutMs=20,
                     gain=.8,clipGain=.5,pan=-.5,muted=False,solo=False),
                dict(path=str(source),streamIndex=0,sourceStartMs=200,
                     offsetMs=200,durationMs=300,fadeInMs=10,fadeOutMs=0,
                     gain=.8,clipGain=1,pan=0,muted=False,solo=False),
            ]
            command=build_mix_command(clips,Path(directory)/"mix.wav",600)
            expression=command[command.index("-filter_complex")+1]
            self.assertEqual(command.count("-i"),1)
            self.assertIn("asplit=2",expression)
            self.assertIn("amix=inputs=2",expression)
            self.assertIn("curve=qsin",expression)
            self.assertIn("adelay=200:all=1",expression)
            self.assertIn("volume=0.400000",expression)
            self.assertIn("pan=stereo",expression)
            self.assertIn("atrim=start=0.200000:duration=0.300000",expression)

    def test_curved_fade_writes_real_stereo_wave(self):
        executable=ffmpeg_path()
        if not (Path(executable).is_file() or shutil.which(executable)):
            self.skipTest("FFmpeg not available")
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"source.wav"
            target=Path(directory)/"curved_mix.wav"
            make_stereo(source,0.6)
            clips=[dict(path=str(source),sourceStartMs=0,offsetMs=0,
                        durationMs=600,fadeInMs=180,fadeOutMs=200,
                        fadeInCurve=-1.5,fadeOutCurve=1.25,
                        gain=1,clipGain=1,pan=0)]
            cmd=build_mix_command(clips,target,600)
            graph=cmd[cmd.index("-filter_complex")+1]
            self.assertIn("volume=",graph)
            self.assertIn("eval=frame",graph)
            result=export_audio({"target":str(target),"durationMs":600,"tracks":clips})
            self.assertEqual(result["path"],str(target))
            with wave.open(str(target),"rb") as wav:
                self.assertEqual(wav.getnchannels(),2)
                self.assertGreater(wav.getnframes(),25000)

    def test_muted_and_solo_clips_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"input.wav"
            make_stereo(source)
            clips=[
                dict(path=str(source),durationMs=200,muted=False,solo=False),
                dict(path=str(source),durationMs=200,muted=False,solo=True),
            ]
            command=build_mix_command(clips,Path(directory)/"mix.wav",500)
            self.assertEqual(command.count("-i"),1)

    def test_empty_mix_produces_silence(self):
        cmd=build_mix_command([],Path("mix.wav"),800)
        self.assertIn("anullsrc=r=48000:cl=stereo",cmd)
        self.assertIn("pcm_s24le",cmd)

    def test_adjacent_split_has_no_inserted_silence(self):
        executable=ffmpeg_path()
        if not (Path(executable).is_file() or shutil.which(executable)):
            self.skipTest("FFmpeg unavailable")
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"continuous.wav"
            target=Path(directory)/"joined.wav"
            make_stereo(source,0.6)
            clips=[
                dict(path=str(source),sourceStartMs=0,offsetMs=0,durationMs=300),
                dict(path=str(source),sourceStartMs=300,offsetMs=300,durationMs=300),
            ]
            export_audio({"target":str(target),"durationMs":600,"tracks":clips})
            with wave.open(str(target),"rb") as output:
                self.assertEqual(output.getnchannels(),2)
                self.assertEqual(output.getsampwidth(),3)
                output.setpos(48000*300//1000-480)
                samples=output.readframes(960)
            # 24-bit stereo: six bytes per audio frame. A split must not
            # introduce decoder startup silence, even for separate trims.
            silent_run=largest_run=0
            for frame in range(0,len(samples),6):
                if samples[frame:frame+6]==bytes(6):
                    silent_run+=1
                    largest_run=max(largest_run,silent_run)
                else:
                    silent_run=0
            self.assertLess(largest_run,96,"More than 2 ms silence at splice")

    def test_real_ffmpeg_exports_one_stereo_wave(self):
        executable=ffmpeg_path()
        if not (Path(executable).is_file() or shutil.which(executable)):
            self.skipTest("FFmpeg not available")
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/"original.wav"
            target=Path(directory)/"mix.wav"
            make_stereo(source,0.6)
            clips=[
                dict(path=str(source),sourceStartMs=0,offsetMs=0,
                     durationMs=250,fadeInMs=80,fadeOutMs=50,
                     gain=1,clipGain=1,pan=0),
                dict(path=str(source),sourceStartMs=250,offsetMs=250,
                     durationMs=350,fadeInMs=40,fadeOutMs=60,
                     gain=1,clipGain=.8,pan=.1),
            ]
            result=export_audio({"target":str(target),"durationMs":600,"tracks":clips})
            self.assertEqual(result["path"],str(target))
            with wave.open(str(target),"rb") as wav:
                self.assertEqual(wav.getnchannels(),2)
                self.assertEqual(wav.getframerate(),48000)
                self.assertGreater(wav.getnframes(),25000)


if __name__=="__main__":
    unittest.main()
