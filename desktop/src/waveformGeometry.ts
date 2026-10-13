/** Real time geometry for overview peaks. Never assume a fixed protocol version:
 * legacy ACL backends return 100 ms peak bins; current ones return 20 ms. */
export type PeakMetadata={intervalMs?:number;samples?:number}|null|undefined;

export function resolveWaveIntervalMs(
  metadata:PeakMetadata,
  durationMs:number,
  fallbackMs=20,
):number{
  const reported=Number(metadata?.intervalMs);
  if(Number.isFinite(reported)&&reported>=1&&reported<=1000)
    return reported;
  const samples=Number(metadata?.samples);
  if(Number.isFinite(samples)&&samples>0&&Number.isFinite(durationMs)&&durationMs>0){
    const inferred=Math.round(durationMs/samples);
    if(inferred>=1&&inferred<=1000)return inferred;
  }
  return fallbackMs;
}

export function waveformSliceRange(
  sourceStartMs:number,
  clipDurationMs:number,
  intervalMs:number,
):{from:number;to:number}{
  const bin=Number.isFinite(intervalMs)&&intervalMs>0?intervalMs:20;
  const from=Math.max(0,Math.floor(Math.max(0,sourceStartMs)/bin));
  const to=Math.max(from,Math.ceil((Math.max(0,sourceStartMs)+Math.max(0,clipDurationMs))/bin));
  return {from,to};
}
