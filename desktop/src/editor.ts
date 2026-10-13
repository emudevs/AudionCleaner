export type AudioStream = {
  index: number;
  codec: string;
  channels: number;
  language: string;
  title: string;
  bitrate?: string;
  durationMs?: number | null;
  startMs?: number | null;
};

export type MediaInfo = {
  path: string;
  name: string;
  hasVideo: boolean;
  durationMs: number;
  sizeBytes: number;
  video: {width: number; height: number; codec: string; frameRate: string} | null;
  audioStreams: AudioStream[];
};

export type EditorTrack = {
  id: string;
  name: string;
  path: string;
  url: string;
  kind: 'original' | 'clean' | 'import';
  durationMs: number;
  offsetMs?: number;
  /** Multiple clips with the same laneId occupy one editable track. */
  laneId?: string;
  /** Trim position inside the original audio source, in milliseconds. */
  sourceStartMs?: number;
  /** Full source media duration, preserved after splitting/trimming. */
  sourceDurationMs?: number;
  /** Source audio stream within container; 0 for generated WAV. */
  streamIndex?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  /** Curve tension -2..2, 0 = quarter-sine. */
  fadeInCurve?: number;
  fadeOutCurve?: number;
  /** Linear per-clip gain; track.gain belongs to the entire lane. */
  clipGain?: number;
  peaks: [number, number][];
  /** Actual duration of each overview peak; supplied by Python, not assumed. */
  waveIntervalMs?: number;
  fx?: boolean;
  fxSettings?: Record<string,unknown>;
  fxOriginal?: {path:string;url:string;streamIndex:number;
    sourceStartMs:number;sourceDurationMs:number;
    peaks:[number,number][];waveIntervalMs:number};
  pending: boolean;
  error?: string;
  muted: boolean;
  /** Silence this clip only, without muting its entire lane. */
  clipMuted?: boolean;
  /** Non-destructive per-clip label color, stored in .aclproj. */
  color?: string;
  solo: boolean;
  gain: number;
  pan: number;
  channels?: number;
};

/**
 * Clips may overhang both ends of the project. This is necessary for fixing
 * desynchronization even when a processed WAV spans the whole source video.
 */
export function clipOffsetBounds(durationMs:number,clipDurationMs:number){
  const overhang=Math.min(30000,Math.max(1000,durationMs));
  return {
    min:-overhang,
    max:Math.max(0,durationMs-clipDurationMs)+overhang,
  };
}

export function timecode(ms: number, rate = 25): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const frames = Math.floor((ms % 1000) / 1000 * rate);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(totalSeconds / 3600))}:${two(Math.floor(totalSeconds / 60) % 60)}:${two(totalSeconds % 60)}:${two(frames)}`;
}

export function fps(rate?: string): number {
  if (!rate) return 25;
  const [a, b = '1'] = rate.split('/');
  const computed = Number(a) / Number(b);
  return Number.isFinite(computed) && computed > 0 ? computed : 25;
}
