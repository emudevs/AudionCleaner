import {useEffect,useRef} from 'react';
import type {WaveDetail} from './useWaveformDetails';
import {WAVE_BIN_MS,fadeGain} from './editorOperations';

type Props={
  peaks:[number,number][];
  durationMs:number;
  color:string;
  sourceStartMs?:number;
  intervalMs?:number;
  detail?:WaveDetail;
  visibleLeftPx?:number;
  viewportWidthPx?:number;
  gain?:number;
  fadeInMs?:number;
  fadeOutMs?:number;
  fadeInCurve?:number;
  fadeOutCurve?:number;
};

/**
 * A physically viewport-sized canvas in the otherwise full-width clip.
 * Even at 40x zoom, each visible pixel gets its own envelope sample.
 * Base overview data covers the full clip; detailed peaks overlay the
 * visible source window and are fetched separately on scroll/zoom.
 */
export function Waveform({peaks,durationMs,color,sourceStartMs=0,intervalMs=WAVE_BIN_MS,detail,
  visibleLeftPx=0,viewportWidthPx=0,gain=1,fadeInMs=0,fadeOutMs=0,
  fadeInCurve=0,fadeOutCurve=0}:Props){
 const canvas=useRef<HTMLCanvasElement>(null);
 const props=useRef({peaks,durationMs,color,sourceStartMs,intervalMs,detail,visibleLeftPx,viewportWidthPx,gain,fadeInMs,fadeOutMs,fadeInCurve,fadeOutCurve});
 const frame=useRef<number|null>(null);
 props.current={peaks,durationMs,color,sourceStartMs,intervalMs,detail,visibleLeftPx,viewportWidthPx,gain,fadeInMs,fadeOutMs,fadeInCurve,fadeOutCurve};

 function schedule(){
   if(frame.current!==null)return;
   frame.current=requestAnimationFrame(()=>{
     frame.current=null;
     const el=canvas.current;
     const parent=el?.parentElement;
     if(!el||!parent)return;
     const width=parent.clientWidth;
     const height=parent.clientHeight*.64;
     if(width<1||height<1)return;
     const p=props.current;
     const left=Math.max(0,Math.min(
       width,
       p.visibleLeftPx-65,
     ));
     const targetWidth=Math.max(1,Math.min(width-left,
       p.viewportWidthPx>0?p.viewportWidthPx+180:width));
     el.style.position='absolute';
     el.style.left=left+'px';
     el.style.top='50%';
     el.style.transform='translateY(-50%)';
     el.style.width=targetWidth+'px';
     el.style.height=Math.max(1,height)+'px';

     const ratio=Math.min(2,window.devicePixelRatio||1);
     const w=Math.max(1,Math.min(8192,Math.ceil(targetWidth*ratio)));
     const h=Math.max(1,Math.min(300,Math.ceil(height*ratio)));
     if(el.width!==w)el.width=w;
     if(el.height!==h)el.height=h;
     const ctx=el.getContext('2d');
     if(!ctx)return;
     ctx.clearRect(0,0,w,h);

     const binData=p.peaks;
     const high=p.detail;
     const clipStart=p.sourceStartMs;
     const total=Math.max(1,p.durationMs);
     const channelHeight=h*.225;
     const centers:[number,number]=[h*.26,h*.74];
     const shape:[number[],number[]]=[new Array<number>(w),new Array<number>(w)];
     const msPerPixel=total/Math.max(1,width);
     const samplesForPixel=Math.max(1,Math.ceil(msPerPixel/(high?.intervalMs||p.intervalMs)));
     function pick(t:number):[number,number]|null{
       if(high?.peaks.length && t>=high.startMs &&
           t<high.startMs+high.peaks.length*high.intervalMs){
         const idx=Math.min(high.peaks.length-1,
           Math.max(0,Math.floor((t-high.startMs)/high.intervalMs)));
         return high.peaks[idx];
       }
       const idx=Math.floor((t-clipStart)/p.intervalMs);
       return idx>=0&&idx<binData.length?binData[idx]:null;
     }
     for(let x=0;x<w;x++){
       const t=clipStart+(left+x/ratio)*msPerPixel;
       const sample=pick(t);
       if(!sample){
         shape[0][x]=Number.NaN;
         shape[1][x]=Number.NaN;
         continue;
       }
       let peakA=sample[0],peakB=sample[1];
       // Preserve transients when multiple detailed source bins occupy one pixel.
       if(samplesForPixel>1&&samplesForPixel<=20){
         for(let i=1;i<samplesForPixel;i++){
           const finer=pick(t+i*msPerPixel/samplesForPixel);
           if(finer){
             peakA=Math.max(peakA,finer[0]);
             peakB=Math.max(peakB,finer[1]);
           }
         }
       }
       // Audio-style logarithmic display scaling, not synthetic signal.
       // Render actual clip gain and fade shape, not just an overlay.
       const local=Math.max(0,t-clipStart);
       const inGain=p.fadeInMs>0?fadeGain(local/p.fadeInMs,p.fadeInCurve):1;
       const outGain=p.fadeOutMs>0?
         fadeGain((p.durationMs-local)/p.fadeOutMs,p.fadeOutCurve):1;
       const amplitude=Math.max(0,p.gain)*inGain*outGain;
       const scale=(v:number)=>channelHeight*
         Math.log1p(5*Math.min(2,Math.max(0,v*amplitude)))/Math.log1p(5);
       shape[0][x]=scale(peakA);
       shape[1][x]=scale(peakB);
     }

     for(let c=0;c<2;c++){
       const center=centers[c],data=shape[c];
       // A chunk that has not been decoded is not silence. Leave it blank.
       // High-resolution fragments can be noncontiguous after a scroll.
       let x=0;
       while(x<w){
         while(x<w&&!Number.isFinite(data[x]))x++;
         if(x>=w)break;
         const first=x;
         while(x<w&&Number.isFinite(data[x]))x++;
         const last=x-1;
         ctx.beginPath();
         ctx.moveTo(first,center-data[first]);
         for(let i=first+1;i<=last;i++)ctx.lineTo(i,center-data[i]);
         for(let i=last;i>=first;i--)ctx.lineTo(i,center+data[i]);
         ctx.closePath();
         ctx.fillStyle=p.color;
         ctx.globalAlpha=.9;
         ctx.fill();
         ctx.globalAlpha=1;
         ctx.strokeStyle='rgba(235,249,255,.4)';
         ctx.lineWidth=Math.max(.75,ratio*.55);
         ctx.beginPath();
         ctx.moveTo(first,center-data[first]);
         for(let i=first+1;i<=last;i++)ctx.lineTo(i,center-data[i]);
         ctx.stroke();
       }
     }
   });
 }

 useEffect(()=>{
   const el=canvas.current;
   if(!el)return;
   const parent=el.parentElement;
   const observer=new ResizeObserver(schedule);
   if(parent)observer.observe(parent);
   schedule();
   return()=>{
     observer.disconnect();
     if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null}
   };
 },[]);

 useEffect(()=>schedule(),[peaks,durationMs,color,sourceStartMs,intervalMs,detail,visibleLeftPx,viewportWidthPx,gain,fadeInMs,fadeOutMs,fadeInCurve,fadeOutCurve]);

 return <canvas className="waveform" ref={canvas} aria-label="Форма аудиосигнала"/>;
}
