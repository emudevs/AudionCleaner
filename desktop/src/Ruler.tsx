import {useLayoutEffect,useMemo,useRef,useState} from 'react';
import {timecode} from './editor';

type RulerProps={
  durationMs:number;
  fps?:number;
  positionMs?:number;
  labels?:boolean;
  onSeek?:(timeMs:number)=>void;
  className?:string;
  /** Visible portion of a zoomed timeline, in the ruler's own pixels. */
  visibleLeftPx?:number;
  visibleWidthPx?:number;
  totalWidthPx?:number;
};

const NICE_SECONDS=[.1,.2,.25,.5,1,2,5,10,15,20,30,60,120,180,300,600,900,1200,1800,3600,7200,14400,28800,86400];

export function rulerStepMs(durationMs:number,widthPx:number):number{
  const desiredMs=Math.max(1,durationMs)*190/Math.max(1,widthPx);
  for(const seconds of NICE_SECONDS){
    if(seconds*1000>=desiredMs)return seconds*1000;
  }
  return Math.ceil(desiredMs/86400000)*86400000;
}

/**
 * Ruler uses a time-based adaptive major interval. Every major tick has
 * exactly 14 minor ticks before the next one, as in the Figma design.
 * Virtualization bounds work to visible pixels even at 4000% timeline zoom.
 */
export function Ruler({durationMs,fps=25,positionMs,labels=false,onSeek,
  className='',visibleLeftPx=0,visibleWidthPx,totalWidthPx}:RulerProps){
  const container=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(900);
  useLayoutEffect(()=>{
    const element=container.current;
    if(!element)return;
    const observer=new ResizeObserver(()=>setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return()=>observer.disconnect();
  },[]);
  const timeWidth=totalWidthPx||width;
  const step=rulerStepMs(durationMs,timeWidth);
  const marks=useMemo(()=>{
    if(durationMs<=0)return [];
    const pxStart=Math.max(0,visibleLeftPx-250);
    const pxEnd=Math.min(timeWidth,visibleLeftPx+(visibleWidthPx??width)+250);
    const startMs=pxStart/Math.max(1,timeWidth)*durationMs;
    const endMs=pxEnd/Math.max(1,timeWidth)*durationMs;
    const minor=step/15;
    const first=Math.max(0,Math.floor(startMs/minor)-2);
    const last=Math.min(Math.floor(durationMs/minor),Math.ceil(endMs/minor)+2);
    // A guard for extremely long media and pathological window sizes.
    const count=Math.min(5000,last-first+1);
    return Array.from({length:Math.max(0,count)},(_,offset)=>{
      const index=first+offset;
      const millis=index*minor;
      return {index,millis,major:index%15===0,left:millis/durationMs*timeWidth-visibleLeftPx};
    });
  },[durationMs,timeWidth,width,step,visibleLeftPx,visibleWidthPx]);
  return <div ref={container}
    className={`acl-ruler ${labels?'acl-ruler-labeled':''} ${className}`}
    role={onSeek?'slider':undefined}
    aria-label={onSeek?'Положение воспроизведения':undefined}
    aria-valuemin={onSeek?0:undefined}
    aria-valuemax={onSeek?Math.round(durationMs):undefined}
    aria-valuenow={onSeek?Math.round(positionMs||0):undefined}
    tabIndex={onSeek?0:undefined}
    onKeyDown={event=>{
      if(!onSeek)return;
      const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
      if(!delta)return;
      event.preventDefault();
      event.stopPropagation();
      onSeek(Math.max(0,Math.min(durationMs,(positionMs||0)+delta*step/15)));
    }}
    onPointerDown={event=>{
      if(!onSeek||durationMs<=0)return;
      const rect=event.currentTarget.getBoundingClientRect();
      onSeek(Math.max(0,Math.min(durationMs,(event.clientX-rect.left)/rect.width*durationMs)));
    }}>
    {marks.map(mark=><div key={mark.index}
      className={`acl-tick ${mark.major?'acl-tick-major':'acl-tick-minor'}`}
      style={{left:mark.left+'px'}}>
      {labels&&mark.major&&<span className="acl-tick-label">
        {timecode(mark.millis,fps)}
      </span>}
    </div>)}
  </div>;
}
