import {useEffect,useMemo,useRef,useState} from 'react';
import type {EditorTrack} from './editor';

export type WaveDetail={
  peaks:[number,number][];
  startMs:number;
  intervalMs:number;
  key:string;
};

/**
 * Viewport-aware, progressive waveform cache. Overview peaks always exist;
 * zooming in fetches only the currently visible source interval at a smaller
 * bin size. All requests are cancelable and never block playback.
 */
export function useWaveformDetails(
  clips:EditorTrack[],
  projectDurationMs:number,
  canvasWidth:number,
  scrollLeft:number,
  viewportWidth:number,
){
  const [cache,setCache]=useState<Record<string,WaveDetail>>({});
  const keys=useRef(new Map<string,string>());
  const live=useRef(new Map<string,string>());
  const stableClips=useMemo(()=>
    clips.map(c=>({
      id:c.id,path:c.path,stream:c.streamIndex||0,
      offset:c.offsetMs||0,sourceStart:c.sourceStartMs||0,
      sourceDuration:c.sourceDurationMs||((c.sourceStartMs||0)+c.durationMs),
      length:c.durationMs,
    })),[clips.map(c=>[c.id,c.path,c.offsetMs,c.sourceStartMs,c.durationMs,c.sourceDurationMs].join(':')).join('|')]);
  const signature=stableClips.map(c=>[c.id,c.path,c.stream,c.offset,c.sourceStart,c.length,c.sourceDuration].join('/')).join('|');

  useEffect(()=>{
    let disposed=false;
    const timer=window.setTimeout(()=>{
      if(disposed||projectDurationMs<1||canvasWidth<1)return;
      const msPerPixel=projectDurationMs/canvasWidth;
      // A detail bin corresponds to ~one device pixel.
      const intervalMs=Math.max(1,Math.min(20,Math.floor(msPerPixel)));
      const desired=new Map<string,string>();
      if(intervalMs>=20){
        for(const request of live.current.values())
          void window.acl.request('task.cancel',{requestId:request}).catch(()=>{});
        live.current.clear();keys.current.clear();
        setCache({});
        return;
      }
      for(const clip of stableClips){
        const x0=clip.offset/msPerPixel;
        const x1=(clip.offset+clip.length)/msPerPixel;
        const viewportStart=Math.max(x0,scrollLeft);
        const viewportEnd=Math.min(x1,scrollLeft+viewportWidth);
        if(viewportStart>=viewportEnd)continue;
        const startSource=clip.sourceStart+(viewportStart-x0)*msPerPixel;
        const endSource=clip.sourceStart+(viewportEnd-x0)*msPerPixel;
        const margin=Math.min(12000,(endSource-startSource)*.2);
        const startMs=Math.max(0,Math.floor((startSource-margin)/250)*250);
        const endMs=Math.min(clip.sourceDuration,
          Math.ceil((endSource+margin)/250)*250);
        const durationMs=Math.ceil(Math.max(1,endMs-startMs));
        if(durationMs/intervalMs>4800)continue;
        const key=[clip.path,clip.stream,intervalMs,startMs,durationMs].join(':');
        desired.set(clip.id,key);
        if(keys.current.get(clip.id)===key)continue;
        const previous=live.current.get(clip.id);
        if(previous)void window.acl.request('task.cancel',{requestId:previous}).catch(()=>{});
        const requestId=crypto.randomUUID();
        live.current.set(clip.id,requestId);
        keys.current.set(clip.id,key);
        void window.acl.request<{peaks:[number,number][];startMs:number;intervalMs:number;cancelled?:boolean}>(
          'media.waveform.detail',
          {path:clip.path,stream:clip.stream,startMs,durationMs,intervalMs},requestId,
        ).then(response=>{
          if(disposed||response.cancelled||live.current.get(clip.id)!==requestId)return;
          setCache(old=>({...old,[clip.id]:{
            peaks:response.peaks,startMs:response.startMs,
            intervalMs:response.intervalMs,key,
          }}));
        }).catch(()=>{
          // The coarser overview remains available, even if FFmpeg fails.
          if(keys.current.get(clip.id)===key)keys.current.delete(clip.id);
        }).finally(()=>{
          if(live.current.get(clip.id)===requestId)live.current.delete(clip.id);
        });
      }
      for(const [id,request] of live.current){
        if(desired.has(id))continue;
        void window.acl.request('task.cancel',{requestId:request}).catch(()=>{});
        live.current.delete(id);keys.current.delete(id);
      }
    },180);
    return()=>{disposed=true;window.clearTimeout(timer)};
  },[signature,scrollLeft,viewportWidth,canvasWidth,projectDurationMs]);

  useEffect(()=>()=> {
    for(const request of live.current.values())
      void window.acl.request('task.cancel',{requestId:request}).catch(()=>{});
    live.current.clear();
  },[]);

  return cache;
}
