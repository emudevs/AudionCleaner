import type {EditorTrack} from './editor';

export const WAVE_BIN_MS=20;

export type AudioLane={id:string;name:string;kind:EditorTrack['kind'];clips:EditorTrack[]};
export const laneKey=(clip:EditorTrack)=>clip.laneId||clip.id;
export const editable=(_clip:EditorTrack)=>true;

export function groupLanes(clips:EditorTrack[]):AudioLane[]{
  const lanes:AudioLane[]=[];
  const index=new Map<string,AudioLane>();
  for(const clip of clips){
    const id=laneKey(clip);
    let lane=index.get(id);
    if(!lane){
      lane={id,name:clip.name,kind:clip.kind,clips:[]};
      index.set(id,lane);
      lanes.push(lane);
    }
    lane.clips.push(clip);
  }
  return lanes;
}

export function splitClipAt(clips:EditorTrack[],id:string,positionMs:number,newId:string):EditorTrack[]{
  const clip=clips.find(c=>c.id===id);
  if(!clip||!editable(clip))return clips;
  const relative=Math.round(positionMs-(clip.offsetMs||0));
  // At least 100 ms on each side, so both clips are playable/renderable.
  if(relative<100||clip.durationMs-relative<100)return clips;
  const sourceStart=clip.sourceStartMs||0;
  const cut=Math.round(relative/(clip.waveIntervalMs||WAVE_BIN_MS));
  const lhs:EditorTrack={
    ...clip,durationMs:relative,
    peaks:clip.peaks.slice(0,cut),
    fadeInMs:Math.min(clip.fadeInMs||0,relative),
    fadeOutMs:0,
  };
  const rhs:EditorTrack={
    ...clip,id:newId,laneId:laneKey(clip),
    offsetMs:(clip.offsetMs||0)+relative,
    sourceStartMs:sourceStart+relative,
    durationMs:clip.durationMs-relative,
    peaks:clip.peaks.slice(cut),
    fadeInMs:0,
    fadeOutMs:Math.min(clip.fadeOutMs||0,clip.durationMs-relative),
  };
  return clips.flatMap(c=>c.id===id?[lhs,rhs]:[c]);
}

export function trimClipEdge(
  clip:EditorTrack,
  edge:'left'|'right',
  deltaMs:number,
  sourcePeaks?:[number,number][],
):EditorTrack{
  if(!editable(clip)||!Number.isFinite(deltaMs))return clip;
  const minClipMs=100;
  const sourceDuration=Math.max(0,clip.sourceDurationMs??(clip.sourceStartMs||0)+clip.durationMs);
  const sourceStart=Math.max(0,clip.sourceStartMs||0);
  const length=clip.durationMs;
  const delta=Math.round(deltaMs);
  let start=sourceStart,offset=clip.offsetMs||0,duration=length;
  if(edge==='left'){
    const change=Math.max(-sourceStart,Math.min(length-minClipMs,delta));
    start=sourceStart+change;
    offset+=change;
    duration=length-change;
  }else{
    duration=Math.max(minClipMs,Math.min(sourceDuration-sourceStart,length+delta));
  }
  if(start===sourceStart&&duration===length)return clip;
  const peaks=sourcePeaks?sourcePeaks.slice(
    Math.max(0,Math.floor(start/(clip.waveIntervalMs||WAVE_BIN_MS))),
    Math.max(0,Math.ceil((start+duration)/(clip.waveIntervalMs||WAVE_BIN_MS)))
  ):clip.peaks;
  return {...clip,offsetMs:offset,sourceStartMs:start,durationMs:duration,
    fadeInMs:Math.min(clip.fadeInMs||0,duration),
    fadeOutMs:Math.min(clip.fadeOutMs||0,duration),peaks};
}

export function reorderLane(clips:EditorTrack[],movingId:string,targetId:string):EditorTrack[]{
  if(movingId===targetId)return clips;
  const lanes=groupLanes(clips);
  const from=lanes.findIndex(l=>l.id===movingId);
  const to=lanes.findIndex(l=>l.id===targetId);
  if(from<0||to<0||!editable(lanes[from].clips[0])||!editable(lanes[to].clips[0]))return clips;
  const [moving]=lanes.splice(from,1);
  lanes.splice(to,0,moving);
  return lanes.flatMap(l=>l.clips);
}

export function fadeGain(t:number,curve=0):number{
  const position=Math.max(0,Math.min(1,t));
  const tension=Math.max(-2,Math.min(2,curve));
  return Math.pow(Math.sin(position*Math.PI/2),Math.pow(2,tension));
}

export function sampleFade(clip:EditorTrack,projectTimeMs:number):number{
  const relative=projectTimeMs-(clip.offsetMs||0);
  if(relative<0||relative>=clip.durationMs)return 0;
  const fadeIn=Math.min(clip.fadeInMs||0,clip.durationMs);
  const fadeOut=Math.min(clip.fadeOutMs||0,clip.durationMs);
  const inGain=fadeIn>0?fadeGain(relative/fadeIn,clip.fadeInCurve):1;
  const outGain=fadeOut>0?fadeGain((clip.durationMs-relative)/fadeOut,clip.fadeOutCurve):1;
  return Math.max(0,Math.min(1,inGain*outGain));
}

/** The same quarter-sine curves are used by FFmpeg afade=curve=qsin. */
export function fadeCurvePath(fade:'in'|'out',width:number,height:number,curve=0):string{
  const segments=96;
  const parts:string[]=[];
  for(let i=0;i<=segments;i++){
    const t=i/segments;
    const gain=fadeGain(fade==='in'?t:1-t,curve);
    const x=t*width;
    const y=(1-gain)*height;
    parts.push((i?'L':'M')+x.toFixed(2)+' '+y.toFixed(2));
  }
  return parts.join(' ');
}
