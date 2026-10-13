import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {clipOffsetBounds} from './editor';
import {laneKey,reorderLane,splitClipAt,trimClipEdge,WAVE_BIN_MS} from './editorOperations';
import type {EditorTrack, MediaInfo} from './editor';
import {useAudioMixer} from './useAudioMixer';
import {resolveWaveIntervalMs,waveformSliceRange} from './waveformGeometry';
import {useTrackHistory} from './useTrackHistory';
import {moveClipGroup,toggleClipDisabled,duplicateSelectedClips} from './clipEditing';
import {continuousPlaybackChains,currentPlaybackSegment} from './audioTransport';
import type {ProjectDocument} from './projectFormat';

type Pick = {media: MediaInfo; url: string};
export function useEditor() {
  const [media,setMedia] = useState<MediaInfo|null>(null);
  const [mediaUrl,setMediaUrl] = useState('');
  const [thumbnail,setThumbnail] = useState('');
  const [unsupported,setUnsupported] = useState(false);
  const {tracks,setTracks,resetHistory,beginHistory,endHistory,undo,redo,canUndo,canRedo}=useTrackHistory();
  const clipboard=useRef<EditorTrack|null>(null);
  const [selectedClipId,setSelectedClipId]=useState<string|null>(null);
  const [settings,setSettings] = useState<Record<string,unknown>>({});
  const [postProfiles,setPostProfiles]=useState<Record<string,Record<string,unknown>>>({});
  const [stream,setStream] = useState(0);
  const [picker,setPicker] = useState<Pick|null>(null);
  const [busy,setBusy] = useState('');
  const [effectBusy,setEffectBusy]=useState(false);
  const [exportResult,setExportResult]=useState('');
  const [error,setError] = useState('');
  const [position,setPosition] = useState(0);
  const [selection,setSelectionState] = useState<{startMs:number;endMs:number}|null>(null);
  const selectionRef=useRef<{startMs:number;endMs:number}|null>(null);
  const [playing,setPlaying] = useState(false);
  const [progress,setProgress] = useState<{stage:string;percent:number}|null>(null);
  const [processId,setProcessId] = useState('');
  const session = useRef(0);
  const scrubbing = useRef(false);
  const resumeAfterScrub = useRef(false);
  const lastPhysicalSeek = useRef(0);
  const dragPosition = useRef(0);
  const activeProcessId = useRef('');
  const cancelledProcessIds=useRef(new Set<string>());
  const dirtySettings = useRef(false);
  const [processLog,setProcessLog] = useState<string[]>([]);
  const [processElapsed,setProcessElapsed] = useState(0);
  const [cancelling,setCancelling] = useState(false);
  const [cancelWaiting,setCancelWaiting]=useState(0);
  const processStarted=useRef(0);
  const lastBackendResponse=useRef(0);
  const warnedUnresponsive=useRef(false);
  const cancellationStarted=useRef(0);
  const waveformRequests = useRef(new Map<string,string>());
  const wavePending=useRef(new Map<string,[number,number][]>()); 
  const waveCache=useRef(new Map<string,{
    path:string;streamIndex:number;laneId:string;intervalMs:number;peaks:[number,number][];
  }>());
  const waveTimer=useRef<number|null>(null);
  const grantedMedia = useRef(new Set<string>());
  const tracksRef = useRef<EditorTrack[]>([]);
  const originalElement = useRef<HTMLMediaElement|null>(null);
  const processedElements = useRef(new Map<string,HTMLAudioElement>());
  const mixer = useAudioMixer();
  selectionRef.current=selection;
  const setSelection=useCallback((range:{startMs:number;endMs:number}|null)=>{
    setSelectionState(range);
    selectionRef.current=range;
  },[]);
  tracksRef.current = tracks;
  const playbackChains=useMemo(()=>continuousPlaybackChains(tracks),[tracks]);
  const playbackChainsRef=useRef(playbackChains);
  playbackChainsRef.current=playbackChains;
  useEffect(()=>()=>{
    // An HMR unmount or project teardown must never leave an audio element
    // playing outside syncProcessed / the mixer.
    originalElement.current?.pause();
    for(const element of processedElements.current.values())element.pause();
    if(waveTimer.current!==null)window.clearTimeout(waveTimer.current);
    wavePending.current.clear();
    waveCache.current.clear();
    for(const url of grantedMedia.current)void window.acl.releaseMedia(url);
    grantedMedia.current.clear();
    for(const requestId of waveformRequests.current.keys())
      void window.acl.request('task.cancel',{requestId}).catch(()=>{});
  },[]);

  const flushWaves=useCallback(()=>{
    waveTimer.current=null;
    const collected=wavePending.current;
    if(!collected.size)return;
    wavePending.current=new Map();
    for(const [id,chunk] of collected){
      const source=waveCache.current.get(id);
      if(source)source.peaks.push(...chunk);
    }
    setTracks(previous=>previous.map(track=>{
      const source=[...waveCache.current.values()].find(item=>
        item.path===track.path&&
        item.streamIndex===(track.streamIndex??0));
      if(!source)return track;
      const interval=source.intervalMs;
      const {from,to}=waveformSliceRange(track.sourceStartMs||0,track.durationMs,interval);
      return {...track,waveIntervalMs:interval,peaks:source.peaks.slice(from,to)};
    }),false);
  },[]);
  const updateTrack = useCallback((id:string,patch:Partial<EditorTrack>)=>{
    setTracks(previous=>{
      const owner=previous.find(track=>track.id===id);
      if(!owner)return previous;
      const lane=laneKey(owner);
      const shared=['name','gain','pan','muted','solo'] as const;
      return previous.map(track=>{
        if(laneKey(track)!==lane)return track;
        const sharedPatch:Partial<EditorTrack>={};
        for(const key of shared){
          if(key in patch){
            // TS narrows sharedPatch[key] to never for correlated unions.
            Object.assign(sharedPatch,{[key]:patch[key]});
          }
        }
        return {...track,...sharedPatch,...(track.id===id?patch:{})};
      });
    });
  },[]);
  const trimClip=useCallback((id:string,edge:'left'|'right',deltaMs:number)=>{
    setTracks(previous=>previous.map(clip=>{
      if(clip.id!==id)return clip;
      const cache=[...waveCache.current.values()].find(item=>
        item.laneId===laneKey(clip)&&item.path===clip.path&&
        item.streamIndex===(clip.streamIndex??0));
      return trimClipEdge(clip,edge,deltaMs,cache?.peaks);
    }));
  },[]);
  const splitAll=useCallback((atMs:number)=>{
    // One state transition gives a single Ctrl+Z for the entire vertical cut.
    const ids=new Map(tracksRef.current.map(track=>[track.id,crypto.randomUUID()]));
    setTracks(previous=>previous.reduce<EditorTrack[]>((result,clip)=>{
      const pieces=splitClipAt([clip],clip.id,atMs,ids.get(clip.id)!);
      return result.concat(pieces);
    },[]));
  },[setTracks]);
  const [hasClipboard,setHasClipboard]=useState(false);
  const copyClip=useCallback((id:string)=>{
    const clip=tracksRef.current.find(t=>t.id===id);
    if(clip){clipboard.current={...clip,peaks:clip.peaks.slice()};setHasClipboard(true);}
  },[]);
  const cutClip=useCallback((id:string)=>{
    const clip=tracksRef.current.find(t=>t.id===id);
    if(!clip)return;
    clipboard.current={...clip,peaks:clip.peaks.slice()};
    setHasClipboard(true);
    setTracks(previous=>previous.filter(t=>t.id!==id));
    setSelectedClipId(null);
  },[setTracks]);
  const pasteClip=useCallback((atMs:number)=>{
    const old=clipboard.current;
    if(!old||!media)return;
    const id=crypto.randomUUID();
    const originalLaneExists=tracksRef.current.some(t=>laneKey(t)===laneKey(old));
    const clone:EditorTrack={...old,id,
      name:old.kind==='original'?'Original (копия)':old.name,
      kind:old.kind==='original'?'import':old.kind,
      laneId:old.kind==='original'?id:originalLaneExists?laneKey(old):id,
      offsetMs:Math.max(0,Math.round(atMs)),
      peaks:old.peaks.slice(),
    };
    setTracks(previous=>previous.concat(clone));
    setSelectedClipId(id);
  },[media,setTracks]);
  const removeClips=useCallback((ids:string[])=>{
    const remove=new Set(ids);
    for(const clip of tracksRef.current){
      if(remove.has(clip.id))processedElements.current.get(clip.id)?.pause();
    }
    setTracks(previous=>previous.filter(t=>!remove.has(t.id)));
    setSelectedClipId(null);
  },[setTracks]);
  const splitClip=useCallback((id:string,atMs:number)=>{
    setTracks(previous=>splitClipAt(previous,id,atMs,crypto.randomUUID()));
  },[]);
  const renameLane=useCallback((laneId:string,name:string)=>{
    const value=name.trim().slice(0,100);
    if(!value)return;
    setTracks(previous=>previous.map(track=>
      laneKey(track)===laneId?{...track,name:value}:track));
  },[]);
  const moveLane=useCallback((from:string,to:string)=>
    setTracks(previous=>reorderLane(previous,from,to)),[]);
  const removeLane=useCallback((laneId:string)=>{
    const clips=tracksRef.current.filter(track=>laneKey(track)===laneId);
    for(const clip of clips){
      processedElements.current.get(clip.id)?.pause();
      for(const [requestId,trackId] of waveformRequests.current){
        if(trackId===clip.id){
          void window.acl.request('task.cancel',{requestId}).catch(()=>{});
          waveformRequests.current.delete(requestId);
        }
      }
      wavePending.current.delete(clip.id);
    }
    for(const [sourceId,cache] of waveCache.current){
      if(cache.laneId===laneId)waveCache.current.delete(sourceId);
    }
    const remaining=tracksRef.current.filter(track=>laneKey(track)!==laneId);
    // URLs are retained for Undo/Redo until the project is replaced.
    void remaining;
    setTracks(previous=>previous.filter(track=>laneKey(track)!==laneId));
  },[]);
  const toggleTrackMute=useCallback((id:string)=>{
    setTracks(previous=>{
      const current=previous.find(track=>track.id===id);
      if(!current)return previous;
      const next=!current.muted;
      return previous.map(track=>laneKey(track)===laneKey(current)?
        {...track,muted:next}:track);
    });
  },[]);
  // Clips are non-destructively positioned relative to the source video.
  // Moving a clip changes neither the generated WAV nor its local audio time.
  const moveClips=useCallback((originals:Record<string,number>,deltaMs:number)=>{
    if(!media)return;
    setTracks(previous=>moveClipGroup(previous,originals,deltaMs,media.durationMs));
  },[media,setTracks]);
  const toggleClipsDisabled=useCallback((ids:string[])=>{
    setTracks(previous=>toggleClipDisabled(previous,ids));
  },[setTracks]);
  const colorClips=useCallback((ids:string[],color:string)=>{
    if(!/^#[0-9a-f]{6}$/i.test(color))return;
    const selected=new Set(ids);
    setTracks(previous=>previous.map(clip=>selected.has(clip.id)?{...clip,color}:clip));
  },[setTracks]);
  const duplicateClips=useCallback((ids:string[])=>{
    if(!media)return [];
    const copies=duplicateSelectedClips(tracksRef.current,ids,media.durationMs,()=>crypto.randomUUID());
    if(copies.ids.length){
      setTracks(previous=>previous.concat(copies.tracks.slice(tracksRef.current.length)));
      setSelectedClipId(copies.ids[0]);
    }
    return copies.ids;
  },[media,setTracks]);
  const moveClip=useCallback((id:string,offsetMs:number)=>{
    setTracks(previous=>previous.map(track=>{
      if(track.id!==id||!media)return track;
      const bounds=clipOffsetBounds(media.durationMs,track.durationMs);
      const next=Math.max(bounds.min,Math.min(bounds.max,Math.round(offsetMs)));
      return next===track.offsetMs?track:{...track,offsetMs:next};
    }));
  },[media]);
  useEffect(() => {mixer.apply(tracks)},[tracks,mixer.apply]);

  useEffect(() => {
    const unsub = window.acl.onEvent(message => {
      if (message.requestId && message.requestId === activeProcessId.current)
        lastBackendResponse.current=Date.now();
      if (message.event === 'waveform.chunk' && message.requestId && message.peaks) {
        const id = waveformRequests.current.get(message.requestId);
        if(id){
          const pending=wavePending.current.get(id)||[];
          pending.push(...message.peaks);
          wavePending.current.set(id,pending);
          if(waveTimer.current===null)
            waveTimer.current=window.setTimeout(flushWaves,180);
        }
      }
      if (message.event === 'process.progress' && message.requestId === activeProcessId.current)
        setProgress({stage:message.stage||'',percent:message.percent||0});
      if (message.event === 'process.log' && message.requestId === activeProcessId.current && message.message) {
        const readable=message.message.replace(/\uFFFD/g,'').replace(/[\u0000-\u001f]/g,' ').trim();
        if(readable) setProcessLog(lines=>[...lines.slice(-39),readable.slice(0,350)]);
      }
      if (message.event === 'process.heartbeat' && message.requestId === activeProcessId.current) {
        setProcessElapsed(Number((message as AclEvent & {elapsed?:number}).elapsed)||0);
      }
      if(message.event==='backend.log' && activeProcessId.current && message.message)
        setProcessLog(lines=>[...lines.slice(-39),'Python stderr: '+message.message!.slice(-350)]);
      if (message.event === 'backend.error') setError(message.message||'Ошибка Python');
    });
    void window.acl.request<Record<string,unknown>>('settings.get').then(setSettings).catch(e=>setError(String(e)));
    void window.acl.request<Record<string,Record<string,unknown>>>('settings.profiles')
      .then(setPostProfiles).catch(()=>{});
    return unsub;
  },[flushWaves]);

  useEffect(()=>{
    if(!processId)return;
    const clock=window.setInterval(()=>{
      if(processStarted.current)
        setProcessElapsed(Math.floor((Date.now()-processStarted.current)/1000));
      if(cancellationStarted.current)
        setCancelWaiting(Math.floor((Date.now()-cancellationStarted.current)/1000));
      if(lastBackendResponse.current && Date.now()-lastBackendResponse.current>12000 &&
         !warnedUnresponsive.current){
        warnedUnresponsive.current=true;
        setProcessLog(lines=>[...lines.slice(-39),
          'Нет ответа от Python более 12 секунд. Возможно, инициализация модели зависла.']);
      }
    },1000);
    return()=>window.clearInterval(clock);
  },[processId]);

  const loadWave = useCallback((id:string,path:string,streamIndex:number,durationHintMs=0) => {
    const requestId=crypto.randomUUID();
    const runSession=session.current;
    waveCache.current.set(id,{path,streamIndex,laneId:id,intervalMs:WAVE_BIN_MS,peaks:[]});
    waveformRequests.current.set(requestId,id);
    void window.acl.request<{
      intervalMs?:number;samples?:number;peaks?:[number,number][];cancelled?:boolean
    }>(
      'media.waveform',{path,stream:streamIndex,durationMs:durationHintMs},requestId)
      .then(result => {
        if(session.current!==runSession||result.cancelled)return;
        const source=waveCache.current.get(id);
        if(source){
          // Older Python backends emit 100 ms bins. Newer ones emit 20 ms.
          // The interval is part of the decoder response, not a frontend
          // constant; misreading it made 80% of the clip look like silence.
          const owner=tracksRef.current.find(t=>t.path===path&& (t.streamIndex??0)===streamIndex);
          source.intervalMs=resolveWaveIntervalMs(result,
            owner?.sourceDurationMs||owner?.durationMs||0,source.intervalMs);
        }
        if(waveTimer.current!==null){
          window.clearTimeout(waveTimer.current);
          waveTimer.current=null;
        }
        // Streaming events and the IPC request result can arrive out of
        // order. The completed response is the source of truth, preventing
        // a 3.2-second first batch from being mistaken for a full overview.
        flushWaves();
        if(source&&Array.isArray(result.peaks)&&result.peaks.length){
          source.peaks=result.peaks;
          wavePending.current.delete(id);
        }
        setTracks(previous=>previous.map(track=>{
          if(track.path!==path||(track.streamIndex??0)!==streamIndex)return track;
          const cached=waveCache.current.get(id);
          if(!cached)return {...track,pending:false};
          const interval=cached.intervalMs;
          const {from:first,to:last}=waveformSliceRange(track.sourceStartMs||0,track.durationMs,interval);
          return {...track,pending:false,waveIntervalMs:interval,
            peaks:cached.peaks.slice(first,last)};
        }),false);
      })
      .catch(e => {
        if(session.current===runSession)setTracks(previous=>previous.map(track=>
          laneKey(track)===id?{...track,pending:false,error:String(e)}:track),false);
      })
      .finally(()=>waveformRequests.current.delete(requestId));
  },[flushWaves]);

  const activateFile = useCallback((pick:Pick,streamIndex:number) => {
    const version=++session.current;
    wavePending.current.clear();
    waveCache.current.clear();
    if(waveTimer.current!==null){
      window.clearTimeout(waveTimer.current);
      waveTimer.current=null;
    }
    for(const url of grantedMedia.current){
      if(url!==pick.url){
        void window.acl.releaseMedia(url).catch(()=>{});
        grantedMedia.current.delete(url);
      }
    }
    grantedMedia.current.add(pick.url);
    for (const requestId of waveformRequests.current.keys()) {
      void window.acl.request('task.cancel',{requestId});
    }
    waveformRequests.current.clear();
    for (const element of processedElements.current.values()) element.pause();
    setMedia(pick.media);setMediaUrl(pick.url);setStream(streamIndex);
    setPosition(0);setSelection(null);setPlaying(false);setThumbnail('');setUnsupported(false);setError('');
    const audioInfo=pick.media.audioStreams.find(s=>s.index===streamIndex);
    // A container/video can outlast its audio stream. Draw Original to the
    // real audio endpoint rather than presenting absent audio as a flat wave.
    const reported=audioInfo?.durationMs;
    const originalDuration=reported&&Number.isFinite(reported)&&reported>0
      ?Math.min(pick.media.durationMs,reported)
      :pick.media.durationMs;
    resetHistory([{id:'original',name:'Original',path:pick.media.path,url:pick.url,
      kind:'original',laneId:'original',streamIndex,sourceStartMs:0,fadeInMs:0,fadeOutMs:0,clipGain:1,
      sourceDurationMs:originalDuration,durationMs:originalDuration,peaks:[],pending:true,
      muted:false,solo:false,gain:.9,pan:0,
      channels:audioInfo?.channels||2}]);
    if(pick.media.hasVideo) {
      void window.acl.request<{dataUrl:string}>('media.thumbnail',{path:pick.media.path,atMs:0})
        .then(result=>{if(session.current===version)setThumbnail(result.dataUrl)})
        .catch(e=>{if(session.current===version)setError('Кадр: '+String(e))});
    }
    loadWave('original',pick.media.path,streamIndex,originalDuration);
    setPicker(null);
  },[loadWave]);

  const openPath = useCallback(async (entry?:{path:string;url:string}|null, asAudio=false) => {
    const source=entry===undefined ? await window.acl.openMedia() : entry;
    if(!source)return;
    grantedMedia.current.add(source.url);
    setBusy('Чтение медиафайла…');setError('');
    try {
      const info=await window.acl.request<MediaInfo>('media.inspect',{path:source.path});
      if(!info.audioStreams.length)throw Error('Аудиодорожки не найдены');
      if(asAudio && media) {
        const id=crypto.randomUUID();
        setTracks(previous=>previous.concat({id,name:info.name,path:info.path,url:source.url,
          kind:'import',laneId:id,streamIndex:info.audioStreams[0].index,sourceStartMs:0,
           fadeInMs:0,fadeOutMs:0,clipGain:1,sourceDurationMs:info.durationMs,durationMs:info.durationMs,peaks:[],pending:true,
          muted:false,solo:false,gain:.9,pan:0,channels:info.audioStreams[0].channels||2}));
        loadWave(id,info.path,info.audioStreams[0].index,info.durationMs);
      } else if(info.audioStreams.length>1) setPicker({media:info,url:source.url});
      else activateFile({media:info,url:source.url},info.audioStreams[0].index);
    } catch(e) {
      grantedMedia.current.delete(source.url);
      void window.acl.releaseMedia(source.url).catch(()=>{});
      setError(String(e));
    } finally {setBusy('')}
  },[activateFile,loadWave,media]);

  useEffect(()=>{
    if(!dirtySettings.current)return;
    dirtySettings.current=false;
    const timer=window.setTimeout(()=>{
      void window.acl.request('settings.save',{settings}).catch(e=>setError('Настройки: '+String(e)));
    },550);
    return()=>window.clearTimeout(timer);
  },[settings]);

  const dismissPicker=useCallback(()=>{
    if(picker){
      grantedMedia.current.delete(picker.url);
      void window.acl.releaseMedia(picker.url).catch(()=>{});
    }
    setPicker(null);
  },[picker]);

  const startProcessing=useCallback(async()=>{
    if(!media||processId)return;
    const id=crypto.randomUUID();
    activeProcessId.current=id;
    processStarted.current=Date.now();
    lastBackendResponse.current=Date.now();
    warnedUnresponsive.current=false;
    cancellationStarted.current=0;
    setCancelWaiting(0);
    setProcessLog([]);
    setProcessElapsed(0);
    setCancelling(false);
    setProcessId(id);setProgress({stage:'Запуск обработчика',percent:0});setError('');
    try {
      // During Vite HMR the UI may be newer than the already running Python
      // service. An older service has no process.preflight endpoint; keep
      // processing possible until Electron itself is restarted.
      try {
        const readiness=await window.acl.request<{
          ok:boolean;errors:string[];warnings:string[];python:string;modelFilesSeen:number;
        }>('process.preflight',{settings});
        if(!readiness.ok)throw Error(readiness.errors.join('\n'));
        setProcessLog(lines=>[...lines,
          'Python: '+readiness.python,
          'Проверка зависимостей пройдена.',
          ...(readiness.warnings||[]).map(w=>'Предупреждение: '+w)
        ]);
      } catch(preflightError) {
        const message=String(preflightError);
        const legacy=/Неизвестный метод:\s*process\.preflight|unknown method:\s*process\.preflight/i.test(message);
        if(!legacy)throw preflightError;
        setProcessLog(lines=>[...lines,
          'Python запущен со старой версией API: предварительная проверка недоступна.',
          'Очистка будет запущена без preflight. Для диагностики зависимостей перезапусти Electron.'
        ]);
      }
      if(cancelledProcessIds.current.has(id))throw Error('Обработка отменена.');
      const output=await window.acl.request<{path:string;name:string}>('process.start',
        {path:media.path,stream,settings,
          ...(selection?{rangeStartMs:Math.round(selection.startMs),
            rangeEndMs:Math.round(selection.endMs)}:{})},id);
      const url=await window.acl.registerMedia(output.path);
      grantedMedia.current.add(url);
      const trackId=crypto.randomUUID();
      setTracks(previous=>previous.concat({id:trackId,name:previous.some(t=>t.kind==='clean') ?
        'Clean '+(previous.filter(t=>t.kind==='clean').length+1):'Clean',
        path:output.path,url,kind:'clean',laneId:trackId,streamIndex:0,
        sourceStartMs:0,fadeInMs:0,fadeOutMs:0,clipGain:1,
        sourceDurationMs:selection?selection.endMs-selection.startMs:media.durationMs,
        offsetMs:selection?.startMs||0,
        durationMs:selection?selection.endMs-selection.startMs:media.durationMs,
        peaks:[],pending:true,
        muted:false,solo:false,gain:.9,pan:0,channels:2}));
      loadWave(trackId,output.path,0,selection?selection.endMs-selection.startMs:media.durationMs);
    } catch(e){
      if(!cancelledProcessIds.current.has(id))setError(String(e));
    }
    finally{
      cancelledProcessIds.current.delete(id);
      activeProcessId.current='';
      processStarted.current=0;
      cancellationStarted.current=0;
      setProcessId('');setProgress(null);setCancelling(false);setCancelWaiting(0);
    }
  },[media,processId,settings,stream,loadWave,selection]);

  const exportAudio=useCallback(async()=>{
    if(!media||!tracks.length||processId||busy)return;
    const name=media.name.replace(/\.[^.]+$/,'')+'_mix.wav';
    try{
      const target=await window.acl.saveAudio(name);
      if(!target)return;
      setBusy('Экспорт аудиомикса…');
      setError('');setExportResult('');
      const inputTracks=tracks.map(t=>({
        path:t.path,streamIndex:t.streamIndex??0,
        offsetMs:t.offsetMs||0,sourceStartMs:t.sourceStartMs||0,
        durationMs:t.durationMs,fadeInMs:t.fadeInMs||0,
        fadeOutMs:t.fadeOutMs||0,fadeInCurve:t.fadeInCurve||0,
        fadeOutCurve:t.fadeOutCurve||0,gain:t.gain,clipGain:t.clipGain??1,
        pan:t.pan,muted:t.muted||t.clipMuted||mixer.globalMuted,solo:t.solo,
      }));
      const result=await window.acl.request<{path:string;bytes:number}>('audio.export',{
        path:media.path,target,durationMs:media.durationMs,tracks:inputTracks,
      });
      setExportResult('Микс сохранён: '+result.path);
    }catch(error){
      setError('Ошибка экспорта: '+String(error));
    }finally{setBusy('')}
  },[media,tracks,processId,busy,mixer.globalMuted]);

  const cancelProcessing=useCallback(()=>{
    if(!processId)return;
    cancelledProcessIds.current.add(processId);
    cancellationStarted.current=Date.now();
    setCancelWaiting(0);
    setCancelling(true);
    setProgress(old=>({stage:'Остановка обработки',percent:old?.percent||0}));
    void window.acl.request('task.cancel',{requestId:processId})
      .then(()=>setProcessLog(lines=>[...lines.slice(-39),'Отмена запрошена. Завершаются дочерние процессы…']))
      .catch(e=>{setCancelling(false);setError('Отмена: '+String(e))});
  },[processId]);

  const forceStopProcessing=useCallback(()=>{
    if(!processId)return;
    setProcessLog(lines=>[...lines.slice(-39),'Принудительное завершение зависшего обработчика…']);
    void window.acl.forceStopBackend()
      .catch(e=>setError('Принудительная остановка: '+String(e)));
  },[processId]);

  // Each processed clip uses media-local time. The project playhead is an
  // absolute position; partial Clean clips must not play before/after their
  // own range or incorrectly jump to the beginning of the video.
  const syncProcessed=useCallback((projectMs:number,shouldPlay:boolean)=>{
    const chains=playbackChainsRef.current;
    const leaders=new Set(chains.map(chain=>chain.leaderId));
    const overrides=new Map<string,EditorTrack>();
    // Transfer all adjustable properties of the current segment onto the
    // group's first player. The underlying decoded stream keeps running.
    for(const chain of chains){
      const active=currentPlaybackSegment(chain,projectMs);
      if(active){
        const first=chain.segments[0];
        overrides.set(chain.leaderId,{...active,id:chain.leaderId,
          channels:first.channels||active.channels});
      }
    }
    mixer.apply(tracksRef.current.map(track=>overrides.get(track.id)||track));
    mixer.updateEnvelope(projectMs);
    for(const [id,element] of processedElements.current){
      if(!leaders.has(id)){
        // Follower clip: no extra HTMLAudioElement startup at the cut.
        if(!element.paused)element.pause();
        continue;
      }
      const chain=chains.find(group=>group.leaderId===id);
      const active=chain&&currentPlaybackSegment(chain,projectMs);
      if(!active){
        if(!element.paused)element.pause();
        continue;
      }
      const sourceMs=projectMs-(active.offsetMs||0)+(active.sourceStartMs||0);
      if(Math.abs(element.currentTime*1000-sourceMs)>90)
        element.currentTime=Math.max(0,sourceMs/1000);
      // A muted clip must stop its media element, not just its WebAudio
      // gain node. Otherwise a detached/recreated element may stay audible.
      const soloActive=tracksRef.current.some(track=>track.solo);
      const audible=shouldPlay&&!mixer.globalMuted&&!active.muted&&!active.clipMuted&&
        (!soloActive||active.solo);
      if(audible&&element.paused&&element.readyState>=HTMLMediaElement.HAVE_CURRENT_DATA)
        void element.play().catch(()=>{});
      else if(!audible&&!element.paused)element.pause();
    }
  },[mixer.apply,mixer.updateEnvelope,mixer.globalMuted]);

  const seek=useCallback((milliseconds:number)=>{
    if(!media)return;
    const clamped=Math.min(media.durationMs,Math.max(0,Math.round(milliseconds)));
    dragPosition.current=clamped;
    setPosition(clamped);
    const now=performance.now();
    if(scrubbing.current && now-lastPhysicalSeek.current<85)return;
    lastPhysicalSeek.current=now;
    const element=originalElement.current;
    if(element&&Math.abs(element.currentTime*1000-clamped)>25)
      element.currentTime=clamped/1000;
    syncProcessed(clamped,!!element&&!element.paused&&!scrubbing.current);
  },[media,syncProcessed]);

  const scrubStart=useCallback(()=>{
    if(scrubbing.current)return;
    scrubbing.current=true;
    const element=originalElement.current;
    resumeAfterScrub.current=!!element&&!element.paused;
    element?.pause();
    syncProcessed(dragPosition.current,false);
    setPlaying(false);
  },[syncProcessed]);
  const scrubEnd=useCallback(()=>{
    if(!scrubbing.current)return;
    scrubbing.current=false;
    const element=originalElement.current;
    if(element)element.currentTime=dragPosition.current/1000;
    syncProcessed(dragPosition.current,false);
    if(resumeAfterScrub.current&&element){
      void mixer.activate().then(async()=>{
        await element.play();
        syncProcessed(element.currentTime*1000,true);
        setPlaying(true);
      }).catch(e=>setError(String(e)));
    }
    resumeAfterScrub.current=false;
  },[mixer.activate,syncProcessed]);

  const setOriginalElement=useCallback((element:HTMLMediaElement|null)=>{
    if(originalElement.current&&originalElement.current!==element)
      originalElement.current.pause();
    originalElement.current=element;
    // Video is a silent clock/image source. Original audio is routed through
    // its own HTMLAudioElements so trims/cuts/fades can be applied per clip.
    if(element)element.muted=true;
  },[]);

  const setProcessedElement=useCallback((id:string,element:HTMLAudioElement|null)=>{
    if(element) processedElements.current.set(id,element);
    else{
      processedElements.current.get(id)?.pause();
      processedElements.current.delete(id);
    }
    mixer.attach(id,element);
  },[mixer.attach]);

  const pauseAll=useCallback(()=>{
    for(const element of processedElements.current.values())element.pause();
    setPlaying(false);
  },[]);

  const togglePlay=useCallback(async()=>{
    const element=originalElement.current;
    if(!element)return;
    try{
      await mixer.activate();
      if(!element.paused){
        element.pause();pauseAll();
      }else{
        const range=selectionRef.current;
        if(range&&(element.currentTime*1000<range.startMs||
           element.currentTime*1000>=range.endMs-25)){
          element.currentTime=range.startMs/1000;
          setPosition(range.startMs);
          dragPosition.current=range.startMs;
        }
        await element.play();
        syncProcessed(element.currentTime*1000,true);
        setPlaying(true);
      }
    }catch(e){setError('Воспроизведение: '+String(e));setPlaying(false)}
  },[mixer.activate,pauseAll,syncProcessed]);

  const updatePosition=useCallback((milliseconds:number)=>{
    if(scrubbing.current)return;
    const element=originalElement.current;
    const range=selectionRef.current;
    if(range&&element&&!element.paused&&
       (milliseconds>=range.endMs-15||milliseconds<range.startMs-15)){
      element.currentTime=range.startMs/1000;
      setPosition(range.startMs);
      dragPosition.current=range.startMs;
      syncProcessed(range.startMs,true);
      return;
    }
    setPosition(milliseconds);
    syncProcessed(milliseconds,!!element&&!element.paused);
  },[syncProcessed]);

  useEffect(()=>{
    if(!playing)return;
    let frame=0,last=0;
    const tick=(time:number)=>{
      const element=originalElement.current;
      if(element && !scrubbing.current && time-last>35){
        updatePosition(element.currentTime*1000);
        last=time;
      }
      frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(frame);
  },[playing,updatePosition]);

  const removeTrack=useCallback((id:string)=>{
    const element=processedElements.current.get(id);if(element)element.pause();
    const removed=tracksRef.current.find(track=>track.id===id);
    if(!removed)return;
    const siblings=tracksRef.current.some(track=>
      track.id!==id&&laneKey(track)===laneKey(removed));
    // A waveform request belongs to the source lane, not one slice of it.
    // Keep the decode running while any sibling of a split clip remains.
    if(!siblings){
      for(const [requestId,trackId] of waveformRequests.current){
        if(trackId===id){
          void window.acl.request('task.cancel',{requestId}).catch(()=>{});
          waveformRequests.current.delete(requestId);
        }
      }
      wavePending.current.delete(id);
      for(const [sourceId,cache] of waveCache.current){
        if(cache.laneId===laneKey(removed))waveCache.current.delete(sourceId);
      }
    }
    // Keep file URLs registered while undo/redo may restore a deleted clip.
    // Release them on project replacement or editor unmount.
    setTracks(previous=>previous.filter(t=>t.id!==id));
  },[]);

  const applyLaneEffects=useCallback(async(
    laneId:string,values:Record<string,unknown>,clipId?:string
  )=>{
    const group=tracksRef.current.filter(t=>laneKey(t)===laneId&&
      (!clipId||t.id===clipId));
    if(!group.length||effectBusy||processId)return;
    const runSession=session.current;
    setEffectBusy(true);
    setError('');
    try{
      // A hot-reloaded Vite UI can outlive its Python backend. An old
      // backend accepts system.hello but does not know audio.effects.
      type Hello={features?:string[]};
      let hello=await window.acl.request<Hello>('system.hello');
      if(!hello.features?.includes('audio.effects')){
        try{await window.acl.restartBackend()}
        catch(e){
          throw new Error('Запущена устаревшая версия Python. Заверши фоновые задачи и полностью перезапусти ACL: '+String(e));
        }
        hello=await window.acl.request<Hello>('system.hello');
        if(!hello.features?.includes('audio.effects'))
          throw new Error('Python всё ещё не поддерживает audio.effects. Полностью перезапусти приложение.');
      }
      const rendered:{id:string;path:string;url:string}[]=[];
      for(const clip of group){
        const result=await window.acl.request<{path:string;filters:string[]}>('audio.effects',{
          path:clip.path,stream:clip.streamIndex??0,settings:values,
          startMs:clip.sourceStartMs||0,durationMs:clip.durationMs,
          originalPath:media?.path,originalStream:stream,
          originalOffsetMs:Math.max(0,clip.offsetMs||0),
        });
        const url=await window.acl.registerMedia(result.path);
        grantedMedia.current.add(url);
        rendered.push({id:clip.id,path:result.path,url});
      }
      if(session.current!==runSession)return;
      const now=tracksRef.current;
      if(group.some(old=>!now.some(t=>t.id===old.id&&
         t.path===old.path&&t.sourceStartMs===old.sourceStartMs&&
         t.durationMs===old.durationMs)))
        throw new Error('Монтаж изменился во время обработки. Результат не применён.');
      const byId=new Map(rendered.map(item=>[item.id,item]));
      // One atomic edit ensures that one Undo restores the entire lane.
      setTracks(previous=>previous.map(track=>{
        const output=byId.get(track.id);
        if(!output)return track;
        return {...track,path:output.path,url:output.url,
          streamIndex:0,sourceStartMs:0,sourceDurationMs:track.durationMs,
          fx:true,fxSettings:{...values},
          fxOriginal:track.fxOriginal??{
            path:track.path,url:track.url,streamIndex:track.streamIndex??0,
            sourceStartMs:track.sourceStartMs||0,
            sourceDurationMs:track.sourceDurationMs||track.durationMs,
            peaks:track.peaks.slice(),waveIntervalMs:track.waveIntervalMs||20,
          },
          peaks:[],waveIntervalMs:20,pending:true,error:undefined,
        };
      }));
      for(const item of rendered)loadWave(item.id,item.path,0,group.find(clip=>clip.id===item.id)?.durationMs||0);
    }catch(e){setError('Эффекты '+(clipId?'фрагмента':'дорожки')+': '+String(e))}
    finally{setEffectBusy(false)}
  },[effectBusy,processId,loadWave,setTracks,media,stream]);

  const resetLaneEffects=useCallback((laneId:string,clipId?:string)=>{
    const changed=tracksRef.current.filter(t=>laneKey(t)===laneId&&
      (!clipId||t.id===clipId)&&t.fxOriginal);
    if(!changed.length)return;
    setTracks(previous=>previous.map(track=>{
      if(laneKey(track)!==laneId||(clipId&&track.id!==clipId)||
         !track.fxOriginal)return track;
      const base=track.fxOriginal;
      return {...track,path:base.path,url:base.url,streamIndex:base.streamIndex,
        sourceStartMs:base.sourceStartMs,sourceDurationMs:base.sourceDurationMs,
        peaks:base.peaks.slice(),waveIntervalMs:base.waveIntervalMs,
        pending:base.peaks.length===0,fx:false,fxSettings:undefined,
        fxOriginal:undefined,error:undefined};
    }));
    for(const track of changed){
      const base=track.fxOriginal!;
      if(!base.peaks.length)loadWave(track.id,base.path,base.streamIndex,base.sourceDurationMs);
    }
  },[loadWave,setTracks]);

  const changeSetting=useCallback((key:string,value:string|number|boolean)=>{
    dirtySettings.current=true;
    setSettings(previous=>{
      if(key==='post_profile'){
        const preset=postProfiles[String(value)];
        return preset?{...previous,...preset,post_profile:value}:{...previous,post_profile:value};
      }
      const isPostFilter=Object.values(postProfiles).some(preset=>key in preset);
      return {...previous,[key]:value,
        ...(isPostFilter?{post_profile:'custom'}:{})};
    });
  },[postProfiles]);
  const restoreProject=useCallback(async(doc:ProjectDocument):Promise<boolean>=>{
    if(processId||effectBusy||busy){
      setError('Нельзя открывать проект во время обработки или загрузки.');
      return false;
    }
    setBusy('Загрузка проекта ACL…');
    setError('');
    const staged=new Map<string,string>();
    try{
      const info=await window.acl.request<MediaInfo>('media.inspect',{path:doc.media.path});
      if(!info.audioStreams.some(item=>item.index===doc.media.stream))
        throw Error('В выбранном видео больше нет аудиопотока '+doc.media.stream);
      const allSources=new Set<string>([info.path]);
      for(const clip of doc.tracks){
        allSources.add(clip.path);
        if(clip.fxOriginal)allSources.add(clip.fxOriginal.path);
      }
      // Stage and validate every file before mutating the running project.
      for(const file of allSources)staged.set(file,await window.acl.registerMedia(file));
      const hydrated:EditorTrack[]=doc.tracks.map(raw=>({
        ...raw,url:staged.get(raw.path)!,
        peaks:[],waveIntervalMs:20,pending:true,
        fxOriginal:raw.fxOriginal?{
          ...raw.fxOriginal,url:staged.get(raw.fxOriginal.path)!,
          waveIntervalMs:20,peaks:[] as [number,number][],
        }:undefined,
      }));
      const version=++session.current;
      originalElement.current?.pause();
      for(const element of processedElements.current.values())element.pause();
      for(const req of waveformRequests.current.keys()){
        void window.acl.request('task.cancel',{requestId:req}).catch(()=>{});
      }
      waveformRequests.current.clear();
      wavePending.current.clear();
      waveCache.current.clear();
      if(waveTimer.current!==null){window.clearTimeout(waveTimer.current);waveTimer.current=null}
      const old=[...grantedMedia.current];
      grantedMedia.current=new Set(staged.values());
      for(const url of old)void window.acl.releaseMedia(url).catch(()=>{});
      const location=Math.max(0,Math.min(info.durationMs,doc.positionMs||0));
      dragPosition.current=location;
      lastPhysicalSeek.current=0;
      setMedia(info);
      setMediaUrl(staged.get(info.path)!);
      setStream(doc.media.stream);
      setPosition(location);
      setSelection(doc.selection||null);
      setPlaying(false);
      setThumbnail('');
      setUnsupported(false);
      setPicker(null);
      setSelectedClipId(null);
      clipboard.current=null;
      dirtySettings.current=false;
      setSettings({...doc.settings});
      resetHistory(hydrated);
      if(info.hasVideo){
        void window.acl.request<{dataUrl:string}>('media.thumbnail',{path:info.path,atMs:0})
          .then(result=>{if(session.current===version)setThumbnail(result.dataUrl)})
          .catch(()=>{});
      }
      // Decode each distinct path/stream once; peak data are a cache.
      const loaded=new Set<string>();
      for(const clip of hydrated){
        const key=clip.path+'\0'+String(clip.streamIndex??0);
        if(loaded.has(key))continue;
        loaded.add(key);
        loadWave(clip.id,clip.path,clip.streamIndex??0,clip.sourceDurationMs||clip.durationMs);
      }
      return true;
    }catch(e){
      for(const url of staged.values())
        void window.acl.releaseMedia(url).catch(()=>{});
      setError('Открытие проекта: '+String(e));
      return false;
    }finally{setBusy('')}
  },[busy,processId,effectBusy,loadWave,resetHistory,setSelection]);

  const saveSettings=useCallback(async()=>{
    try{setSettings(await window.acl.request<Record<string,unknown>>('settings.save',{settings}))}
    catch(e){setError(String(e))}
  },[settings]);
  return {media,mediaUrl,thumbnail,unsupported,setUnsupported,tracks,settings,postProfiles,stream,picker,setPicker,
    busy,error,setError,exportResult,setExportResult,exportAudio,position,playing,setPlaying,progress,processId,processLog,processElapsed,cancelling,cancelWaiting,mixer,
    updateTrack,toggleTrackMute,moveClip,moveClips,toggleClipsDisabled,colorClips,duplicateClips,trimClip,splitClip,splitAll,copyClip,cutClip,pasteClip,hasClipboard,removeClips,
    renameLane,moveLane,removeLane,selectedClipId,setSelectedClipId,
    undo,redo,canUndo,canRedo,beginHistory,endHistory,openPath,activateFile,dismissPicker,seek,scrubStart,scrubEnd,
    selection,setSelection,setOriginalElement,setProcessedElement,
    togglePlay,pauseAll,updatePosition,removeTrack,restoreProject,changeSetting,saveSettings,
    applyLaneEffects,resetLaneEffects,effectBusy,startProcessing,cancelProcessing,forceStopProcessing};
}
