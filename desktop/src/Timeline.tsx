import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {CSSProperties,PointerEvent as ReactPointerEvent,MouseEvent as ReactMouseEvent} from 'react';
import type {EditorTrack,MediaInfo} from './editor';
import {timecode,fps,clipOffsetBounds} from './editor';
import {Ruler} from './Ruler';
import {Waveform} from './Waveform';
import {useWaveformDetails} from './useWaveformDetails';
import {groupLanes,fadeCurvePath,fadeGain} from './editorOperations';
import {snapPosition,snapToleranceMs,timelineSnapAnchors,trimEdgeBounds} from './timelineSnapping';
import {CLIP_COLORS,groupMoveDelta} from './clipEditing';
import {shortcutKey} from './shortcutKeys';

type Props={
 media:MediaInfo|null;thumbnail:string;tracks:EditorTrack[];position:number;
 zoom:number;labelWidth:number;trackHeight:number;onZoom:(value:number)=>void;
 onTrackHeight:(value:number)=>void;
 selection:{startMs:number;endMs:number}|null;
 onSelectionChange:(range:{startMs:number;endMs:number}|null)=>void;
 playing:boolean;
 onLabelsResize:(width:number)=>void;onSeek:(ms:number)=>void;
 onScrubStart:()=>void;onScrubEnd:()=>void;onOpen:()=>void;
 onAddAudio:()=>void;onRemove:(id:string)=>void;onProcess:()=>void;
 onToggleMute:(id:string)=>void;
 onMoveClip:(id:string,offsetMs:number)=>void;
 onCopyClip:(id:string)=>void;
 onCutClip:(id:string)=>void;
 onPasteClip:(timeMs:number)=>void;
 canPaste:boolean;
 onRemoveClips:(ids:string[])=>void;
  onMoveClips:(originals:Record<string,number>,deltaMs:number)=>void;
  onToggleClipsDisabled:(ids:string[])=>void;
  onColorClips:(ids:string[],color:string)=>void;
  onDuplicateClips:(ids:string[])=>string[];
 onSplitClip:(id:string,atMs:number)=>void;
 onUpdateClip:(id:string,patch:Partial<EditorTrack>)=>void;
 onRenameLane:(id:string,name:string)=>void;
 onMoveLane:(from:string,to:string)=>void;
 onRemoveLane:(id:string)=>void;
 onTrimClip:(id:string,edge:'left'|'right',deltaMs:number)=>void;
 onSplitAll:(ms:number)=>void;
 onSelectedClipChange:(id:string|null)=>void;
 onBeginEdit:()=>void;onEndEdit:()=>void;
 onOpenProperties:(laneId:string,clipId?:string)=>void;
};

const bound=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

