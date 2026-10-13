import type {EditorTrack} from './editor';

export type SnapSelection={startMs:number;endMs:number}|null;
export type SnapBounds={min:number;max:number};
export type SnapResult={value:number;guideMs:number|null};

/**
 * Magnetic snapping uses a pixel threshold, but caps the time span so
 * zooming out cannot unexpectedly pull clips by several seconds.
 */
export function snapToleranceMs(pxPerMs:number):number{
  if(!Number.isFinite(pxPerMs)||pxPerMs<=0)return 0;
  return Math.max(1,Math.min(500,8/pxPerMs));
}

/** Candidate boundaries shared by move and trim operations. */
export function timelineSnapAnchors(
  tracks:readonly EditorTrack[],excludeId:string,projectDurationMs:number,
  playheadMs:number,selection:SnapSelection,
):number[]{
  const points=[0,projectDurationMs,playheadMs];
  if(selection)points.push(selection.startMs,selection.endMs);
  for(const clip of tracks){
    if(clip.id===excludeId)continue;
    const start=clip.offsetMs||0;
    points.push(start,start+clip.durationMs);
  }
  return [...new Set(points.filter(Number.isFinite).map(Math.round))];
}

/**
 * `offsets` are the dragged edges relative to `desired`.
 * Moving a clip checks [0, duration]; trimming checks [0].
 * A guide is only returned when a legal candidate is within tolerance.
 */
export function snapPosition(
  desired:number,anchors:readonly number[],offsets:readonly number[],
  toleranceMs:number,bounds:SnapBounds,
):SnapResult{
  const raw=Math.max(bounds.min,Math.min(bounds.max,desired));
  let bestDistance=Infinity;
  let result:SnapResult={value:raw,guideMs:null};
  if(!Number.isFinite(raw)||toleranceMs<=0)return result;
  for(const anchor of anchors){
    for(const offset of offsets){
      const candidate=anchor-offset;
      if(candidate<bounds.min||candidate>bounds.max)continue;
      const distance=Math.abs(candidate-raw);
      if(distance<=toleranceMs&&distance<bestDistance){
        bestDistance=distance;
        result={value:Math.round(candidate),guideMs:anchor};
      }
    }
  }
  return result;
}

/** Trimming may reveal hidden source audio but never reads outside its file. */
export function trimEdgeBounds(clip:EditorTrack,edge:'left'|'right'):SnapBounds{
  const offset=clip.offsetMs||0;
  const sourceStart=Math.max(0,clip.sourceStartMs||0);
  const sourceDuration=Math.max(sourceStart+clip.durationMs,clip.sourceDurationMs??0);
  if(edge==='left'){
    return {min:offset-sourceStart,max:offset+clip.durationMs-100};
  }
  return {min:offset+100,max:Math.max(offset+100,
    offset+sourceDuration-sourceStart)};
}
