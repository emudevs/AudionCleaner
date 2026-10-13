import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useEditorLayout} from './useEditorLayout';
import {useProjectFiles} from './useProjectFiles';
import {createRoot} from 'react-dom/client';
import {useEditor} from './useEditor';
import {Mixer} from './Mixer';
import {SettingsPanel} from './SettingsPanel';
import {LaneEffectsDialog} from './LaneEffectsDialog';
import {groupLanes} from './editorOperations';
import {continuousPlaybackChains} from './audioTransport';
import {Timeline} from './Timeline';
import {Preview} from './Preview';
import {AppHeader} from './AppHeader';
import {shortcutKey} from './shortcutKeys';
import {HelpDialog} from './HelpDialog';
import type {HeaderMenu} from './AppHeader';
import './style.css';
import './style-timeline.css';
import './style-reference.css';
import './style-mixer-ruler.css';
import './style-preview-zoom.css';
import './style-layout.css';
import './style-timeline-grid.css';
import './style-header-fixes.css';
import './style-mixer-corrected.css';
import './style-timeline-pinned-labels.css';
import './style-timeline-range.css';
import './style-timeline-clips.css';
import './style-editor-tools.css';
import './style-cursors.css';
import './style-timeline-editing.css';
import './style-timeline-envelope.css';
import './style-timeline-scroll.css';
import './style-project.css';
import './style-timeline-toolbar-redesign.css';
import './style-app-header.css';
import './style-timeline-context-redesign.css';
import './style-acl-dialogs.css';

function AudioTrackPlayer({id,url,attach}: {id:string;url:string;attach:(id:string,element:HTMLAudioElement|null)=>void}) {
  const ref=useCallback((element:HTMLAudioElement|null)=>attach(id,element),[id,attach]);
  return <audio ref={ref} src={url} preload="metadata" crossOrigin="anonymous" className="invisible-media"/>;
}

