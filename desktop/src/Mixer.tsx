import {useRef} from 'react';
import type {PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent} from 'react';
import type {EditorTrack} from './editor';
import {groupLanes} from './editorOperations';

type Props = {
  tracks: EditorTrack[];
  levels: Record<string,[number,number]>;
  onUpdate: (id:string,patch:Partial<EditorTrack>) => void;
};

const MIN_DB = -45;
const MAX_DB = 15; // The blue rightmost '15.0' is the current gain ceiling.
const LABELS = [-34,-28,-22,-16,-10,-7,-4,-1,0,3,5,9];
const normalized = (db:number) => Math.max(0,Math.min(100,(db-MIN_DB)/(MAX_DB-MIN_DB)*100));
const dbFromGain = (gain:number) => gain<=0?MIN_DB:Math.max(MIN_DB,Math.min(MAX_DB,20*Math.log10(gain)));
const gainFromDb = (db:number) => db<=MIN_DB?0:10**(db/20);
const dbFromPeak = (value:number) => value<=0?MIN_DB:20*Math.log10(value);

function BalanceKnob({value,disabled,onChange}:{
  value:number;disabled?:boolean;onChange:(v:number)=>void;
}) {
  const dragging=useRef<{x:number;original:number}|null>(null);
  const update=(value:number)=>onChange(Math.max(-1,Math.min(1,Math.round(value*100)/100)));
  function down(event:ReactPointerEvent<HTMLButtonElement>){
    if(disabled)return;
    dragging.current={x:event.clientX,original:value};
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function move(event:ReactPointerEvent<HTMLButtonElement>){
    if(!dragging.current)return;
    update(dragging.current.original+(event.clientX-dragging.current.x)/65);
  }
  function keyDown(event:ReactKeyboardEvent<HTMLButtonElement>){
    if(event.key==='ArrowLeft'){event.preventDefault();update(value-.05)}
    if(event.key==='ArrowRight'){event.preventDefault();update(value+.05)}
    if(event.key==='Home'){event.preventDefault();update(-1)}
    if(event.key==='End'){event.preventDefault();update(1)}
    if(event.key==='0'){event.preventDefault();update(0)}
  }
  const direction=value*68;
  return <div className="balance-control" title={`Баланс L/R: ${value===0?'центр':value<0?`L ${Math.round(-value*100)}%`:`R ${Math.round(value*100)}%`}. Перетащите горизонтально, двойной щелчок — центр`}>
    <span className="balance-side">L</span>
    <button className="balance-knob" type="button" role="slider"
      disabled={disabled} aria-label="Баланс левого и правого каналов"
      aria-valuemin={-100} aria-valuemax={100} aria-valuenow={Math.round(value*100)}
      onPointerDown={down} onPointerMove={move}
      onLostPointerCapture={()=>dragging.current=null}
      onDoubleClick={()=>update(0)}
      onKeyDown={keyDown}
      onWheel={event=>{if(!disabled)update(value + (event.deltaY < 0 ? 0.04 : -0.04))}}>
      <svg width="23" height="23" viewBox="0 0 23 23" aria-hidden="true">
        <circle cx="11.5" cy="11.5" r="9.5" fill="#F8F8FA"/>
        <circle cx="11.5" cy="11.5" r="7.7" fill="#D9DADD"/>
        <line x1="11.5" y1="11.5" x2="11.5" y2="4.5" stroke="#15161B"
          strokeWidth="2.5" strokeLinecap="round"
          transform={`rotate(${direction} 11.5 11.5)`}/>
        <circle cx="11.5" cy="11.5" r="1.3" fill="#15161B"/>
      </svg>
    </button>
    <span className="balance-side">R</span>
  </div>;
}

function Meter({left,right,gain,change,disabled=false}:{
  left:number;right:number;gain:number;change:(v:number)=>void;disabled?:boolean;
}) {
  const gainDb=dbFromGain(gain);
  const pct=normalized(gainDb);
  const drag=useRef<number|null>(null);
  const root=useRef<HTMLDivElement>(null);
  const changeAt=(clientX:number)=>{
    const rect=root.current?.getBoundingClientRect();
    if(!rect||disabled)return;
    const ratio=Math.min(1,Math.max(0,(clientX-rect.left)/rect.width));
    change(gainFromDb(MIN_DB+ratio*(MAX_DB-MIN_DB)));
  };
  const down=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(disabled || event.button!==0)return;
    drag.current=event.pointerId;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    changeAt(event.clientX);
  };
  const move=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(drag.current===event.pointerId)changeAt(event.clientX);
  };
  const end=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(drag.current!==event.pointerId)return;
    drag.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const key=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
    let db=gainDb;
    if(event.key==='ArrowLeft'||event.key==='ArrowDown')db-=event.shiftKey?1:.25;
    else if(event.key==='ArrowRight'||event.key==='ArrowUp')db+=event.shiftKey?1:.25;
    else if(event.key==='Home')db=MIN_DB;
    else if(event.key==='End')db=MAX_DB;
    else return;
    event.preventDefault();
    event.stopPropagation();
    change(gainFromDb(Math.max(MIN_DB,Math.min(MAX_DB,db))));
  };
  return <div className={`mixer-meter ${disabled?'mixer-meter-disabled':''}`}>
    <div className="meter-lane meter-left">
      <div className="meter-fill" style={{width:normalized(dbFromPeak(left))+'%'}}/>
      <div className="zero-db" style={{left:normalized(0)+'%'}}/>
      {left>0 && <div className="meter-peak" style={{left:normalized(dbFromPeak(left))+'%'}}/>}
    </div>
    <div className="meter-scale" aria-hidden="true">
      <span className="meter-minus-infinity">-∞</span>
      {LABELS.map(db=><span className="meter-scale-label" key={db}
        style={{left:normalized(db)+'%'}}>{db}</span>)}
      <span className="meter-max">{MAX_DB.toFixed(1)}</span>
    </div>
    <div className="meter-lane meter-right">
      <div className="meter-fill" style={{width:normalized(dbFromPeak(right))+'%'}}/>
      <div className="zero-db" style={{left:normalized(0)+'%'}}/>
      {right>0 && <div className="meter-peak" style={{left:normalized(dbFromPeak(right))+'%'}}/>}
    </div>
    <div className="meter-fader-visual" style={{left:pct+'%'}} aria-hidden="true">
      <span className="meter-fader-line"/>
      <span className="meter-fader-end meter-fader-end-top"/>
      <span className="meter-fader-end meter-fader-end-bottom"/>
    </div>
    <div className="meter-fader-surface" ref={root}
      tabIndex={disabled?-1:0} role="slider" aria-label="Усиление аудиодорожки, dB"
      aria-valuemin={MIN_DB} aria-valuemax={MAX_DB}
      aria-valuenow={Number(gainDb.toFixed(2))}
      aria-valuetext={gainDb.toFixed(1)+' dB'}
      aria-disabled={disabled} title={'Усиление '+gainDb.toFixed(1)+' dB'}
      onPointerDown={down} onPointerMove={move}
      onPointerUp={end} onPointerCancel={end}
      onKeyDown={key}
      onDoubleClick={()=>{if(!disabled)change(1)}}
    />
  </div>;
}