export function Timeline({media,thumbnail,tracks,position,zoom,labelWidth,trackHeight,
 onZoom,onTrackHeight,selection,onSelectionChange,playing,onLabelsResize,
 onSeek,onScrubStart,onScrubEnd,onOpen,onAddAudio,onRemove,onProcess,onToggleMute,onMoveClip,
 onCopyClip,onCutClip,onPasteClip,canPaste,onRemoveClips,
  onMoveClips,onToggleClipsDisabled,onColorClips,onDuplicateClips,
 onSplitClip,onUpdateClip,onRenameLane,onMoveLane,onRemoveLane,onTrimClip,
 onSplitAll,onSelectedClipChange,onBeginEdit,onEndEdit,onOpenProperties}:Props){
 const scroll=useRef<HTMLDivElement>(null);
 const verticalScroll=useRef<HTMLDivElement>(null);
 const bottomScroll=useRef<HTMLDivElement>(null);
 const [tool,setTool]=useState<'mouse'|'blade'|'gain'|'mute'>('mouse');
 const [snapEnabled,setSnapEnabled]=useState(true);
 const [snapGuide,setSnapGuide]=useState<number|null>(null);
 const [renameId,setRenameId]=useState<string|null>(null);
 const [renameText,setRenameText]=useState('');
 const renameCanceled=useRef(false);
 const [movingLane,setMovingLane]=useState<string|null>(null);
 const [selectedClip,setSelectedClip]=useState<string|null>(null);
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
 const [selectedLane,setSelectedLane]=useState<string|null>(null);
 const [contextMenu,setContextMenu]=useState<{
   x:number;y:number;clipId?:string;laneId?:string;timeMs?:number
 }|null>(null);
 const contextMenuRef=useRef<HTMLDivElement>(null);
 const trimDrag=useRef<{
   id:string;edge:'left'|'right';startX:number;
   lastDeltaMs:number;pointerId:number
 }|null>(null);
 const fadeDrag=useRef<{id:string;type:'in'|'out'|'volume'|'inBend'|'outBend';x:number;y:number;initial:number;length:number;pointer:number}|null>(null);
 const missingRow=useRef<HTMLDivElement>(null);
 const timeColumn=useRef<HTMLDivElement>(null);
 const [viewportWidth,setViewportWidth]=useState(900);
 const [scrollOffset,setScrollOffset]=useState(0);
 const [ghost,setGhost]=useState<number|null>(null);
 const [hoverY,setHoverY]=useState(48);
 const selecting=useRef<{startMs:number;pointerId:number}|null>(null);
 const [missingTop,setMissingTop]=useState(0);
 const [scrubbing,setScrubbing]=useState(false);
 const grabbing=useRef(false);
 const anchor=useRef<{x:number;time:number}|null>(null);
 const duration=media?.durationMs||0;
 const rate=fps(media?.video?.frameRate);
 const lanes=groupLanes(tracks);
 const width=Math.max(300,Math.ceil(viewportWidth*zoom));
 const offsetInput=useRef<HTMLInputElement>(null);
 const clipDrag=useRef<{id:string;pointerId:number;clientX:number;startOffset:number;length:number;originals:Record<string,number>}|null>(null);
 const [offsetDraft,setOffsetDraft]=useState('0');
 const skipOffsetBlur=useRef(false);
 const pxPerMs=width/Math.max(1,duration);
 const minRangeMs=Math.max(100,1000/Math.max(rate,1));
 const detailPeaks=useWaveformDetails(tracks,duration,width,scrollOffset,viewportWidth);

 useLayoutEffect(()=>{
   const el=scroll.current;
   if(!el)return;
   const observer=new ResizeObserver(()=>setViewportWidth(el.clientWidth));
   observer.observe(el);
   setViewportWidth(el.clientWidth);
   return()=>observer.disconnect();
 },[Boolean(media)]);

 useLayoutEffect(()=>{
   const point=anchor.current;
   const el=scroll.current;
   if(!point||!el||!duration)return;
   el.scrollLeft=Math.max(0,point.time*pxPerMs-point.x);
   anchor.current=null;
 },[width,duration]);

 // Keep the running playhead within the horizontal viewport. A seek or
 // scale change brings an offscreen cursor back into view immediately.
 useLayoutEffect(()=>{
   const el=scroll.current;
   if(!el||!media||!playing||grabbing.current||selecting.current)return;
   const playX=bound(position*pxPerMs,0,width);
   const left=el.scrollLeft;
   const view=el.clientWidth;
   if(view<=0)return;
   if(playX>left+view*.82 || playX<left){
     el.scrollLeft=bound(playX-view*.3,0,Math.max(0,width-view));
   }
 },[position,playing,width,pxPerMs,media]);

 useLayoutEffect(()=>{
   const row=missingRow.current;
   const parent=timeColumn.current;
   if(!media||!row||!parent)return;
   const measure=()=>{
     const next=row.getBoundingClientRect().top-parent.getBoundingClientRect().top;
     setMissingTop(old=>Math.abs(old-next)<.5?old:next);
   };
   const observer=new ResizeObserver(measure);
   observer.observe(row);observer.observe(parent);
   measure();
   return()=>observer.disconnect();
 },[Boolean(media),tracks.length,zoom,trackHeight]);

 function xFromClient(clientX:number){
   const el=scroll.current;
   if(!el)return 0;
   const rect=el.getBoundingClientRect();
   return bound(clientX-rect.left+el.scrollLeft,0,width);
 }
 const seekAt=useCallback((clientX:number)=>{
   const el=scroll.current;
   if(!el||duration<=0)return;
   const x=bound(clientX-el.getBoundingClientRect().left+el.scrollLeft,0,width);
   onSeek(x/width*duration);
 },[duration,width,onSeek]);

 function pointerDown(event:ReactPointerEvent<HTMLElement>){
   if(!media||event.button!==0||selecting.current)return;
   if(event.shiftKey&&tool==='blade'){
     onSplitAll(Math.round(xFromClient(event.clientX)/Math.max(1,width)*duration));
     return;
   }
   if(event.shiftKey)return;
   event.preventDefault();
   event.stopPropagation();
   grabbing.current=true;
   setScrubbing(true);
   setGhost(null);
   onScrubStart();
   event.currentTarget.setPointerCapture(event.pointerId);
   seekAt(event.clientX);
 }
 function pointerMove(event:ReactPointerEvent<HTMLElement>){
   if(!grabbing.current)return;
   seekAt(event.clientX);
   const el=scroll.current;
   if(!el)return;
   const box=el.getBoundingClientRect();
   if(event.clientX>box.right-26)el.scrollLeft+=18;
   else if(event.clientX<box.left+26)el.scrollLeft-=18;
 }
 function pointerUp(event:ReactPointerEvent<HTMLElement>){
   if(!grabbing.current)return;
   grabbing.current=false;
   setScrubbing(false);
   seekAt(event.clientX);
   onScrubEnd();
   if(event.currentTarget.hasPointerCapture(event.pointerId))
     event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function pointerHover(event:ReactPointerEvent<HTMLDivElement>){
   const el=scroll.current;
   if(el&&timeColumn.current)setHoverY(bound(event.clientY-timeColumn.current.getBoundingClientRect().top-16,28,el.clientHeight-20));
   if(!grabbing.current&&!selecting.current&&!clipDrag.current&&!trimDrag.current){
     const target=event.target as HTMLElement;
     if(target.closest('button'))return;
     setGhost(xFromClient(event.clientX));
   }
 }
 function selectDown(event:ReactPointerEvent<HTMLDivElement>){
   if(!media||!event.shiftKey||event.button!==0||tool!=='mouse')return;
   event.preventDefault();
   event.stopPropagation();
   const ms=bound(xFromClient(event.clientX)/width*duration,0,Math.max(0,duration-minRangeMs));
   selecting.current={startMs:ms,pointerId:event.pointerId};
   event.currentTarget.setPointerCapture(event.pointerId);
   onSelectionChange({startMs:ms,endMs:Math.min(duration,ms+minRangeMs)});
 }
 function selectMove(event:ReactPointerEvent<HTMLDivElement>){
   const state=selecting.current;
   if(!state||state.pointerId!==event.pointerId)return;
   event.preventDefault();
   const ms=bound(xFromClient(event.clientX)/width*duration,0,duration);
   const start=Math.min(state.startMs,ms);
   const end=Math.max(state.startMs,ms);
   onSelectionChange({startMs:start,endMs:Math.min(duration,Math.max(start+minRangeMs,end))});
   const el=scroll.current;
   if(el){
     const box=el.getBoundingClientRect();
     if(event.clientX>box.right-20)el.scrollLeft+=18;
     if(event.clientX<box.left+20)el.scrollLeft-=18;
   }
 }
 function selectUp(event:ReactPointerEvent<HTMLDivElement>){
   const state=selecting.current;
   if(!state||state.pointerId!==event.pointerId)return;
   selectMove(event);
   const ms=bound(xFromClient(event.clientX)/width*duration,0,duration);
   onSeek(Math.min(state.startMs,ms));
   selecting.current=null;
   if(event.currentTarget.hasPointerCapture(event.pointerId))
     event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function moveClipStart(event:ReactPointerEvent<HTMLDivElement>,track:EditorTrack){
   if(tool!=='mouse'||!media||event.button!==0)return;
   event.preventDefault();event.stopPropagation();
   const ids=event.ctrlKey||event.metaKey||event.shiftKey
     ?selectedIds.includes(track.id)?selectedIds.filter(id=>id!==track.id):[...selectedIds,track.id]
     :selectedIds.includes(track.id)?selectedIds:[track.id];
   setSelectedIds(ids);
   setSelectedClip(track.id);
   onSelectedClipChange(track.id);
   setSelectedLane(null);
   setContextMenu(null);
   setGhost(null);
   setSnapGuide(null);
   if((event.ctrlKey||event.metaKey||event.shiftKey))return;
   onBeginEdit();
   const originals=Object.fromEntries(tracks.filter(t=>ids.includes(t.id)).map(t=>[t.id,t.offsetMs||0]));
   clipDrag.current={
     id:track.id,pointerId:event.pointerId,clientX:event.clientX,
     startOffset:track.offsetMs||0,length:track.durationMs,originals,
   };
   setOffsetDraft(((track.offsetMs||0)/1000).toFixed(3));
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function moveClipPointer(event:ReactPointerEvent<HTMLDivElement>){
   const drag=clipDrag.current;
   if(!drag||drag.pointerId!==event.pointerId)return;
   event.stopPropagation();event.preventDefault();
   const ms=drag.startOffset+(event.clientX-drag.clientX)/Math.max(.0001,pxPerMs);
   const bounds=clipOffsetBounds(duration,drag.length);
   let next=Math.round(bound(ms,bounds.min,bounds.max));
   const groupIds=Object.keys(drag.originals);
   const requested=groupMoveDelta(tracks,drag.originals,next-drag.startOffset,duration);
   next=drag.startOffset+requested;
   if(snapEnabled&&!event.altKey){
     const anchors=timelineSnapAnchors(tracks,drag.id,duration,position,selection).filter(anchor=>!tracks.some(t=>groupIds.includes(t.id)&&((t.offsetMs||0)===anchor||(t.offsetMs||0)+t.durationMs===anchor)));
     const result=snapPosition(next,anchors,[0,drag.length],
       snapToleranceMs(pxPerMs),bounds);
     next=result.value;
     setSnapGuide(result.guideMs);
   }else setSnapGuide(null);
   if(groupIds.length>1)onMoveClips(drag.originals,next-drag.startOffset);
   else onMoveClip(drag.id,next);
   setOffsetDraft((next/1000).toFixed(3));
 }
 function moveClipEnd(event:ReactPointerEvent<HTMLDivElement>){
   if(clipDrag.current?.pointerId!==event.pointerId)return;
   const clicked=Math.abs(event.clientX-clipDrag.current.clientX)<4;
   moveClipPointer(event);
   if(clicked&&tool==='mouse')onSeek(xFromClient(event.clientX)/Math.max(1,width)*duration);
   clipDrag.current=null;
   setSnapGuide(null);
   onEndEdit();
   if(event.currentTarget.hasPointerCapture(event.pointerId))
     event.currentTarget.releasePointerCapture(event.pointerId);
 }
 const activeOffsetTrack=tracks.find(t=>t.id===selectedClip);
 useEffect(()=>{
   const clip=tracks.find(t=>t.id===selectedClip);
   if(clip)setOffsetDraft(((clip.offsetMs||0)/1000).toFixed(3));
 },[selectedClip]);
 function commitOffset(){
   if(!activeOffsetTrack)return;
   const seconds=Number(offsetDraft.replace(',','.'));
   if(Number.isFinite(seconds)){
     const bounds=clipOffsetBounds(duration,activeOffsetTrack.durationMs);
     const next=Math.round(bound(seconds*1000,bounds.min,bounds.max));
     onMoveClip(activeOffsetTrack.id,next);
     setOffsetDraft((next/1000).toFixed(3));
   }else setOffsetDraft(((activeOffsetTrack.offsetMs||0)/1000).toFixed(3));
 }
 function trimDown(event:ReactPointerEvent<HTMLElement>,clip:EditorTrack,edge:'left'|'right'){
   if(tool!=='mouse'||event.button!==0)return;
   event.preventDefault();event.stopPropagation();
   setSelectedClip(clip.id);
   onSelectedClipChange(clip.id);
   setSelectedLane(null);
   setGhost(null);
   setSnapGuide(null);
   onBeginEdit();
   trimDrag.current={id:clip.id,edge,startX:event.clientX,
     lastDeltaMs:0,pointerId:event.pointerId};
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function trimMove(event:ReactPointerEvent<HTMLElement>){
   const drag=trimDrag.current;
   if(!drag||drag.pointerId!==event.pointerId)return;
   event.preventDefault();event.stopPropagation();
   const total=Math.round((event.clientX-drag.startX)/Math.max(.00001,pxPerMs));
   let step=total-drag.lastDeltaMs;
   const clip=tracks.find(item=>item.id===drag.id);
   if(clip&&snapEnabled&&!event.altKey){
     const edgeTime=(clip.offsetMs||0)+(drag.edge==='right'?clip.durationMs:0);
     const anchors=timelineSnapAnchors(tracks,drag.id,duration,position,selection);
     const result=snapPosition(edgeTime+step,anchors,[0],
       snapToleranceMs(pxPerMs),trimEdgeBounds(clip,drag.edge));
     step=Math.round(result.value-edgeTime);
     setSnapGuide(result.guideMs);
   }else setSnapGuide(null);
   if(step!==0)onTrimClip(drag.id,drag.edge,step);
   drag.lastDeltaMs=total;
 }
 function trimEnd(event:ReactPointerEvent<HTMLElement>){
   if(trimDrag.current?.pointerId!==event.pointerId)return;
   trimMove(event);
   trimDrag.current=null;
   setSnapGuide(null);
   onEndEdit();
   if(event.currentTarget.hasPointerCapture(event.pointerId))
     event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function openContextMenu(event:ReactMouseEvent,clipId?:string,laneId?:string){
   event.preventDefault();event.stopPropagation();
   if(clipId&&!selectedIds.includes(clipId))setSelectedIds([clipId]);
   setSelectedClip(clipId||null);
   onSelectedClipChange(clipId||null);
   setSelectedLane(laneId||null);
   setContextMenu({
     x:event.clientX,y:event.clientY,clipId,laneId,
     timeMs:Math.round(xFromClient(event.clientX)/Math.max(1,width)*duration),
   });
 }
 useLayoutEffect(()=>{
   if(!contextMenu||!contextMenuRef.current)return;
   const element=contextMenuRef.current;
   const {width:menuWidth,height:menuHeight}=element.getBoundingClientRect();
   element.style.left=Math.max(8,Math.min(contextMenu.x,innerWidth-menuWidth-8))+'px';
   element.style.top=Math.max(8,Math.min(contextMenu.y,innerHeight-menuHeight-8))+'px';
   element.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
 },[contextMenu]);
 useEffect(()=>{
   const keydown=(event:KeyboardEvent)=>{
     if((event.ctrlKey||event.metaKey)&&shortcutKey(event)==='a'&&media){
       if(!(event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')){
         event.preventDefault();setSelectedIds(tracks.map(t=>t.id));
       }
       return;
     }
     const el=event.target as HTMLElement;
     if(event.ctrlKey||event.metaKey||event.altKey||
       el?.closest('input,textarea,select,[contenteditable="true"]'))return;
     if(event.key==='Delete'||event.key==='Backspace'){
       if(contextMenu?.clipId||selectedClip){
         event.preventDefault();
         onRemove(contextMenu?.clipId||selectedClip!);
         setSelectedClip(null);onSelectedClipChange(null);setContextMenu(null);
       }else if(contextMenu?.laneId||selectedLane){
         event.preventDefault();
         onRemoveLane(contextMenu?.laneId||selectedLane!);
         setSelectedLane(null);setContextMenu(null);
       }
     }else if(event.key==='Escape'){
       onSelectedClipChange(null);
       setSelectedIds([]);
       setContextMenu(null);setSelectedClip(null);setSelectedLane(null);
     }
   };
   const outside=(event:PointerEvent)=>{
     if((event.target as HTMLElement)?.closest('.timeline-context-menu'))return;
     setContextMenu(null);
   };
   window.addEventListener('keydown',keydown);
   window.addEventListener('pointerdown',outside);
   return()=>{
     window.removeEventListener('keydown',keydown);
     window.removeEventListener('pointerdown',outside);
   };
 },[contextMenu,selectedClip,selectedLane,onRemove,onRemoveLane,media,tracks]);
 function editFade(event:ReactPointerEvent<HTMLElement>,clip:EditorTrack,type:'in'|'out'|'volume'|'inBend'|'outBend'){
   if(event.button!==0||(type==='volume'?tool!=='gain':tool!=='mouse'))return;
   event.stopPropagation();event.preventDefault();
   setSelectedClip(clip.id);
   onSelectedClipChange(clip.id);
   setSelectedLane(null);
   onBeginEdit();
   fadeDrag.current={id:clip.id,type,x:event.clientX,y:event.clientY,
     initial:type==='in'?(clip.fadeInMs||0):type==='out'?(clip.fadeOutMs||0):
       type==='inBend'?(clip.fadeInCurve||0):type==='outBend'?(clip.fadeOutCurve||0):(clip.clipGain??1),
     length:clip.durationMs,pointer:event.pointerId};
   event.currentTarget.setPointerCapture(event.pointerId);
 }
 function editFadeMove(event:ReactPointerEvent<HTMLElement>){
   const drag=fadeDrag.current;
   if(!drag||drag.pointer!==event.pointerId)return;
   event.stopPropagation();event.preventDefault();
   if(drag.type==='volume'){
     onUpdateClip(drag.id,{clipGain:bound(drag.initial+(drag.y-event.clientY)/Math.max(32,trackHeight*.75),0,2)});
   }else if(drag.type==='inBend'||drag.type==='outBend'){
     const value=Math.round(bound(drag.initial+(drag.y-event.clientY)/30,-2,2)*100)/100;
     onUpdateClip(drag.id,drag.type==='inBend'?{fadeInCurve:value}:{fadeOutCurve:value});
   }else{
     const deltaMs=(event.clientX-drag.x)/Math.max(.000001,pxPerMs);
     const value=Math.round(bound(drag.initial+(drag.type==='in'?deltaMs:-deltaMs),0,drag.length));
     onUpdateClip(drag.id,drag.type==='in'?{fadeInMs:value}:{fadeOutMs:value});
   }
 }
 function editFadeEnd(event:ReactPointerEvent<HTMLElement>){
   if(fadeDrag.current?.pointer!==event.pointerId)return;
   editFadeMove(event);
   fadeDrag.current=null;
   onEndEdit();
   if(event.currentTarget.hasPointerCapture(event.pointerId))
     event.currentTarget.releasePointerCapture(event.pointerId);
 }
 function clickBlade(event:ReactPointerEvent<HTMLDivElement>,clip:EditorTrack){
   if(tool!=='blade'||event.button!==0)return false;
   event.stopPropagation();event.preventDefault();
   const atMs=Math.round(xFromClient(event.clientX)/Math.max(1,width)*duration);
   if(event.shiftKey)onSplitAll(atMs);else onSplitClip(clip.id,atMs);
   setSelectedClip(null);onSelectedClipChange(null);
   return true;
 }
 function commitRename(){
   if(renameCanceled.current){
     renameCanceled.current=false;
     setRenameId(null);
     return;
   }
   if(renameId&&renameText.trim())onRenameLane(renameId,renameText);
   setRenameId(null);
 }
 useEffect(()=>{
   const change=(event:KeyboardEvent)=>{
     if(event.ctrlKey||event.altKey||event.metaKey||
        document.querySelector('[aria-modal="true"]')||
        (event.target instanceof HTMLElement &&
          event.target.closest('input,textarea,select,[contenteditable="true"]')))return;
     if(shortcutKey(event)==='v')setTool('mouse');
     if(shortcutKey(event)==='b')setTool('blade');
      if(shortcutKey(event)==='g')setTool('gain');
      if(shortcutKey(event)==='m')setTool('mute');
     if(shortcutKey(event)==='n'&&!event.repeat){
       event.preventDefault();
       setSnapEnabled(value=>!value);
       setSnapGuide(null);
     }
   };
   window.addEventListener('keydown',change);
   return()=>window.removeEventListener('keydown',change);
 },[]);
 function clipFadeSvg(type:'in'|'out',ms:number,length:number,curve:number){
   if(ms<10)return null;
   return <svg className={'clip-fade-curve '+type}
     style={{width:Math.max(0,ms/Math.max(1,length)*100)+'%'}}
     viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
     <path d={fadeCurvePath(type,100,100,curve)}/>
   </svg>;
 }
 function changeZoom(next:number,clientX?:number){
   const el=scroll.current;
   if(!el)return;
   const x=clientX===undefined?el.clientWidth/2:clientX-el.getBoundingClientRect().left;
   anchor.current={x,time:bound((x+el.scrollLeft)/width*duration,0,duration)};
   onZoom(bound(next,1,80));
 }
 const wheelListener=useRef<(event:WheelEvent)=>void>(()=>{});
 wheelListener.current=event=>{
   const vertical=verticalScroll.current;
   const horizontal=scroll.current;
   if(!vertical||!horizontal)return;
   const unit=event.deltaMode===1?16:event.deltaMode===2?vertical.clientHeight:1;
   if(event.altKey){
     event.preventDefault();
     onTrackHeight(bound(trackHeight*(event.deltaY<0?1.12:1/1.12),36,180));
   }else if(event.ctrlKey||event.metaKey){
     event.preventDefault();
     changeZoom(zoom*(event.deltaY<0?1.25:1/1.25),event.clientX);
   }else if(event.shiftKey){
     event.preventDefault();
     horizontal.scrollLeft+=(event.deltaX||event.deltaY)*unit;
   }else if(Math.abs(event.deltaY)>Math.abs(event.deltaX)&&
     event.target instanceof Element&&event.target.closest('.timeline-time-scroll')){
     // Chromium swallows vertical wheel events over overflow-x:auto.
     // This container remains the sole vertical scroll owner.
     event.preventDefault();
     vertical.scrollTop+=event.deltaY*unit;
     if(event.deltaX)horizontal.scrollLeft+=event.deltaX*unit;
   }
 };
 useLayoutEffect(()=>{
   const vertical=verticalScroll.current;
   if(!vertical)return;
   const listener=(event:WheelEvent)=>wheelListener.current(event);
   vertical.addEventListener('wheel',listener,{passive:false});
   return()=>vertical.removeEventListener('wheel',listener);
 },[Boolean(media)]);

 function resizeLabels(event:ReactPointerEvent<HTMLDivElement>){
   event.preventDefault();
   event.stopPropagation();
   const element=event.currentTarget;
   const origin=event.clientX,initial=labelWidth;
   element.setPointerCapture(event.pointerId);
   const move=(e:PointerEvent)=>onLabelsResize(bound(initial+e.clientX-origin,155,350));
   const end=()=>{
     element.removeEventListener('pointermove',move);
     element.removeEventListener('pointerup',end);
     element.removeEventListener('pointercancel',end);
   };
   element.addEventListener('pointermove',move);
   element.addEventListener('pointerup',end,{once:true});
   element.addEventListener('pointercancel',end,{once:true});
 }
 if(!media)return <div className="timeline-empty" onClick={onOpen}
   role="button" tabIndex={0} onKeyDown={e=>e.key==='Enter'&&onOpen()}>
   <div className="empty-symbol"><img src="./file.svg" alt=""/></div>
   Перетащите файл или нажмите сюда, чтобы<br/>добавить видео/аудио на таймлайн
 </div>;

 const columns={
   '--track-sidebar':labelWidth+'px',
   '--acl-track-height':trackHeight+'px',
 } as CSSProperties;
 return <div className={'timeline-root tool-'+tool}>
   <div className="timeline-toolbar acl-toolbar" aria-label="Панель инструментов таймлайна">
     <div className="acl-toolbar-group acl-toolbar-zoom" role="group" aria-label="Масштаб таймлайна">
       <button type="button" className="acl-toolbar-icon acl-zoom-minus"
         aria-label="Уменьшить масштаб" title="Уменьшить масштаб"
         onClick={()=>changeZoom(zoom/1.25)}>
         <img src="./i_zoom_minus.svg" alt="" draggable={false}/>
       </button>
       <button type="button" className="acl-zoom-value"
         title="Текущий масштаб. Нажмите, чтобы показать весь проект (0)"
         aria-label={'Масштаб '+Math.round(zoom*100)+'%. Сбросить масштаб'}
         onClick={()=>changeZoom(1)}>{Math.round(zoom*100)}%</button>
       <button type="button" className="acl-toolbar-icon acl-zoom-plus"
         aria-label="Увеличить масштаб" title="Увеличить масштаб"
         onClick={()=>changeZoom(zoom*1.25)}>
         <img src="./i_zoom_plus.svg" alt="" draggable={false}/>
       </button>
     </div>
     <div className="acl-toolbar-group timeline-edit-tools acl-toolbar-modes" role="toolbar"
       aria-label="Инструменты аудиомонтажа">
       <button type="button" className={'acl-tool-icon'+(tool==='mouse'?' active':'')}
         onClick={()=>setTool('mouse')} aria-pressed={tool==='mouse'}
         aria-label="Выделение и перемещение" title="Выделение и перемещение (V)">
         <img src="./i_default.svg" alt="" draggable={false}/>
       </button>
       <button type="button" className={'acl-tool-icon'+(tool==='gain'?' active':'')}
         onClick={()=>setTool('gain')} aria-pressed={tool==='gain'}
         aria-label="Изменение громкости" title="Изменение громкости фрагмента (G)">
         <img src="./i_volume_levels.svg" alt="" draggable={false}/>
       </button>
       <button type="button" className={'acl-tool-icon'+(tool==='blade'?' active':'')}
         onClick={()=>setTool('blade')} aria-pressed={tool==='blade'}
         aria-label="Разрезание фрагмента" title="Разрезать фрагмент (B)">
         <img src="./i_cut.svg" alt="" draggable={false}/>
       </button>
       <button type="button" className={'acl-tool-icon'+(tool==='mute'?' active':'')}
         onClick={()=>setTool('mute')} aria-pressed={tool==='mute'}
         aria-label="Выключение фрагмента" title="Включить/выключить фрагмент (M)">
         <img src="./i_toggle_track.svg" alt="" draggable={false}/>
       </button>
       <button type="button" className={'acl-tool-icon acl-snap-toggle'+(snapEnabled?' enabled':'')}
         aria-pressed={snapEnabled}
         onClick={()=>{setSnapEnabled(v=>!v);setSnapGuide(null)}}
         aria-label="Магнитная привязка" title="Магнитная привязка (N). Alt временно отключает">
         <img src="./i_magnet.svg" alt="" draggable={false}/>
       </button>
     </div>
     <div className="acl-toolbar-group acl-toolbar-offset" role="group"
       aria-label="Точное смещение фрагмента">
       {selection&&!activeOffsetTrack?
         <div className="acl-toolbar-selection">
           <span title={timecode(selection.startMs,rate)+' — '+timecode(selection.endMs,rate)}>
             {((selection.endMs-selection.startMs)/1000).toFixed(3)} сек
           </span>
           <button type="button" onClick={onProcess} title="Обработать выделенный диапазон">
             Обработать
           </button>
           <button type="button" className="acl-toolbar-icon" onClick={()=>onSelectionChange(null)}
             title="Сбросить выделение" aria-label="Сбросить выделение">
             <img src="./i_reset.svg" alt="" draggable={false}/>
           </button>
         </div>:
         <>
           <img className="acl-offset-symbol" src="./i_offset.svg" alt="" draggable={false}/>
           <input ref={offsetInput} className="acl-offset-input"
             type="text" inputMode="decimal" aria-label="Смещение клипа в секундах"
             title={activeOffsetTrack?'Смещение: '+activeOffsetTrack.name:'Выберите фрагмент'}
             disabled={!activeOffsetTrack} value={activeOffsetTrack?offsetDraft:''}
             placeholder="0.000"
             onChange={event=>setOffsetDraft(event.target.value)}
             onBlur={()=>{
               if(skipOffsetBlur.current){skipOffsetBlur.current=false;return}
               commitOffset();
             }}
             onKeyDown={event=>{
               if(event.key==='Enter'){commitOffset();event.currentTarget.blur()}
               if(event.key==='Escape'){
                 skipOffsetBlur.current=true;
                 setOffsetDraft(((activeOffsetTrack?.offsetMs||0)/1000).toFixed(3));
                 event.currentTarget.blur();
               }
             }}/>
           <span className="acl-offset-unit">сек</span>
           <button type="button" className="acl-toolbar-icon acl-offset-reset"
             disabled={!activeOffsetTrack}
             title="Сбросить смещение к 0 секундам"
             aria-label="Сбросить смещение фрагмента"
             onPointerDown={event=>event.preventDefault()}
             onClick={()=>{
               if(!activeOffsetTrack)return;
               onMoveClip(activeOffsetTrack.id,0);
               setOffsetDraft('0.000');
             }}>
             <img src="./i_reset.svg" alt="" draggable={false}/>
           </button>
         </>
       }
     </div>
   </div>
   <div className="timeline-editor" ref={verticalScroll}>
     <div className="timeline-columns" style={columns}>
       <div className="timeline-sidebar-fixed">
         <div className="timeline-time-readout">
           <strong>{timecode(position,rate)}</strong><span>из</span>
           <b>{timecode(duration,rate)}</b>
           <div className="timeline-label-resize" onPointerDown={resizeLabels}
             title="Изменить ширину подписей дорожек"/>
         </div>
         <button className="timeline-sidebar-row timeline-sidebar-add" onClick={onOpen}>Заменить видео</button>
         <div className="timeline-sidebar-row track-label">
           <b>Video</b><img src="./more.svg" alt="Действия"/>
         </div>
         <button className="timeline-sidebar-row timeline-sidebar-add" onClick={onAddAudio}>Добавить аудио</button>
         {lanes.map(lane=>{
           const representative=lane.clips[0],locked=false;
           return <div className={'timeline-sidebar-row track-label lane-audio-label'+(movingLane===lane.id?' moving-lane':'')}
             key={lane.id} draggable={!locked&&renameId!==lane.id}
             onDragStart={event=>{
               if(locked)return;
               event.stopPropagation();
               setMovingLane(lane.id);event.dataTransfer.effectAllowed='move';
               event.dataTransfer.setData('text/plain',lane.id);
               event.dataTransfer.setData('application/x-acl-lane',lane.id);
             }}
             onDragOver={event=>{if(!locked){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move'}}}
             onDrop={event=>{
               event.preventDefault();event.stopPropagation();
               const from=event.dataTransfer.getData('application/x-acl-lane')||movingLane;
               if(from)onMoveLane(from,lane.id);
               setMovingLane(null);
             }}
             onDragEnd={event=>{event.stopPropagation();setMovingLane(null)}}
             onClick={()=>{if(!locked){setSelectedLane(lane.id);setSelectedClip(null)}}}
             onContextMenu={event=>{if(!locked)openContextMenu(event,undefined,lane.id)}}>
             {!locked&&<span className="lane-grip" title="Перетащить дорожку">⠿</span>}
             {renameId===lane.id&&!locked?
               <input className="lane-rename" autoFocus value={renameText}
                 aria-label="Название дорожки" maxLength={100}
                 onChange={event=>setRenameText(event.target.value)}
                 onBlur={commitRename}
                 onKeyDown={event=>{
                   if(event.key==='Enter')commitRename();
                   if(event.key==='Escape'){
                     renameCanceled.current=true;
                     setRenameId(null);
                   }
                 }}/>:
               <b title={locked?'Original — защищена от монтажа':'Двойной щелчок — переименовать'}
                 onDoubleClick={()=>{
                   if(locked)return;
                   setRenameId(lane.id);setRenameText(lane.name);
                 }}>{lane.name}</b>}
             <button type="button" className={'track-mute'+(representative.muted?' is-muted':'')}
               aria-pressed={representative.muted}
               title={representative.muted?'Включить звук':'Отключить звук'}
               onClick={()=>onToggleMute(representative.id)}>
               <img src={representative.muted?'./sound_disabled.svg':'./sound_enabled.svg'} alt=""/>
             </button>
             {!locked&&<>
               <button className="track-menu-button" type="button"
                 title="Действия с дорожкой"
                 onClick={event=>{event.stopPropagation();
                   const rect=event.currentTarget.getBoundingClientRect();
                   setContextMenu({x:Math.min(rect.left,window.innerWidth-215),
                     y:Math.min(rect.bottom+2,window.innerHeight-125),laneId:lane.id});
                   setSelectedLane(lane.id);setSelectedClip(null);
                 }}>⋯</button>
             </>}
           </div>;
         })}
         <div className="timeline-sidebar-row track-label disabled" title="Новая обработка">
           <b>Новая Clean</b><img src="./warning.svg" alt="Новая дорожка"/>
         </div>
       </div>
       <div className="timeline-time-column" ref={timeColumn}>
         <div className="timeline-ruler-fixed" onPointerDown={pointerDown}
           onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
           title="Перемотка · Shift + лезвие: разрезать все дорожки">
           <Ruler durationMs={duration} fps={rate} labels className="timeline-scale"
             totalWidthPx={width} visibleLeftPx={scrollOffset}
             visibleWidthPx={viewportWidth}/>
           <span className="timeline-ruler-playhead"
             style={{left:position*pxPerMs-scrollOffset}}
             title="Перетащить каретку" aria-hidden="true"/>
         </div>
         <div className="timeline-time-scroll" ref={scroll}
           onScroll={event=>{
             const left=event.currentTarget.scrollLeft;
             setScrollOffset(left);
             if(bottomScroll.current&&bottomScroll.current.scrollLeft!==left)
               bottomScroll.current.scrollLeft=left;
           }}
           onPointerMove={pointerHover} onPointerLeave={()=>setGhost(null)}>
           <div className="timeline-time-canvas" style={{width}}
             onContextMenu={event=>{
               if((event.target as HTMLElement).closest('.audio-clip-region'))return;
               const row=(event.target as HTMLElement).closest<HTMLElement>('[data-acl-lane-id]');
               openContextMenu(event,undefined,row?.dataset.aclLaneId);
             }}
             onClick={event=>{
               if(tool!=='mouse'||event.shiftKey)return;
               const target=event.target as HTMLElement;
               if(target.closest('.audio-clip-region,.clip-trim-handle,.clip-fade-handle,button'))return;
               onSeek(xFromClient(event.clientX)/Math.max(1,width)*duration);
             }}
             onPointerDown={event=>{
               if(tool==='blade'&&event.shiftKey&&event.button===0){
                 event.preventDefault();
                 onSplitAll(Math.round(xFromClient(event.clientX)/Math.max(1,width)*duration));
               }else selectDown(event);
             }} onPointerMove={selectMove}
             onPointerUp={selectUp} onPointerCancel={selectUp}>
             <div className="timeline-time-row time-add"/>
             <div className="timeline-time-row video-clip">
               {thumbnail&&<img className="clip-thumb" src={thumbnail} alt="Первый кадр"/>}

             </div>
             <div className="timeline-time-row time-add"/>
             {lanes.map(lane=><div className={'timeline-time-row audio-clip audio-lane '+lane.kind}
               key={lane.id} aria-label={lane.name} data-acl-lane-id={lane.id}>
               {lane.clips.map(track=>{
                 const offset=track.offsetMs||0;
                 const clipStyle:CSSProperties={
                   left:(offset/Math.max(1,duration)*100)+'%',
                   width:(track.durationMs/Math.max(1,duration)*100)+'%',
                 };
                 const fadeIn=track.fadeInMs||0,fadeOut=track.fadeOutMs||0;
                 return <div key={track.id}
                   className={'audio-clip-region'+(' clip-draggable')+
                     (selectedIds.includes(track.id)?' selected-clip':'')+(track.clipMuted?' clip-disabled':'')+(tool==='blade'?' clip-blade':'')}
                   style={{...clipStyle,...(track.color?{'--acl-clip-color':track.color} as CSSProperties:{})}}
                   title={tool==='gain'?'Перетащите вверх/вниз для изменения громкости'
                     :tool==='mute'?(track.clipMuted?'Включить фрагмент':'Выключить фрагмент')
                     :tool==='blade'?'Нажмите, чтобы разрезать фрагмент'
                     :track.kind==='original'&&track.durationMs+200<duration
                       ?'Original: аудиопоток короче видео ('+
                         timecode(track.durationMs,rate)+' из '+timecode(duration,rate)+')'
                       :'Перетащите для перемещения · двойной щелчок: точное смещение'}
                   onPointerDown={event=>{
                     if(clickBlade(event,track))return;
                     if(event.button!==0)return;
                     if(tool==='mute'){
                       event.preventDefault();event.stopPropagation();
                       onToggleClipsDisabled(selectedIds.includes(track.id)?selectedIds:[track.id]);
                       return;
                     }
                     if(tool==='gain'){editFade(event,track,'volume');return;}
                     moveClipStart(event,track);
                   }}
                   onPointerMove={event=>{
                     if(tool==='gain'&&!clipDrag.current&&!fadeDrag.current&&!trimDrag.current){
                       const box=event.currentTarget.getBoundingClientRect();
                       event.currentTarget.style.setProperty('--acl-gain-x',
                         Math.max(12,Math.min(box.width-12,event.clientX-box.left))+'px');
                     }
                     if(fadeDrag.current)editFadeMove(event);
                     else moveClipPointer(event);
                   }}
                   onPointerUp={event=>{
                     if(fadeDrag.current)editFadeEnd(event);
                     else moveClipEnd(event);
                   }}
                   onPointerCancel={event=>{
                     if(fadeDrag.current)editFadeEnd(event);
                     else moveClipEnd(event);
                   }}
                   onContextMenu={event=>{
                     openContextMenu(event,track.id);
                   }}
                   onDoubleClick={event=>{
                     event.stopPropagation();
                     if(tool==='gain'){
                       onUpdateClip(track.id,{clipGain:1});
                     }else if(tool==='mouse'){
                       offsetInput.current?.focus();
                       offsetInput.current?.select();
                     }
                   }}>
                   {track.peaks.length>0?
                     <Waveform peaks={track.peaks} durationMs={track.durationMs}
                       sourceStartMs={track.sourceStartMs||0}
                       intervalMs={track.waveIntervalMs||20}
                       gain={track.gain*(track.clipGain??1)}
                       fadeInMs={fadeIn} fadeOutMs={fadeOut}
                       fadeInCurve={track.fadeInCurve||0}
                       fadeOutCurve={track.fadeOutCurve||0}
                       detail={detailPeaks[track.id]}
                       visibleLeftPx={Math.max(0,scrollOffset-(track.offsetMs||0)*pxPerMs)}
                       viewportWidthPx={viewportWidth}
                       color={track.color||(track.kind==='clean'?'#85bf5d':'#57c5f3')}/>:
                     <span className="wave-loading">{track.error||
                       (track.pending?'Декодирование аудиодорожки…':'Звуковая волна недоступна')}</span>}
                   {<>
                     <span className="clip-trim-handle left" role="slider" tabIndex={0}
                       aria-label="Левая граница клипа" title="Изменить начало (включая скрытый звук)"
                       onPointerDown={event=>trimDown(event,track,'left')}
                       onPointerMove={trimMove} onPointerUp={trimEnd} onPointerCancel={trimEnd}/>
                     <span className="clip-trim-handle right" role="slider" tabIndex={0}
                       aria-label="Правая граница клипа" title="Изменить конец (включая скрытый звук)"
                       onPointerDown={event=>trimDown(event,track,'right')}
                       onPointerMove={trimMove} onPointerUp={trimEnd} onPointerCancel={trimEnd}/>
                     {clipFadeSvg('in',fadeIn,track.durationMs,track.fadeInCurve||0)}
                     {clipFadeSvg('out',fadeOut,track.durationMs,track.fadeOutCurve||0)}
                     <span className="clip-gain-knob"
                       role="slider" tabIndex={0} aria-label="Усиление аудиоклипа"
                       aria-valuemin={0} aria-valuemax={200}
                       aria-valuenow={Math.round((track.clipGain??1)*100)}
                       onPointerDown={event=>{if(tool==='gain')editFade(event,track,'volume')}}
                       onPointerMove={editFadeMove} onPointerUp={editFadeEnd}
                       onPointerCancel={editFadeEnd}
                       onDoubleClick={event=>{
                         event.preventDefault();event.stopPropagation();
                         onUpdateClip(track.id,{clipGain:1});
                       }}
                       title={'Усиление: '+((track.clipGain??1)<=0?'-∞':
                         (20*Math.log10(track.clipGain??1)).toFixed(1))+' dB · двойной щелчок — сброс'}>
                       <span>{(track.clipGain??1)<=0?'-∞':
                         (20*Math.log10(track.clipGain??1)).toFixed(1)} dB</span>
                     </span>
                     {fadeIn>20&&<span className="clip-fade-bend in"
                       style={{
                         left:Math.min(100,fadeIn/Math.max(1,track.durationMs)*50)+'%',
                         top:(1-fadeGain(.5,track.fadeInCurve||0))*100+'%',
                       }}
                       title="Изгиб Fade in: потяни вертикально"
                       onPointerDown={event=>editFade(event,track,'inBend')}
                       onPointerMove={editFadeMove} onPointerUp={editFadeEnd}
                       onPointerCancel={editFadeEnd}/>}
                     {fadeOut>20&&<span className="clip-fade-bend out"
                       style={{
                         left:(100-Math.min(100,fadeOut/Math.max(1,track.durationMs)*50))+'%',
                         top:(1-fadeGain(.5,track.fadeOutCurve||0))*100+'%',
                       }}
                       title="Изгиб Fade out: потяни вертикально"
                       onPointerDown={event=>editFade(event,track,'outBend')}
                       onPointerMove={editFadeMove} onPointerUp={editFadeEnd}
                       onPointerCancel={editFadeEnd}/>}
                     <span className="clip-fade-handle fade-in"
                       style={{left:`clamp(10px, ${Math.min(100,fadeIn/Math.max(1,track.durationMs)*100)}%, calc(100% - 10px))`}}
                       onPointerDown={event=>editFade(event,track,'in')}
                       onPointerMove={editFadeMove} onPointerUp={editFadeEnd}
                       onPointerCancel={editFadeEnd}
                       title={'Fade in: '+(fadeIn/1000).toFixed(2)+' сек'}/>
                     <span className="clip-fade-handle fade-out"
                       style={{left:`clamp(10px, ${100-Math.min(100,fadeOut/Math.max(1,track.durationMs)*100)}%, calc(100% - 10px))`}}
                       onPointerDown={event=>editFade(event,track,'out')}
                       onPointerMove={editFadeMove} onPointerUp={editFadeEnd}
                       onPointerCancel={editFadeEnd}
                       title={'Fade out: '+(fadeOut/1000).toFixed(2)+' сек'}/>
                   </>}
                 </div>;
               })}
             </div>)}
             <div className="timeline-time-row audio-clip missing" ref={missingRow}
               aria-hidden="true"/>
             {selection&&<div className="timeline-range-overlay"
               style={{
                 left:selection.startMs*pxPerMs,
                 width:Math.max(1,(selection.endMs-selection.startMs)*pxPerMs),
               }}/>}
             {snapGuide!==null&&<div className="timeline-snap-guide"
               style={{left:snapGuide*pxPerMs}} aria-hidden="true">
               <span>{timecode(snapGuide,rate)}</span>
             </div>}
             {ghost!==null&&!scrubbing&&<div className="timeline-ghost" style={{left:ghost}}>
               <span className="ghost-handle"/><span className="ghost-stem"/>
             </div>}
             <div className="timeline-playhead" style={{left:position*pxPerMs}}>
               
               <div className="playhead-stem"/>
             </div>
           </div>
         </div>
         {ghost!==null&&!scrubbing&&!selecting.current&&<div className="timeline-time-tooltip"
           style={{left:bound(ghost-scrollOffset,52,Math.max(52,viewportWidth-54)),
             top:Math.max(72,hoverY)}}>
           {timecode(ghost/Math.max(1,width)*duration,rate)}
         </div>}
         <div className="timeline-pinned-clip-labels"
           style={{'--caption-inset':(Math.max(10,58-scrollOffset)+'px')} as CSSProperties}
           >
                      <div className="pinned-row pinned-add-space"/>
           <div className="pinned-row pinned-clip-name"><span title={media.name}>{media.name}</span></div>
           <div className="pinned-row pinned-add-space"/>
           {lanes.map(lane=>{
             const visible=lane.clips.filter(clip=>{
               const from=(clip.offsetMs||0)*pxPerMs;
               const to=((clip.offsetMs||0)+clip.durationMs)*pxPerMs;
               return to>scrollOffset&&from<scrollOffset+viewportWidth;
             });
             return <div className="pinned-row pinned-clip-name pinned-audio-label" key={lane.id}>
               {visible.map(clip=>{
                 const from=(clip.offsetMs||0)*pxPerMs-scrollOffset;
                 const to=((clip.offsetMs||0)+clip.durationMs)*pxPerMs-scrollOffset;
                 const left=Math.max(8,from+8);
                 const available=Math.max(0,Math.min(viewportWidth-8,to-6)-left);
                 return <span key={clip.id} title={clip.path}
                   style={{left,right:'auto',width:'max-content',maxWidth:available}}>
                   {clip.name}
                 </span>;
               })}
               {visible.filter(clip=>clip.fx).map(clip=>{
                 const endX=((clip.offsetMs||0)+clip.durationMs)*pxPerMs-scrollOffset;
                 const startX=(clip.offsetMs||0)*pxPerMs-scrollOffset;
                 const left=Math.max(8,Math.min(viewportWidth-29,endX-29));
                 if(left<startX)return null;
                 return <button key={clip.id} className="lane-fx-badge"
                   style={{left,right:'auto'}} type="button"
                   title="Эффекты этого фрагмента"
                   onClick={()=>onOpenProperties(lane.id,clip.id)}>fx</button>;
               })}
             </div>;
           })}
           <div className="pinned-row pinned-empty-space"/>
         </div>
         <div className="timeline-clean-overlay"
           style={{left:0,top:missingTop}}>
           <span>Создать новую очищенную аудиодорожку</span>
           <button type="button" onClick={onProcess}>Обработать видео</button>
         </div>
       </div>
     </div>
   </div>
   <div className="timeline-bottom-scrollbar" style={columns}>
     <div className="timeline-bottom-scrollbar-label" aria-hidden="true"/>
     <div className="timeline-horizontal-scroll" ref={bottomScroll}
       style={{maxWidth:viewportWidth}}
       onScroll={event=>{
         const left=event.currentTarget.scrollLeft;
         if(scroll.current&&scroll.current.scrollLeft!==left)
           scroll.current.scrollLeft=left;
       }}
       aria-label="Горизонтальная прокрутка таймлайна">
       <div className="timeline-horizontal-extent" style={{width}}/>
     </div>
   </div>
   {contextMenu&&<div className="timeline-context-menu acl-context-menu" role="menu"
     ref={contextMenuRef}
     style={{position:'fixed',left:contextMenu.x,top:contextMenu.y}}
     onPointerDown={event=>event.stopPropagation()}
     onContextMenu={event=>event.preventDefault()}
     onKeyDown={event=>{
       if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setContextMenu(null);return;}
       if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
       event.preventDefault();
       const buttons=Array.from(contextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
         '[role="menuitem"]:not(:disabled)')||[]);
       if(!buttons.length)return;
       let i=buttons.indexOf(document.activeElement as HTMLButtonElement);
       if(event.key==='Home')i=0;
       else if(event.key==='End')i=buttons.length-1;
       else i=(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
       buttons[i]?.focus();
     }}>
     {contextMenu.clipId?(()=>{
       const clip=tracks.find(c=>c.id===contextMenu.clipId);
       const ids=selectedIds.includes(contextMenu.clipId!)?selectedIds:[contextMenu.clipId!];
       return <>
         <div className="acl-context-heading">{ids.length>1?ids.length+' фрагментов':'Фрагмент'}</div>
         <button type="button" role="menuitem" onClick={()=>{
           onCutClip(contextMenu.clipId!);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/cut.svg" alt=""/></span><span>Вырезать</span><kbd>Ctrl+X</kbd></button>
         <button type="button" role="menuitem" onClick={()=>{
           onCopyClip(contextMenu.clipId!);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/copy.svg" alt=""/></span><span>Копировать</span><kbd>Ctrl+C</kbd></button>
         <button type="button" role="menuitem" onClick={()=>{
           setSelectedIds(onDuplicateClips(ids));setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/double.svg" alt=""/></span><span>Дублировать</span><kbd>Ctrl+D</kbd></button>
         <div className="acl-context-divider" role="separator"/>
         <button type="button" role="menuitem" onClick={()=>{
           onSplitClip(contextMenu.clipId!,position);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./i_cut.svg" alt=""/></span><span>Разрезать по каретке</span></button>
         <button type="button" role="menuitem" onClick={()=>{
           onToggleClipsDisabled(ids);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./i_toggle_track.svg" alt=""/></span>
           <span>{ids.some(id=>!tracks.find(t=>t.id===id)?.clipMuted)?
             'Выключить звук':'Включить звук'}</span>
         </button>
         <button type="button" role="menuitem" onClick={()=>{
           for(const id of ids)onUpdateClip(id,{clipGain:1});
           setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./i_reset.svg" alt=""/></span><span>Сбросить усиление</span></button>
         <div className="acl-context-divider" role="separator"/>
         <div className="acl-context-heading">Цвет фрагмента</div>
         <div className="acl-context-colors" role="group" aria-label="Цвет фрагмента">
           {CLIP_COLORS.map(color=><button key={color} type="button"
             role="menuitem" className={clip?.color===color?'current':''}
             aria-label={'Выбрать цвет '+color} title={color}
             style={{'--acl-menu-color':color} as CSSProperties}
             onClick={()=>{onColorClips(ids,color);setContextMenu(null)}}/>)}
         </div>
         <div className="acl-context-divider" role="separator"/>
         <button type="button" role="menuitem" onClick={()=>{
           if(clip)onOpenProperties(clip.laneId||clip.id,clip.id);
           setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/property.svg" alt=""/></span><span>Свойства и эффекты</span></button>
         <button type="button" role="menuitem" className="destructive" onClick={()=>{
           onRemoveClips(ids);setSelectedIds([]);setSelectedClip(null);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/delete.svg" alt=""/></span><span>Удалить {ids.length>1?'фрагменты':'фрагмент'}</span><kbd>Del</kbd></button>
       </>;
     })():contextMenu.laneId?(()=>{
       const lane=lanes.find(l=>l.id===contextMenu.laneId);
       return <>
         <div className="acl-context-heading">{lane?.name||'Дорожка'}</div>
         <button type="button" role="menuitem" onClick={()=>{
           if(lane)onToggleMute(lane.clips[0].id);
           setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./i_toggle_track.svg" alt=""/></span>
           <span>{lane?.clips[0].muted?'Включить дорожку':'Выключить дорожку'}</span></button>
         <button type="button" role="menuitem" onClick={()=>{
           if(lane){setRenameId(lane.id);setRenameText(lane.name)}
           setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/rename.svg" alt=""/></span><span>Переименовать</span></button>
         <button type="button" role="menuitem" onClick={()=>{
           onOpenProperties(contextMenu.laneId!);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/property.svg" alt=""/></span><span>Свойства и эффекты</span></button>
         <div className="acl-context-divider" role="separator"/>
         <button type="button" role="menuitem" className="destructive" onClick={()=>{
           onRemoveLane(contextMenu.laneId!);setSelectedLane(null);setContextMenu(null);
         }}><span className="acl-menu-glyph"><img src="./menu/delete.svg" alt=""/></span><span>Удалить дорожку</span><kbd>Del</kbd></button>
       </>;
     })():<>
       <div className="acl-context-heading">Таймлайн</div>
       <button type="button" role="menuitem" disabled={!canPaste} onClick={()=>{
         onPasteClip(contextMenu.timeMs??position);setContextMenu(null);
       }}><span className="acl-menu-glyph"><img src="./menu/copy.svg" alt=""/></span><span>Вставить сюда</span><kbd>Ctrl+V</kbd></button>
       <button type="button" role="menuitem" onClick={()=>{
         onSeek(contextMenu.timeMs??position);setContextMenu(null);
       }}><span className="acl-menu-glyph"><img src="./play.svg" alt=""/></span><span>Переместить каретку сюда</span></button>
       <button type="button" role="menuitem" onClick={()=>{
         onSplitAll(contextMenu.timeMs??position);setContextMenu(null);
       }}><span className="acl-menu-glyph"><img src="./i_cut.svg" alt=""/></span><span>Разрезать все дорожки</span></button>
       {selection&&<button type="button" role="menuitem" onClick={()=>{
         onSelectionChange(null);setContextMenu(null);
       }}><span className="acl-menu-glyph"><img src="./menu/delete.svg" alt=""/></span><span>Сбросить выделение</span></button>}
     </>}
   </div>}
 </div>;
}
