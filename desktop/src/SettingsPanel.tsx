import {memo,useEffect, useState} from 'react';
import {sections, type Field} from './settingsFields';

type Props = {
  values: Record<string, unknown>;
  onChange: (key: string, value: string | number | boolean) => void;
  effectsOnly?:boolean;
};

function Control({field, value, onChange}: {field: Field; value: unknown; onChange: Props['onChange']}) {
  if (field.kind === 'select') {
    return <select id={field.key} value={String(value ?? field.values?.[0]?.[1] ?? '')}
      onChange={event => {
        const raw = event.target.value;
        onChange(field.key, raw === 'true' ? true : raw === 'false' ? false : raw);
      }}>
      {field.values?.map(([name, val]) =>
        <option key={String(val)} value={String(val)}>{name}</option>)}
    </select>;
  }
  return <NumericControl field={field} value={value} onChange={onChange}/>;
}

function NumericControl({field,value,onChange}: {field:Field;value:unknown;onChange:Props['onChange']}) {
  const [draft,setDraft] = useState(String(value ?? ''));
  useEffect(()=>setDraft(String(value ?? '')),[value]);
  const commit = () => {
    const parsed = Number(draft.replace(',','.'));
    if (draft.trim() && Number.isFinite(parsed)) onChange(field.key,parsed);
    else setDraft(String(value ?? ''));
  };
  return <div className="number-control">
    <input id={field.key} type="text" inputMode="decimal" value={draft}
      onChange={event=>setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur()}}/>
    {field.unit && <span>{field.unit}</span>}
  </div>;
}

export const SettingsPanel=memo(function SettingsPanel({values,onChange,effectsOnly=false}: Props) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  return <div className="settings-stack">
    {sections.filter(section=>!effectsOnly||section.name!=='Режим').map(section => <section className="settings-card" key={section.name}>
      <button className="settings-heading" onClick={() =>
        setFolded(previous => ({...previous, [section.name]: !previous[section.name]}))}>
        <img src={folded[section.name] ? './arrow_down.svg' : './arrow_up.svg'}/>
        {section.name}
      </button>
      {!folded[section.name] && <div className="settings-card-body">
        {section.groups.map((group, index) => {
          const key = section.name + '-' + index;
          return <div className={group.title ? 'settings-subgroup' : 'settings-lines'} key={key}>
            {group.title && <button className="settings-subheading" onClick={() =>
              setFolded(previous => ({...previous, [key]: !previous[key]}))}>
              <img src={folded[key] ? './arrow_down.svg' : './arrow_up.svg'}/>{group.title}
            </button>}
            {!folded[key] && group.fields.map(field =>
              <div key={field.key} className="setting">
                <div className="setting-line">
                  <label htmlFor={field.key}>{field.label}</label>
                  <Control field={field} value={values[field.key]} onChange={onChange}/>
                </div>
                {field.hint && <div className="setting-hint">{field.hint}</div>}
              </div>)}
          </div>;
        })}
      </div>}
    </section>)}
  </div>;
});
