"""End-to-end check: exported WAV must preserve disjoint timeline positions."""
from __future__ import annotations
import math
import shutil
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from backend.audio_export import build_mix_command, export_audio
from common import ffmpeg_path

RATE=48000

def create_tone(path:Path, frequency:int, amplitude:int)->None:
    with wave.open(str(path),'wb') as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        frames=bytearray()
        for t in range(RATE*3):
            signal=int(amplitude*math.sin(2*math.pi*frequency*t/RATE))
            frames.extend(struct.pack('<hh',signal,signal))
        wav.writeframes(frames)

def sample_strength(path:Path,start_ms:int,end_ms:int)->int:
    with wave.open(str(path),'rb') as sound:
        assert sound.getsampwidth()==3 and sound.getnchannels()==2
        sound.setpos(round(RATE*start_ms/1000))
        samples=sound.readframes(round(RATE*(end_ms-start_ms)/1000))
    return max((abs(int.from_bytes(samples[i:i+3],'little',signed=True))
                for i in range(0,len(samples),6)),default=0)

class TimelineMixTests(unittest.TestCase):
    def test_disjoint_original_and_clean_audio_remain_at_timeline_positions(self):
        executable=ffmpeg_path()
        if not(Path(executable).is_file() or shutil.which(executable)):
            self.skipTest('FFmpeg unavailable')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            orig=root/'orig.wav'
            clean=root/'clean.wav'
            target=root/'render.wav'
            create_tone(orig,440,5000)
            create_tone(clean,880,13000)
            clips=[
                # Deliberately ordered by lane, not chronological timeline position.
                dict(path=str(orig),streamIndex=0,offsetMs=450,
                     sourceStartMs=40,durationMs=200,muted=False),
                dict(path=str(orig),streamIndex=0,offsetMs=1650,
                     sourceStartMs=330,durationMs=200,muted=False),
                dict(path=str(clean),streamIndex=0,offsetMs=0,
                     sourceStartMs=0,durationMs=400,muted=False),
                dict(path=str(clean),streamIndex=0,offsetMs=750,
                     sourceStartMs=500,durationMs=800,muted=False),
            ]
            command=build_mix_command(clips,target,2000)
            graph=command[command.index('-filter_complex')+1]
            self.assertIn('adelay=450:all=1',graph)
            self.assertIn('adelay=1650:all=1',graph)
            self.assertIn('adelay=750:all=1',graph)
            export_audio({'target':str(target),'durationMs':2000,'tracks':clips})
            clean_a=sample_strength(target,100,200)
            orig_a=sample_strength(target,500,600)
            gap_a=sample_strength(target,680,720)
            clean_b=sample_strength(target,900,1000)
            orig_b=sample_strength(target,1700,1800)
            end=sample_strength(target,1900,1950)
            self.assertGreater(clean_a,orig_a*1.7)
            self.assertGreater(clean_b,orig_b*1.7)
            self.assertGreater(orig_a,300000)
            self.assertGreater(orig_b,300000)
            self.assertEqual(gap_a,0,'Timeline silence must stay silent')
            self.assertEqual(end,0,'End of timeline must not contain appended audio')
            with wave.open(str(target),'rb') as sound:
                self.assertEqual(sound.getnframes(),RATE*2)

if __name__=='__main__':unittest.main()
