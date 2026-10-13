import type {EditorTrack} from './editor';
import {laneKey} from './editorOperations';

export type PlaybackChain={
  leaderId:string;
  segments:EditorTrack[];
  startMs:number;
  endMs:number;
};

/**
 * Adjacent cuts of one source must share a single media transport.
 *
 * Pausing an HTMLAudioElement and starting a new one at a splice inserts
 * unpredictable decoder startup latency (often tens of milliseconds).
 * Continuous source ranges instead stay on the first element; only
 * clip gain/fade metadata changes at the splice.
 */
export function continuousPlaybackChains(tracks:EditorTrack[]):PlaybackChain[]{
  const ordered=[...tracks].sort((a,b)=>
    laneKey(a).localeCompare(laneKey(b))||
    (a.offsetMs||0)-(b.offsetMs||0)||
    (a.sourceStartMs||0)-(b.sourceStartMs||0));
  const chains:PlaybackChain[]=[];
  for(const clip of ordered){
    const offset=clip.offsetMs||0;
    const sourceStart=clip.sourceStartMs||0;
    const prior=chains[chains.length-1];
    const last=prior?.segments[prior.segments.length-1];
    const joined=last&&laneKey(last)===laneKey(clip)&&
      last.path===clip.path&&(last.streamIndex||0)===(clip.streamIndex||0)&&
      Math.abs(prior.endMs-offset)<=1&&
      Math.abs((last.sourceStartMs||0)+last.durationMs-sourceStart)<=1;
    if(joined&&prior){
      prior.segments.push(clip);
      prior.endMs=offset+clip.durationMs;
    }else{
      chains.push({leaderId:clip.id,segments:[clip],
        startMs:offset,endMs:offset+clip.durationMs});
    }
  }
  return chains;
}

export function currentPlaybackSegment(chain:PlaybackChain,projectMs:number):EditorTrack|null{
  for(const clip of chain.segments){
    if(projectMs>=(clip.offsetMs||0)&&
       projectMs<(clip.offsetMs||0)+clip.durationMs)return clip;
  }
  return null;
}
