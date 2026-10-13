"""Non-destructive multitrack WAV rendering with FFmpeg.

Every UI clip carries its source trim, timeline offset, level, balance and
fade metadata. The original audio may be included in the final mix, but its
source is never modified.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from common import ffmpeg_path

def _numeric(value: Any, fallback: float = 0.0, lo: float = 0.0, hi: float = 100000000.0) -> float:
    try:
        number = float(value)
        if not (lo <= number <= hi):
            raise ValueError(f"Параметр вне диапазона: {number}")
        return number
    except (TypeError, ValueError):
        if value is None:
            return fallback
        raise

def _seconds(ms:float)->str:
    return f"{ms/1000:.6f}"

def _curved_fade_filter(kind:str, duration_ms:float, clip_ms:float, curve:float)->str:
    """Frame-evaluated quarter-sine envelope with adjustable curvature.

    Default tension 0 preserves FFmpeg's native sample-accurate qsin fade.
    Nonzero tension uses a per-frame expression that matches the Canvas and
    WebAudio gain curve; \\, escapes commas in FFmpeg filter expressions.
    """
    position = 0.0 if kind == "in" else (clip_ms-duration_ms)/1000
    if abs(curve)<1e-6:
        return f"afade=t={kind}:st={position:.6f}:d={_seconds(duration_ms)}:curve=qsin"
    duration_s=duration_ms/1000
    exponent=2**max(-2,min(2,curve))
    texpr=f"t/{duration_s:.6f}" if kind=="in" else f"({clip_ms/1000:.6f}-t)/{duration_s:.6f}"
    ratio=f"min(1\\,max(0\\,{texpr}))"
    gain=f"pow(sin(PI/2*{ratio})\\,{exponent:.6f})"
    compare=f"lt(t\\,{duration_s:.6f})" if kind=="in" else f"gt(t\\,{position:.6f})"
    return f"volume='if({compare}\\,{gain}\\,1)':eval=frame"

def build_mix_command(clips: list[dict], target: Path, duration_ms: int) -> list[str]:
    if not (100 <= duration_ms <= 48*3600*1000):
        raise ValueError("Некорректная длительность проекта")
    if target.suffix.lower() != ".wav":
        raise ValueError("Экспорт поддерживает WAV")
    any_solo = any(bool(c.get("solo")) for c in clips)
    audible = [
        clip for clip in clips
        if not clip.get("muted") and (not any_solo or clip.get("solo"))
        and clip.get("path") and int(clip.get("durationMs",0)) > 0
    ]
    filters = []
    if not audible:
        return [
            ffmpeg_path(), "-nostdin", "-hide_banner", "-y", "-v", "error",
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
            "-t", _seconds(duration_ms),
            "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2",
            str(target),
        ]
    command=[ffmpeg_path(), "-nostdin", "-hide_banner", "-y", "-v", "error"]
    inputs_by_path: dict[Path,int] = {}
    source_groups: dict[tuple[int,int],list[int]] = {}
    for clip_i,clip in enumerate(audible):
        path=Path(str(clip["path"])).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Файл дорожки не найден: {path}")
        if path == target.resolve():
            raise ValueError("Нельзя экспортировать поверх исходника")
        if path not in inputs_by_path:
            inputs_by_path[path]=len(inputs_by_path)
            command+=["-i",str(path)]
        source_index=inputs_by_path[path]
        stream=int(_numeric(clip.get("streamIndex",0),lo=0,hi=128))
        source_groups.setdefault((source_index,stream),[]).append(clip_i)
    source_labels: dict[int,str] = {}
    # Decode every unique audio stream once and fan it out to clip trims.
    for (input_index,stream),indices in source_groups.items():
        source=f"[{input_index}:{stream}]"
        if len(indices)>1:
            branch="".join(f"[source{clip_i}]" for clip_i in indices)
            filters.append(f"{source}asplit={len(indices)}{branch}")
            for clip_i in indices:
                source_labels[clip_i]=f"[source{clip_i}]"
        else:
            source_labels[indices[0]]=source
    for i,clip in enumerate(audible):
        duration=float(_numeric(clip.get("durationMs"),lo=1,hi=duration_ms+3600000))
        offset=float(_numeric(clip.get("offsetMs",0),lo=-3600000,hi=duration_ms+3600000))
        start=float(_numeric(clip.get("sourceStartMs",0),lo=0,hi=48*3600000))
        stream=int(_numeric(clip.get("streamIndex",0),lo=0,hi=128))
        gain=float(_numeric(clip.get("gain",1),1,0,6))
        clip_gain=float(_numeric(clip.get("clipGain",1),1,0,6))
        pan=float(_numeric(clip.get("pan",0),0,-1,1))
        fade_in=float(_numeric(clip.get("fadeInMs",0),0,0,duration))
        fade_out=float(_numeric(clip.get("fadeOutMs",0),0,0,duration))
        fade_in_curve=float(_numeric(clip.get("fadeInCurve",0),0,-2,2))
        fade_out_curve=float(_numeric(clip.get("fadeOutCurve",0),0,-2,2))
        parts=[
            f"atrim=start={_seconds(start)}:duration={_seconds(duration)}",
            "asetpts=PTS-STARTPTS",
            "aresample=48000",
            "aformat=channel_layouts=stereo",
        ]
        # Quarter sine is exactly the shape drawn and previewed in the UI.
        if fade_in>1:
            parts.append(_curved_fade_filter("in",fade_in,duration,fade_in_curve))
        if fade_out>1:
            parts.append(_curved_fade_filter("out",fade_out,duration,fade_out_curve))
        parts.append(f"volume={min(12.0,gain*clip_gain):.6f}")
        if pan != 0:
            l=1-max(0,pan)
            r=1+min(0,pan)
            parts.append(f"pan=stereo|c0={l:.6f}*c0|c1={r:.6f}*c1")
        if offset<0:
            parts.extend([f"atrim=start={_seconds(-offset)}","asetpts=PTS-STARTPTS"])
        if offset>0:
            parts.append(f"adelay={int(round(offset))}:all=1")
        # adelay can yield discontinuous timestamps. Without a sample-count
        # timestamp reset, amix concatenates or shifts parts of split clips.
        # Pad each branch to the project end to prevent premature mix EOF.
        parts.append("asetpts=N/SR/TB")
        parts.append(f"apad=whole_dur={_seconds(duration_ms)}")
        parts.append(f"atrim=end={_seconds(duration_ms)}")
        filters.append(f"{source_labels[i]}{','.join(parts)}[clip{i}]")
    inputs="".join(f"[clip{i}]" for i in range(len(audible)))
    if len(audible)>1:
        filters.append(f"{inputs}amix=inputs={len(audible)}:duration=longest:normalize=0,apad=pad_dur={_seconds(duration_ms)},atrim=end={_seconds(duration_ms)}[mix]")
    else:
        filters.append(f"{inputs}anull,apad=pad_dur={_seconds(duration_ms)},atrim=end={_seconds(duration_ms)}[mix]")
    command+=["-filter_complex", ";".join(filters), "-map", "[mix]",
              "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2",
              str(target)]
    return command

def export_audio(args:dict, cancel=None, on_progress=None)->dict:
    output=Path(str(args["target"])).expanduser().resolve()
    if output.suffix.lower() != ".wav":
        raise ValueError("Экспорт поддерживает только .wav")
    duration=int(args["durationMs"])
    clips=args["tracks"]
    if not isinstance(clips,list):
        raise ValueError("Некорректный список дорожек")
    if any(Path(str(clip["path"])).expanduser().resolve()==output
           for clip in clips if clip.get("path")):
        raise ValueError("Нельзя перезаписать исходную дорожку при экспорте")
    output.parent.mkdir(parents=True,exist_ok=True)
    temp=output.with_name("."+output.stem+"-"+uuid.uuid4().hex+".part.wav")
    command=build_mix_command(clips,temp,duration)
    flags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0
    try:
        if on_progress:
            on_progress("Сведение дорожек FFmpeg")
        with tempfile.TemporaryFile(mode="w+t",encoding="utf-8",errors="replace") as error_file:
            proc=subprocess.Popen(
                command, stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=error_file,creationflags=flags,
            )
            try:
                while proc.poll() is None:
                    if cancel and cancel.is_set():
                        proc.terminate()
                        try:proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:proc.kill()
                        raise RuntimeError("Экспорт отменён")
                    time.sleep(.15)
                if proc.returncode:
                    error_file.seek(0)
                    raise RuntimeError("FFmpeg: "+error_file.read()[-2500:])
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
        if not temp.is_file() or temp.stat().st_size<44:
            raise RuntimeError("FFmpeg завершился без WAV-файла")
        os.replace(temp,output)
        return {"path":str(output),"bytes":output.stat().st_size,"tracks":len(clips)}
    finally:
        temp.unlink(missing_ok=True)
