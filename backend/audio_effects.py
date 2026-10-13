"""Non-destructive per-lane effects rendering via FFmpeg.

The original input is never overwritten. Settings match the post-processing
fields exposed by SettingsPanel; unsupported variants are reported explicitly.
"""
from __future__ import annotations

import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from backend.media import source_path
from common import ffmpeg_path

def clamp(value:Any,low:float,high:float,default:float)->float:
    try: number=float(value)
    except (ValueError,TypeError): number=default
    return max(low,min(high,number))

def build_effect_filters(settings:dict)->list[str]:
    result=[]
    if settings.get("highpass_enabled"):
        result.append(f"highpass=f={clamp(settings.get('highpass_hz'),20,18000,80):g}")
    denoise=str(settings.get("denoise_mode","off"))
    if denoise not in ("off","auto","always"):
        raise ValueError("Неизвестный режим шумоподавления")
    if denoise in ("auto","always"):
        result.append(f"afftdn=nr={clamp(settings.get('denoise_reduction_db'),1,45,3):g}")
    if settings.get("declick_enabled"):
        result.append("adeclick")
    if settings.get("loudnorm_enabled"):
        lufs=clamp(settings.get("target_lufs"),-36,-5,-18)
        lra=clamp(settings.get("target_lra"),1,50,20)
        peak=clamp(settings.get("true_peak_db"),-9,-.1,-1.5)
        result.append(f"loudnorm=I={lufs:g}:LRA={lra:g}:TP={peak:g}")
    if settings.get("compressor_enabled"):
        threshold=clamp(settings.get("compressor_threshold_db"),-70,-1,-18)
        ratio=clamp(settings.get("compressor_ratio"),1,20,2)
        attack=clamp(settings.get("compressor_attack_ms"),.01,200,20)
        release=clamp(settings.get("compressor_release_ms"),1,3000,250)
        result.append(f"acompressor=threshold={10**(threshold/20):.6f}:ratio={ratio:g}:attack={attack:g}:release={release:g}")
    if settings.get("limiter_enabled"):
        result.append(f"alimiter=limit={clamp(settings.get('limiter_limit'),.1,1,.95):g}")
    return result

def apply_lane_effects(args:dict,cancel:threading.Event|None=None)->dict:
    source=source_path(args["path"])
    stream=int(args.get("stream",0))
    settings=args.get("settings") or {}
    if not isinstance(settings,dict):
        raise ValueError("Некорректные параметры эффектов")
    filters=build_effect_filters(settings)
    start_ms=clamp(args.get("startMs",0),0,48*3600*1000,0)
    duration_ms=clamp(args.get("durationMs",0),0,48*3600*1000,0)
    if "durationMs" in args and duration_ms<1:
        raise ValueError("Фрагмент слишком короткий")
    trim=(f"atrim=start={start_ms/1000:.6f}"
          +(f":duration={duration_ms/1000:.6f}" if duration_ms else "")
          +",asetpts=PTS-STARTPTS,")
    base=source.with_name(source.stem+"_fx.wav")
    target=base
    index=2
    while target.exists():
        target=source.with_name(f"{source.stem}_fx_{index:03}.wav")
        index+=1
    temporary=target.with_name("."+target.stem+"-"+uuid.uuid4().hex+".part.wav")
    chain=trim+",".join(["aresample=48000","aformat=channel_layouts=stereo"]+filters)
    command=[ffmpeg_path(),"-nostdin","-hide_banner","-v","error","-y",
             "-i",str(source)]
    if settings.get("high_end_recovery"):
        original_path=args.get("originalPath")
        if not original_path:
            raise ValueError("Для восстановления ВЧ необходим оригинальный видеофайл")
        original=source_path(str(original_path))
        original_stream=int(args.get("originalStream",0))
        offset=clamp(args.get("originalOffsetMs"),0,48*3600*1000,0)/1000
        cutoff=clamp(settings.get("high_end_cutoff_hz"),1000,19500,12000)
        volume=clamp(settings.get("high_end_gain_db"),-70,6,-20)
        filtergraph=(
            f"[0:{stream}]{chain}[base];"
            f"[1:{original_stream}]atrim=start={offset:.3f},asetpts=PTS-STARTPTS,"
            f"aresample=48000,aformat=channel_layouts=stereo,"
            f"highpass=f={cutoff:g},volume={volume}dB[high];"
            "[base][high]amix=inputs=2:duration=first:normalize=0[out]"
        )
        command+=["-i",str(original),"-filter_complex",filtergraph,"-map","[out]"]
    else:
        command+=["-map",f"0:{stream}","-af",chain]
    command+=["-vn","-sn","-dn","-ac","2","-ar","48000",
              "-c:a","pcm_s24le",str(temporary)]
    flags=subprocess.CREATE_NO_WINDOW if os.name=="nt" else 0
    proc=None
    try:
        proc=subprocess.Popen(command,stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,
                              creationflags=flags)
        while proc.poll() is None:
            if cancel and cancel.wait(.15):
                proc.terminate()
                try:proc.wait(timeout=3)
                except subprocess.TimeoutExpired:proc.kill()
                raise RuntimeError("Применение эффектов отменено")
            if cancel is None:
                import time
                time.sleep(.15)
        error=proc.stderr.read().decode("utf-8","replace")[-1500:] if proc.stderr else ""
        if proc.returncode!=0:
            raise RuntimeError("FFmpeg: "+error)
        if temporary.stat().st_size<=44:
            raise RuntimeError("FFmpeg не создал обработанную аудиодорожку")
        os.replace(temporary,target)
        return {"path":str(target),"filters":filters,
                "startMs":round(start_ms),"durationMs":round(duration_ms)}
    finally:
        if proc is not None and proc.stderr is not None:
            proc.stderr.close()
        temporary.unlink(missing_ok=True)
