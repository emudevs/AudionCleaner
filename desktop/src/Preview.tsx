import {useEffect,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import type {MediaInfo} from './editor';
import {fps,timecode} from './editor';
import {Ruler} from './Ruler';

type Props={
 media:MediaInfo|null;url:string;thumbnail:string;position:number;playing:boolean;unsupported:boolean;
 onToggle:()=>void;onSeek:(ms:number)=>void;onTime:(ms:number)=>void;
 onUnsupported:()=>void;onPause:()=>void;attachOriginal:(element:HTMLMediaElement|null)=>void;
 collapsed:boolean;onToggleCollapse:()=>void;
 globalMuted:boolean;onToggleGlobalMute:()=>void;
};
type Zoom='fit'|'fill'|number;
const levels=[10,25,50,75,100,125,150,200,300,400,600,800,1200,1600];
const STORE='acl.preview.zoom.v1';
function initialZoom():Zoom{
 const value=localStorage.getItem(STORE)||'fit';
 if(value==='fit'||value==='fill')return value;
 const num=Number(value);return levels.includes(num)?num:'fit';
}
export function Preview({media,url,thumbnail,position,playing,unsupported,onToggle,onSeek,
 onTime,onUnsupported,onPause,attachOriginal,collapsed,onToggleCollapse,
 globalMuted,onToggleGlobalMute}:Props){
 const [zoom,setZoom]=useState<Zoom>(initialZoom);
 const viewport=useRef<HTMLDivElement>(null);
 const pan=useRef<{pointerId:number;x:number;y:number;left:number;top:number}|null>(null);
 const [panning,setPanning]=useState(false);
 const [size,setSize]=useState({width:600,height:360});
 const duration=media?.durationMs||0;
 const rate=fps(media?.video?.frameRate);
 const current=timecode(position,rate);
 const end=timecode(duration,rate);
 useEffect(()=>{localStorage.setItem(STORE,String(zoom))},[zoom]);
 useEffect(()=>{
   const element=viewport.current;if(!element)return;
   const observer=new ResizeObserver(()=>setSize({width:element.clientWidth,height:element.clientHeight}));
   observer.observe(element);
   setSize({width:element.clientWidth,height:element.clientHeight});
   return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
   const el=viewport.current;
   if(!el || typeof zoom!=='number')return;
   el.scrollLeft=Math.max(0,(el.scrollWidth-el.clientWidth)/2);
   el.scrollTop=Math.max(0,(el.scrollHeight-el.clientHeight)/2);
 },[zoom,media?.path,size.width,size.height]);
 const numeric=typeof zoom==='number';
 const actualWidth=(media?.video?.width||size.width)*(numeric?zoom/100:1);
 const actualHeight=(media?.video?.height||size.height)*(numeric?zoom/100:1);
 const stageWidth=numeric?Math.max(size.width,actualWidth):size.width;
 const stageHeight=numeric?Math.max(size.height,actualHeight):size.height;
 const changeZoom=(value:Zoom)=>setZoom(value);
 const canPan=numeric&&(stageWidth>size.width+1||stageHeight>size.height+1);
 function panStart(event:ReactPointerEvent<HTMLDivElement>){
   if(!canPan||event.button!==0||!viewport.current)return;
   const node=viewport.current;
   pan.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,
     left:node.scrollLeft,top:node.scrollTop};
   node.setPointerCapture(event.pointerId);
   setPanning(true);
   event.preventDefault();
 }
 function panMove(event:ReactPointerEvent<HTMLDivElement>){
   const current=pan.current;
   if(!current||current.pointerId!==event.pointerId||!viewport.current)return;
   const node=viewport.current;
   node.scrollLeft=current.left-(event.clientX-current.x);
   node.scrollTop=current.top-(event.clientY-current.y);
   event.preventDefault();
 }
 function panEnd(event:ReactPointerEvent<HTMLDivElement>){
   if(pan.current?.pointerId!==event.pointerId)return;
   pan.current=null;
   setPanning(false);
   if(event.currentTarget.hasPointerCapture(event.pointerId))
     event.currentTarget.releasePointerCapture(event.pointerId);
 }
 useEffect(()=>{pan.current=null;setPanning(false)},[zoom,media?.path,collapsed]);
 const scaleRef=useRef(zoom);scaleRef.current=zoom;
 useEffect(()=>{
   const el=viewport.current;if(!el)return;
   const wheel=(event:WheelEvent)=>{
     if(!(event.ctrlKey||event.metaKey))return;
     event.preventDefault();
     const current=scaleRef.current;
     const index=typeof current==='number'?levels.indexOf(current):levels.indexOf(100);
     const next=Math.max(0,Math.min(levels.length-1,index+(event.deltaY<0?1:-1)));
     setZoom(levels[next]);
   };
   el.addEventListener('wheel',wheel,{passive:false});
   return()=>el.removeEventListener('wheel',wheel);
 },[]);

 return <section className={"panel preview"+(collapsed?" preview-collapsed":"")}>
   <button type="button" className="heading panel-button preview-heading-button"
     aria-expanded={!collapsed} onClick={onToggleCollapse}>
     Предпросмотр видео <img src={collapsed?"./arrow_down.svg":"./arrow_up.svg"} alt=""/>
   </button>
   <div className="screen">
     <div ref={viewport}
       className={'video-viewport'+(numeric?' video-viewport-zoomed':'')+
         (canPan?' video-viewport-pannable':'')+(panning?' video-viewport-panning':'')}
       onPointerDown={panStart} onPointerMove={panMove}
       onPointerUp={panEnd} onPointerCancel={panEnd}
       onLostPointerCapture={event=>panEnd(event)}>
       <div className={'video-stage '+(numeric?'video-stage-scaled':'video-stage-contained')}
         style={{width:stageWidth,height:stageHeight}}>
         {media?.hasVideo ? <>
           <video key={url} ref={attachOriginal as (element:HTMLVideoElement|null)=>void}
             src={url} muted playsInline preload="metadata" crossOrigin="anonymous" draggable={false}
             style={numeric?{width:actualWidth,height:actualHeight,objectFit:'contain'}:
               {width:'100%',height:'100%',objectFit:zoom==='fill'?'cover':'contain'}}
             onLoadedMetadata={e=>{
               if(position>0)e.currentTarget.currentTime=Math.min(position/1000,e.currentTarget.duration||position/1000);
             }}
             onTimeUpdate={e=>onTime(e.currentTarget.currentTime*1000)}
             onError={onUnsupported} onPause={onPause}/>
           {unsupported&&<div className="video-fallback">
             {thumbnail?<img src={thumbnail} alt="Кадр видео" draggable={false}
               style={numeric?{width:actualWidth,height:actualHeight,objectFit:'contain'}:
                 {width:'100%',height:'100%',objectFit:zoom==='fill'?'cover':'contain'}}/>:
               <span>Предпросмотр видео</span>}
             <div>Этот кодек недоступен Chromium. Для кадрового воспроизведения нужен видеопрокси.</div>
           </div>}
         </> : media ? <>
           <div className="audio-preview">♫　{media.name}</div>
           <audio key={url} ref={attachOriginal as (element:HTMLAudioElement|null)=>void}
             src={url} muted preload="metadata" crossOrigin="anonymous"
             onLoadedMetadata={e=>{
               if(position>0)e.currentTarget.currentTime=Math.min(position/1000,e.currentTarget.duration||position/1000);
             }}
             onTimeUpdate={e=>onTime(e.currentTarget.currentTime*1000)}
             onError={onUnsupported} onPause={onPause}/>
         </> : <span className="preview-placeholder">Предпросмотр видео</span>}
       </div>
     </div>
   </div>
   <div className="times">
     <strong>{current}</strong>
     <label className="video-scale-control" title="Масштаб видео, Ctrl + колесо для изменения">
       <img src="./audio_wave.svg" alt=""/>
       <span>Масштаб</span>
       <select aria-label="Масштаб видео" value={String(zoom)}
         onChange={e=>changeZoom(e.target.value==='fit'||e.target.value==='fill'?
           e.target.value:Number(e.target.value))}>
         <option value="fit">По размеру кадра</option>
         <option value="fill">Заполнить</option>
         {levels.map(level=><option value={level} key={level}>{level}%</option>)}
       </select>
     </label>
     <strong>{end}</strong>
   </div>
   <Ruler durationMs={duration} fps={rate} positionMs={position}
     onSeek={media?onSeek:undefined} className="preview-ruler"/>
   <input className="preview-seek" type="range" min={0} max={Math.max(1,duration)}
     value={position} disabled={!media} aria-label="Положение воспроизведения"
     style={{background:`linear-gradient(90deg,#5960f4 0%,#5960f4 ${position/Math.max(1,duration)*100}%,#18191C ${position/Math.max(1,duration)*100}%,#18191C 100%)`}}
     onChange={e=>onSeek(Number(e.target.value))}/>
   <div className="transport">
     {[
       ['go_to_the_start',()=>onSeek(0)],
       ['back_for_10_seconds',()=>onSeek(Math.max(0,position-10000))],
       [playing?'pause':'play',onToggle],
       ['fowart_by_10_seconds',()=>onSeek(Math.min(duration,position+10000))],
       ['go_to_the_end',()=>onSeek(duration)],
     ].map(([asset,callback],index)=><button key={index}
       disabled={!media||(unsupported&&index===2)}
       onClick={callback as ()=>void} title={String(asset)}>
       <img src={'./'+String(asset)+'.svg'} alt={String(asset)}/>
     </button>)}
     <div className="transport-spacer"/>
     <button type="button" className={'master-mute'+(globalMuted?' is-muted':'')}
       disabled={!media} aria-pressed={globalMuted}
       aria-label={globalMuted?'Включить звук всего проекта':'Отключить звук всего проекта'}
       title={globalMuted?'Включить звук всех дорожек':'Отключить звук всех дорожек'}
       onClick={onToggleGlobalMute}>
       <img className="master-icon" src={globalMuted?'./sound_disabled.svg':'./sound_enabled.svg'} alt=""/>
     </button>
   </div>
 </section>;
}