function MixTrack({track,levels,onUpdate}:{
  track:Pick<EditorTrack,'id'|'name'|'muted'|'solo'|'gain'|'pan'>;
  levels:[number,number];onUpdate:Props['onUpdate'];
}) {
  return <div className="mixer-track">
    <div className="mixer-track-info">
      <strong title={track.name}>{track.name}</strong>
      <div className="mixer-switches">
        <button type="button" className={track.muted?'selected':''}
          aria-label={`Отключить звук ${track.name}`} aria-pressed={track.muted}
          onClick={()=>onUpdate(track.id,{muted:!track.muted})}>M</button>
        <button type="button" className={track.solo?'selected':''}
          aria-label={`Слушать только ${track.name}`} aria-pressed={track.solo}
          onClick={()=>onUpdate(track.id,{solo:!track.solo})}>S</button>
      </div>
    </div>
    <BalanceKnob value={track.pan} onChange={pan=>onUpdate(track.id,{pan})}/>
    <Meter left={levels[0]} right={levels[1]} gain={track.gain}
      change={gain=>onUpdate(track.id,{gain})}/>
  </div>;
}

function Placeholder({name}:{name:string}) {
  return <div className="mixer-track unavailable" aria-label={name+' недоступна'}>
    <div className="mixer-track-info"><strong>{name}</strong>
      <div className="mixer-switches"><button disabled>M</button><button disabled>S</button></div>
    </div>
    <BalanceKnob value={0} disabled onChange={()=>{}}/>
    <Meter left={0} right={0} gain={.9} disabled change={()=>{}}/>
  </div>;
}

export function Mixer({tracks,levels,onUpdate}:Props){
  return <div className="mixer-content">
    {!tracks.some(track=>track.kind==='original')&&<Placeholder name="Original"/>}
    {groupLanes(tracks).map(lane=>{
      const representative=lane.clips[0];
      const combined=lane.clips.reduce<[number,number]>((max,clip)=>{
        const pair=levels[clip.id]||[0,0];
        return [Math.max(max[0],pair[0]),Math.max(max[1],pair[1])];
      },[0,0]);
      return <MixTrack key={lane.id} track={representative}
        levels={combined} onUpdate={onUpdate}/>;
    })}
    {!tracks.some(track=>track.kind==='clean')&&<Placeholder name="Clean"/>}
  </div>;
}
