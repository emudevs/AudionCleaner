import type {EditorTrack} from './editor';
import type {LayoutState} from './useEditorLayout';

export const PROJECT_FORMAT='anime-audio-cleaner-project' as const;
export const PROJECT_VERSION=1 as const;
export type ProjectTrack=Omit<EditorTrack,'url'|'peaks'|'pending'|'error'|'fxOriginal'|'waveIntervalMs'> & {
  fxOriginal?:Omit<NonNullable<EditorTrack['fxOriginal']>,'url'|'peaks'|'waveIntervalMs'>;
};
export type ProjectSelection={startMs:number;endMs:number}|null;
export type ProjectPanels={settingsOpen:boolean;mixerOpen:boolean;previewOpen:boolean};
export type ProjectDocument={
  format:typeof PROJECT_FORMAT;
  version:typeof PROJECT_VERSION;
  media:{path:string;stream:number};
  tracks:ProjectTrack[];
  settings:Record<string,unknown>;
  positionMs:number;
  selection:ProjectSelection;
  ui:{layout:LayoutState;panels:ProjectPanels};
};

export function stripTrack(track:EditorTrack):ProjectTrack{
  const {url:_url,peaks:_peaks,pending:_pending,error:_error,
    waveIntervalMs:_waveBin,fxOriginal,...properties}=track;
  return {...properties,
    ...(fxOriginal?{fxOriginal:{
      path:fxOriginal.path,
      streamIndex:fxOriginal.streamIndex,
      sourceStartMs:fxOriginal.sourceStartMs,
      sourceDurationMs:fxOriginal.sourceDurationMs,
    }}:{})};
}

export function makeProjectDocument(
  mediaPath:string,stream:number,tracks:EditorTrack[],settings:Record<string,unknown>,
  positionMs:number,selection:ProjectSelection,
  layout:LayoutState,panels:ProjectPanels,
):ProjectDocument{
  return {
    format:PROJECT_FORMAT,version:PROJECT_VERSION,
    media:{path:mediaPath,stream},
    tracks:tracks.map(stripTrack),
    settings:{...settings},
    positionMs:Math.max(0,Math.round(positionMs)),
    selection:selection?{...selection}:null,
    ui:{layout:{...layout},panels:{...panels}},
  };
}

// Playhead changes every frame and must not spuriously mark the project dirty.
// Waveform caches, rendered URLs, error messages and transient progress are
// deliberately excluded from the persisted state.
export function projectEditSignature(doc:ProjectDocument):string{
  return JSON.stringify({media:doc.media,tracks:doc.tracks,
    settings:doc.settings,selection:doc.selection,ui:doc.ui});
}
