import {useEffect,useState} from 'react';
import type {EditorTrack,MediaInfo} from './editor';
import {SettingsPanel} from './SettingsPanel';

type Props={
  tracks:EditorTrack[];
  scope:'clip'|'lane';
  media:MediaInfo|null;
  settings:Record<string,unknown>;
  postProfiles:Record<string,Record<string,unknown>>;
  busy:boolean;
  onApply:(values:Record<string,unknown>)=>void;
  onReset:()=>void;
  onClose:()=>void;
};
const pretty=(n:number)=> (n/1000).toFixed(3)+' сек';

export function LaneEffectsDialog({tracks,scope,media,settings,postProfiles,busy,onApply,onReset,onClose}:Props){
  const first=tracks[0];
  const [values,setValues]=useState<Record<string,unknown>>(
    ()=>({...settings,...(first?.fxSettings||{})}));
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();onClose()}};
    document.addEventListener('keydown',key);
    return()=>document.removeEventListener('keydown',key);
  },[onClose]);
  if(!first)return null;
  const begin=Math.min(...tracks.map(t=>t.offsetMs||0));
  const end=Math.max(...tracks.map(t=>(t.offsetMs||0)+t.durationMs));
  return <div className="dialog-shade lane-props-shade" onPointerDown={event=>{
    if(event.currentTarget===event.target)onClose();
  }}>
    <section className="lane-props-dialog acl-modal acl-effects-modal" role="dialog" aria-modal="true"
      aria-labelledby="lane-props-title">
      <header className="lane-props-heading">
        <div className="acl-modal-titles">
          <h3 id="lane-props-title">{scope==='clip'?'Свойства фрагмента':'Свойства дорожки'} · {first.name}</h3>
        </div>
        <button type="button" className="acl-modal-close" title="Закрыть" aria-label="Закрыть свойства" onClick={onClose}>×</button>
      </header>
      <div className="lane-props-scroll">
        <div className="lane-props-meta">
          <div><strong>Источник</strong><span title={first.path}>{first.path.split(/[/\\]/).pop()}</span></div>
          <div><strong>Фрагментов</strong><span>{tracks.length}</span></div>
          <div><strong>Диапазон</strong><span>{pretty(begin)} – {pretty(end)}</span></div>
          <div><strong>Громкость</strong><span>{Math.round(first.gain*100)}%</span></div>
          <div><strong>Каналы</strong><span>{first.channels||2}</span></div>
          <div><strong>Эффекты</strong><span>{first.fx?'Применены (fx)':'Не применены'}</span></div>
          {first.kind==='original'&&media&&<p>
            Original редактируется недеструктивно. Видео не меняется.
          </p>}
        </div>
        <h4>Постобработка и эффекты</h4>
        <SettingsPanel effectsOnly values={values}
          onChange={(key,value)=>setValues(old=>key==='post_profile'&&postProfiles[String(value)]?
            {...old,...postProfiles[String(value)],post_profile:value}:
            {...old,[key]:value,post_profile:'custom'})}/>
        <p className="lane-props-note">Эффекты создают новый WAV через FFmpeg.
          Старый файл сохраняется. Ctrl+Z возвращает прежнюю версию {scope==='clip'?'фрагмента':'дорожки'}.
          При включении восстановления ВЧ высокие частоты берутся из исходного видео.</p>
      </div>
      <footer className="lane-props-actions">
        {first.fx&&<button type="button" disabled={busy} onClick={onReset}>Сбросить эффекты</button>}
        <button type="button" disabled={busy} onClick={onClose}>Закрыть</button>
        <button type="button" className="primary" disabled={busy}
          onClick={()=>onApply(values)}>{busy?'Применение эффектов…':'Применить эффекты'}</button>
      </footer>
    </section>
  </div>;
}