function App() {
  const editor=useEditor();
  const {layout,set:setLayout}=useEditorLayout();
  const workRef=useRef<HTMLElement|null>(null);
  const upperRef=useRef<HTMLDivElement|null>(null);
  const [settingsOpen,setSettingsOpen]=useState(true);
  const previousTimelineBeforeCollapse=useRef<number|null>(null);
  const autoCollapsedTimeline=useRef<number|null>(null);
  const toggleSettings=useCallback(()=>{
    if(settingsOpen){
      previousTimelineBeforeCollapse.current=layout.timeline;
      const expanded=Math.max(layout.timeline,72);
      autoCollapsedTimeline.current=expanded;
      setLayout('timeline',expanded);
    }else{
      // Preserve manual resizing performed while the settings were collapsed.
      if(previousTimelineBeforeCollapse.current!==null&&
         layout.timeline===autoCollapsedTimeline.current)
        setLayout('timeline',previousTimelineBeforeCollapse.current);
      previousTimelineBeforeCollapse.current=null;
      autoCollapsedTimeline.current=null;
    }
    setSettingsOpen(old=>!old);
  },[settingsOpen,layout.timeline,setLayout]);
  const [mixerOpen,setMixerOpen]=useState(true);
  const [previewOpen,setPreviewOpen]=useState(true);
  const panels=useMemo(()=>({settingsOpen,mixerOpen,previewOpen}),
    [settingsOpen,mixerOpen,previewOpen]);
  const restorePanels=useCallback((state:typeof panels)=>{
    setSettingsOpen(state.settingsOpen!==false);
    setMixerOpen(state.mixerOpen!==false);
    setPreviewOpen(state.previewOpen!==false);
    previousTimelineBeforeCollapse.current=null;
    autoCollapsedTimeline.current=null;
  },[]);
  const project=useProjectFiles({editor,layout,setLayout,panels,restorePanels});
  useEffect(()=>{
    const projectName=project.projectPath?.split(/[\\/]/).pop();
    window.document.title=(project.dirty?'● ':'')+
      (projectName||editor.media?.name||'Anime Audio Cleaner')+' · ACL';
  },[project.projectPath,project.dirty,editor.media?.name]);
  useEffect(()=>{
    const close=(e:PointerEvent)=>{
      if(!(e.target instanceof Element)||!e.target.closest('.acl-project-menu'))
        project.setMenuOpen(false);
    };
    window.addEventListener('pointerdown',close);
    return()=>window.removeEventListener('pointerdown',close);
  },[]);
  const openMedia=useCallback(async()=>{
    if(!project.allowDiscard())return;
    await editor.openPath();
  },[editor.openPath,project.allowDiscard]);
  const [dragging,setDragging]=useState(false);
  const [properties,setProperties]=useState<{laneId:string;clipId?:string}|null>(null);
  const [helpDialog,setHelpDialog]=useState<'keys'|'about'|null>(null);
  const editingLane=groupLanes(editor.tracks).find(l=>l.id===properties?.laneId);
  const editingClips=editingLane?.clips.filter(clip=>!properties?.clipId||clip.id===properties.clipId)||[];
  const activeTransportIds=useMemo(()=>new Set(
    continuousPlaybackChains(editor.tracks).map(chain=>chain.leaderId)),[editor.tracks]);

  function resize(event:React.PointerEvent<HTMLDivElement>,kind:'sidebar'|'timeline'){
    event.preventDefault();
    const startX=event.clientX,startY=event.clientY,start=layout[kind];
    const container=kind==='sidebar'?upperRef.current:workRef.current;
    const size=kind==='sidebar'?container?.clientWidth:container?.clientHeight;
    if(!size)return;
    const target=event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move=(e:PointerEvent)=>{
      const offset=kind==='sidebar'?(e.clientX-startX):-(e.clientY-startY);
      setLayout(kind,start+offset/size*100);
    };
    const stop=()=>{
      target.removeEventListener('pointermove',move);
      target.removeEventListener('pointerup',stop);
      target.removeEventListener('pointercancel',stop);
    };
    target.addEventListener('pointermove',move);
    target.addEventListener('pointerup',stop,{once:true});
    target.addEventListener('pointercancel',stop,{once:true});
  }

  const shortcutHandler=useRef<(event:KeyboardEvent)=>void>(()=>{});
  shortcutHandler.current=(event:KeyboardEvent)=>{
      const node=event.target as HTMLElement;
      const ctrl=event.ctrlKey||event.metaKey;
      const name=shortcutKey(event);
      if(document.querySelector('[aria-modal="true"]'))return;
       if(ctrl&&name==='o'){event.preventDefault();void project.openProject();return}
      if(ctrl&&name==='s'){
        event.preventDefault();
        void project.saveProject(event.shiftKey);
        return;
      }
      if(node?.closest('input,textarea,select,[contenteditable="true"]'))return;
      if(ctrl&&name==='m'){
        if(editor.media&&!editor.busy&&!editor.processId){
          event.preventDefault();void editor.exportAudio();
        }
        return;
      }
      if(ctrl&&(name==='z'||name==='y')){
        event.preventDefault();
        if(name==='y'||event.shiftKey)editor.redo();else editor.undo();
        return;
      }
      if(ctrl&&name==='d'){
        if(editor.selectedClipId){event.preventDefault();editor.duplicateClips([editor.selectedClipId]);}
        return;
      }
      if(ctrl&&['c','x','v'].includes(name)){
        event.preventDefault();
        if(name==='v')editor.pasteClip(editor.position);
        else if(editor.selectedClipId){
          if(name==='c')editor.copyClip(editor.selectedClipId);
          else editor.cutClip(editor.selectedClipId);
        }
        return;
      }
      if(!editor.media || ctrl || event.altKey)return;
      const duration=editor.media.durationMs;
      const step=event.shiftKey?1000/Math.max(1,editor.media.video?.frameRate?
        (Number(editor.media.video.frameRate.split('/')[0])/
          Number(editor.media.video.frameRate.split('/')[1]||1)):25):5000;
      const seek=(time:number)=>{event.preventDefault();editor.seek(Math.max(0,Math.min(duration,time)))};
      if(name===' '||name==='k'){event.preventDefault();void editor.togglePlay()}
      else if(name==='arrowleft'||name==='j')seek(editor.position-step)
      else if(name==='arrowright'||name==='l')seek(editor.position+step)
      else if(name==='home')seek(0)
      else if(name==='end')seek(duration)
      else if(name==='+'||name==='='){event.preventDefault();setLayout('zoom',layout.zoom*1.25)}
      else if(name==='-'||name==='_'){event.preventDefault();setLayout('zoom',layout.zoom/1.25)}
      else if(name==='0'){event.preventDefault();setLayout('zoom',1)}
  };
  useEffect(()=>{
    const listener=(event:KeyboardEvent)=>shortcutHandler.current(event);
    window.addEventListener('keydown',listener);
    return()=>window.removeEventListener('keydown',listener);
  },[]);

  async function drop(event:React.DragEvent) {
    event.preventDefault();setDragging(false);
    const item=event.dataTransfer.files[0];
    if(!item)return;
    const path=window.acl.filePath(item);
    if(path){
      const audio=/\.(wav|flac|mp3|aac|m4a|ogg|opus)$/i.test(path);
      if(!audio&& !project.allowDiscard())return;
      const url=await window.acl.registerMedia(path);
      await editor.openPath({path,url},audio&&!!editor.media);
    }
  }

  return <div className={'app'+(dragging?' dragging':'')}
    onDragOver={e=>{
      if(Array.from(e.dataTransfer.types).includes('application/x-acl-lane'))return;
      e.preventDefault();setDragging(true);
    }}
    onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false)}}
    onDrop={e=>{
      if(Array.from(e.dataTransfer.types).includes('application/x-acl-lane')){
        e.preventDefault();setDragging(false);return;
      }
      void drop(e);
    }}>
    <AppHeader onBack={()=>void openMedia()}
      onExport={()=>void editor.exportAudio()}
      onProcess={()=>void editor.startProcessing()}
      canExport={!!editor.media&&!editor.processId&&!editor.busy}
      canProcess={!!editor.media&&!editor.processId&&!editor.busy}
      menus={[
        {id:'file',label:'Файл',items:[
          {id:'open-media',label:'Открыть или заменить медиа',onSelect:()=>void openMedia()},
          {id:'add-audio',label:'Добавить аудиодорожку',disabled:!editor.media,
            onSelect:()=>void editor.openPath(undefined,true)},
          {id:'file-sep-1',separator:true},
          {id:'open-project',label:'Открыть проект (.aclproj)',shortcut:'Ctrl+O',
            disabled:project.fileBusy,onSelect:()=>void project.openProject()},
          {id:'save',label:'Сохранить проект',shortcut:'Ctrl+S',
            disabled:!editor.media||project.fileBusy||!!editor.processId||editor.effectBusy,
            onSelect:()=>void project.saveProject()},
          {id:'save-as',label:'Сохранить проект как…',shortcut:'Ctrl+Shift+S',
            disabled:!editor.media||project.fileBusy||!!editor.processId||editor.effectBusy,
            onSelect:()=>void project.saveProject(true)},
          {id:'file-sep-2',separator:true},
          {id:'export',label:'Экспортировать аудиомикс',shortcut:'Ctrl+M',disabled:!editor.media||!!editor.processId||!!editor.busy,
            onSelect:()=>void editor.exportAudio()},
          {id:'file-sep-3',separator:true},
          {id:'quit',label:'Выход',shortcut:'Alt+F4',
            onSelect:()=>void window.acl.windowAction('close')},
        ]},
        {id:'edit',label:'Изменить',items:[
          {id:'undo',label:'Отменить',shortcut:'Ctrl+Z',disabled:!editor.canUndo,onSelect:editor.undo},
          {id:'redo',label:'Повторить',shortcut:'Ctrl+Y',disabled:!editor.canRedo,onSelect:editor.redo},
          {id:'edit-sep-1',separator:true},
          {id:'cut',label:'Вырезать клип',shortcut:'Ctrl+X',disabled:!editor.selectedClipId,
            onSelect:()=>editor.selectedClipId&&editor.cutClip(editor.selectedClipId)},
          {id:'copy',label:'Копировать клип',shortcut:'Ctrl+C',disabled:!editor.selectedClipId,
            onSelect:()=>editor.selectedClipId&&editor.copyClip(editor.selectedClipId)},
          {id:'paste',label:'Вставить в позицию каретки',shortcut:'Ctrl+V',
            disabled:!editor.media||!editor.hasClipboard,onSelect:()=>editor.pasteClip(editor.position)},
          {id:'duplicate',label:'Дублировать клип',shortcut:'Ctrl+D',
            disabled:!editor.selectedClipId,
            onSelect:()=>editor.selectedClipId&&editor.duplicateClips([editor.selectedClipId])},
        ]},
        {id:'clip',label:'Клип',items:[
          {id:'split',label:'Разрезать по каретке',shortcut:'B',disabled:!editor.selectedClipId,
            onSelect:()=>editor.selectedClipId&&editor.splitClip(editor.selectedClipId,editor.position)},
          {id:'split-all',label:'Разрезать все дорожки по каретке',disabled:!editor.media,
            onSelect:()=>editor.splitAll(editor.position)},
          {id:'clip-sep-1',separator:true},
          {id:'toggle',label:editor.tracks.find(t=>t.id===editor.selectedClipId)?.clipMuted
            ?'Включить выбранный клип':'Выключить выбранный клип',
            disabled:!editor.selectedClipId,
            onSelect:()=>editor.selectedClipId&&editor.toggleClipsDisabled([editor.selectedClipId])},
          {id:'clip-props',label:'Свойства и эффекты клипа',disabled:!editor.selectedClipId,
            onSelect:()=>{
              const clip=editor.tracks.find(t=>t.id===editor.selectedClipId);
              if(clip)setProperties({laneId:clip.laneId||clip.id,clipId:clip.id});
            }},
        ]},
        {id:'view',label:'Вид',items:[
          {id:'zoom-in',label:'Увеличить масштаб',shortcut:'+',onSelect:()=>setLayout('zoom',layout.zoom*1.25)},
          {id:'zoom-out',label:'Уменьшить масштаб',shortcut:'-',onSelect:()=>setLayout('zoom',layout.zoom/1.25)},
          {id:'zoom-reset',label:'Весь проект',shortcut:'0',onSelect:()=>setLayout('zoom',1)},
          {id:'view-sep-1',separator:true},
          {id:'view-mixer',label:'Микшер',checked:mixerOpen,onSelect:()=>setMixerOpen(v=>!v)},
          {id:'view-preview',label:'Предпросмотр',checked:previewOpen,onSelect:()=>setPreviewOpen(v=>!v)},
          {id:'view-effects',label:'Постобработка и эффекты',checked:settingsOpen,onSelect:toggleSettings},
        ]},
        {id:'help',label:'Справка',items:[
          {id:'shortcuts',label:'Горячие клавиши',onSelect:()=>setHelpDialog('keys')},
          {id:'about',label:'О программе ACL',onSelect:()=>setHelpDialog('about')},
        ]},
      ] satisfies HeaderMenu[]}/>
    <main ref={workRef} className="editor-work"
      style={{gridTemplateRows:`minmax(0,${100-layout.timeline}fr) 7px minmax(0,${layout.timeline}fr)`}}>
      <div ref={upperRef} className="editor-upper"
        style={{gridTemplateColumns:`minmax(280px,${layout.sidebar}fr) 7px minmax(390px,${100-layout.sidebar}fr)`}}>
        <aside className="sidebar">
          <section className="panel mixer-panel">
            <button className="heading panel-button" onClick={()=>setMixerOpen(!mixerOpen)}>Микшер аудио
              <img src={'./arrow_' + (mixerOpen ? 'up' : 'down') + '.svg'} alt=""/></button>
            {mixerOpen&&<Mixer tracks={editor.tracks} levels={editor.mixer.levels} onUpdate={editor.updateTrack}/>}
          </section>
          <section className={"panel effects-panel"+(!settingsOpen?" effects-panel-collapsed":"")}>
            <button className="heading panel-button" onClick={toggleSettings}>Постобработка и эффекты
              <img src={'./arrow_' + (settingsOpen ? 'up' : 'down') + '.svg'} alt=""/></button>
            {settingsOpen&&<div className="effects-scroll">
              <SettingsPanel values={editor.settings} onChange={editor.changeSetting}/>
            </div>}
          </section>
        </aside>
        <div className="layout-v-resizer" role="separator" aria-label="Ширина боковой панели"
          title="Перетащите для изменения ширины панелей" onPointerDown={event=>resize(event,'sidebar')}/>
        <div className="right-side">
          <Preview
            media={editor.media} url={editor.mediaUrl} thumbnail={editor.thumbnail}
            position={editor.position} playing={editor.playing} unsupported={editor.unsupported}
            onToggle={()=>void editor.togglePlay()} onSeek={editor.seek}
            onTime={editor.updatePosition} onPause={editor.pauseAll}
            onUnsupported={()=>editor.setUnsupported(true)} attachOriginal={editor.setOriginalElement}
            collapsed={!previewOpen} onToggleCollapse={()=>setPreviewOpen(!previewOpen)}
            globalMuted={editor.mixer.globalMuted} onToggleGlobalMute={editor.mixer.toggleGlobalMute}/>
        </div>
      </div>
      <div className="layout-h-resizer" role="separator" aria-label="Высота таймлайна"
        title="Перетащите для изменения высоты таймлайна" onPointerDown={event=>resize(event,'timeline')}/>
      <section className="panel timeline">
        <Timeline media={editor.media} tracks={editor.tracks} thumbnail={editor.thumbnail}
          position={editor.position} playing={editor.playing}
          selection={editor.selection} onSelectionChange={editor.setSelection}
          zoom={layout.zoom} labelWidth={layout.labels} trackHeight={layout.trackHeight}
          onZoom={value=>setLayout('zoom',value)}
          onTrackHeight={height=>setLayout('trackHeight',height)}
          onLabelsResize={width=>setLayout('labels',width)}
          onScrubStart={editor.scrubStart} onScrubEnd={editor.scrubEnd}
          onSeek={editor.seek} onOpen={()=>void openMedia()}
          onAddAudio={()=>void editor.openPath(undefined,true)} onRemove={editor.removeTrack}
          onToggleMute={editor.toggleTrackMute} onMoveClip={editor.moveClip}
          onCopyClip={editor.copyClip} onCutClip={editor.cutClip}
          onPasteClip={editor.pasteClip} canPaste={editor.hasClipboard}
          onRemoveClips={editor.removeClips}
           onMoveClips={editor.moveClips} onToggleClipsDisabled={editor.toggleClipsDisabled}
           onColorClips={editor.colorClips} onDuplicateClips={editor.duplicateClips}
          onSplitClip={editor.splitClip} onTrimClip={editor.trimClip} onUpdateClip={editor.updateTrack}
          onRenameLane={editor.renameLane} onMoveLane={editor.moveLane}
          onRemoveLane={editor.removeLane}
          onOpenProperties={(laneId,clipId)=>setProperties({laneId,clipId})}
          onSplitAll={editor.splitAll}
          onSelectedClipChange={editor.setSelectedClipId}
          onBeginEdit={editor.beginHistory} onEndEdit={editor.endHistory}
          onProcess={()=>void editor.startProcessing()}/>
      </section>
    </main>
    {editor.tracks.filter(track=>activeTransportIds.has(track.id)).map(track=><AudioTrackPlayer
      key={track.id} id={track.id} url={track.url} attach={editor.setProcessedElement}/>)}
    {editingLane&&editingClips.length>0&&<LaneEffectsDialog
      key={editingLane.id+':'+(properties?.clipId||'lane')}
      tracks={editingClips} media={editor.media}
      scope={properties?.clipId?'clip':'lane'}
      settings={editor.settings} postProfiles={editor.postProfiles} busy={editor.effectBusy}
      onApply={values=>void editor.applyLaneEffects(editingLane.id,values,properties?.clipId)}
      onReset={()=>editor.resetLaneEffects(editingLane.id,properties?.clipId)}
      onClose={()=>setProperties(null)}/>}
    {helpDialog&&<HelpDialog mode={helpDialog} onClose={()=>setHelpDialog(null)}/>}
    {editor.picker&&<div className="dialog-shade"><div className="audio-dialog">
      <h3>Выбор аудиодорожки</h3>
      <div className="dialog-file">{editor.picker.media.name}</div>
      <p>Необходимо выбрать аудиодорожку:</p>
      {editor.picker.media.audioStreams.map(s=><label className="audio-option" key={s.index}>
        <input type="radio" name="audioStream" value={s.index} defaultChecked={s.index===editor.picker!.media.audioStreams[0].index}/>
        <span>{s.title||'Аудио '+s.index}</span><small>{s.language||'und'}　{s.codec.toUpperCase()}</small>
      </label>)}
      <div className="dialog-actions">
        <button onClick={editor.dismissPicker}>Отмена</button>
        <button className="primary" onClick={()=>{
          const chosen=document.querySelector<HTMLInputElement>('input[name="audioStream"]:checked');
          if(editor.picker)editor.activateFile(editor.picker,Number(chosen?.value??0));
        }}>Выбрать аудиодорожку</button>
      </div>
    </div></div>}
    {editor.processId&&<div className="processing-shade">
      <div className="processing-dialog">
        <strong>{editor.cancelling?'Остановка обработки':editor.progress?.stage||'Обработка'}…</strong>
        <div className="processing-bar"><span style={{width:(editor.progress?.percent||0)+'%'}}/></div>
        <span className="processing-duration">Прошло: {Math.floor(editor.processElapsed/60)} мин {editor.processElapsed%60} сек · {editor.progress?.percent||0}%</span>
        <div className="processing-log" role="log">
          {editor.processLog.length?editor.processLog.slice(-8).map((line,index)=>
            <div key={index}>{line}</div>):'Ожидание сообщений от обработчика…'}
        </div>
        <button className="primary" disabled={editor.cancelling} onClick={editor.cancelProcessing}>
          {editor.cancelling?'Завершение процессов…':'Отменить обработку'}
        </button>
        {editor.cancelling&&editor.cancelWaiting>=8&&
          <button className="force-stop" onClick={editor.forceStopProcessing}>
            Принудительно завершить обработчик
          </button>}
      </div>
    </div>}
    {editor.busy&&<div className="busy">{editor.busy}</div>}
    {editor.exportResult&&<div className="toast-export" role="status">
      <span className="toast-export-check" aria-hidden="true">✓</span>
      <span className="toast-export-text" title={editor.exportResult}>{editor.exportResult}</span>
      <button type="button" aria-label="Закрыть уведомление"
        onClick={()=>editor.setExportResult('')}>×</button>
    </div>}
    {editor.error&&<div className="toast-error" role="alert">{editor.error}
      <button onClick={()=>editor.setError('')}>×</button></div>}
    {dragging&&<div className="drag-overlay">Отпустите файл, чтобы добавить его в редактор</div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
