import type {EditorTrack} from './editor';
import {clipOffsetBounds} from './editor';

export const CLIP_COLORS=[
  '#57c5f3','#85bf5d','#b694f5','#f4b860',
  '#ef789d','#57d4b6','#f0d971','#8a9bff',
] as const;

/** Keep every selected clip in legal bounds without changing their spacing. */
export function groupMoveDelta(
  tracks:readonly EditorTrack[],
  originals:Readonly<Record<string,number>>,
  requestedDeltaMs:number,projectDurationMs:number,
):number{
  let lower=-Infinity,upper=Infinity,found=false;
  for(const track of tracks){
    if(!Object.prototype.hasOwnProperty.call(originals,track.id))continue;
    found=true;
    const bounds=clipOffsetBounds(projectDurationMs,track.durationMs);
    const start=originals[track.id];
    lower=Math.max(lower,bounds.min-start);
    upper=Math.min(upper,bounds.max-start);
  }
  if(!found||!Number.isFinite(requestedDeltaMs))return 0;
  return Math.round(Math.max(lower,Math.min(upper,requestedDeltaMs)));
}

export function moveClipGroup(
  tracks:EditorTrack[],
  originals:Readonly<Record<string,number>>,
  requestedDeltaMs:number,projectDurationMs:number,
):EditorTrack[]{
  const delta=groupMoveDelta(tracks,originals,requestedDeltaMs,projectDurationMs);
  let changed=false;
  const next=tracks.map(clip=>{
    if(!Object.prototype.hasOwnProperty.call(originals,clip.id))return clip;
    const offsetMs=Math.round(originals[clip.id]+delta);
    if(offsetMs===(clip.offsetMs||0))return clip;
    changed=true;
    return {...clip,offsetMs};
  });
  return changed?next:tracks;
}

/** Mute is a property of the clip, independent of the lane's mute switch. */
export function toggleClipDisabled(tracks:EditorTrack[],ids:readonly string[]):EditorTrack[]{
  const set=new Set(ids);
  const selected=tracks.filter(t=>set.has(t.id));
  if(!selected.length)return tracks;
  const disabled=selected.some(t=>!t.clipMuted);
  return tracks.map(t=>set.has(t.id)?{...t,clipMuted:disabled}:t);
}

/** Copies reference the original source file, so no extra WAV is created. */
export function duplicateSelectedClips(
  tracks:EditorTrack[],ids:readonly string[],projectDurationMs:number,
  createId:()=>string,shiftMs=250,
):{tracks:EditorTrack[];ids:string[]}{
  const wanted=new Set(ids);
  const selected=tracks.filter(t=>wanted.has(t.id));
  if(!selected.length)return {tracks,ids:[]};
  const originals=Object.fromEntries(selected.map(t=>[t.id,t.offsetMs||0]));
  const delta=groupMoveDelta(tracks,originals,shiftMs,projectDurationMs);
  const clonedIds:string[]=[];
  const clones=selected.map(clip=>{
    const id=createId();
    clonedIds.push(id);
    return {...clip,id,peaks:clip.peaks.slice(),
      kind:clip.kind==='original'?'import' as const:clip.kind,
      // A duplicate is its own lane and is silent until explicitly enabled.
      // This prevents stacking the same audio twice by accident.
      laneId:id,
      clipMuted:true,
      offsetMs:(clip.offsetMs||0)+delta,
      name:clip.name+' (копия)',
    };
  });
  return {tracks:tracks.concat(clones),ids:clonedIds};
}
