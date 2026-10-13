import {useEffect,useRef,useState} from 'react';

export type HeaderMenuItem={
  id:string;
  label?:string;
  shortcut?:string;
  disabled?:boolean;
  separator?:boolean;
  checked?:boolean;
  onSelect?:()=>void;
};
export type HeaderMenu={id:string;label:string;items:HeaderMenuItem[]};

type Props={
  menus:HeaderMenu[];
  onBack:()=>void;
  onExport:()=>void;
  onProcess:()=>void;
  canExport:boolean;
  canProcess:boolean;
};

export function AppHeader({menus,onBack,onExport,onProcess,canExport,canProcess}:Props){
  const [openMenu,setOpenMenu]=useState<string|null>(null);
  const [maximized,setMaximized]=useState(false);
  const root=useRef<HTMLElement>(null);

  useEffect(()=>{
    void window.acl.windowState().then(s=>setMaximized(s.maximized)).catch(()=>{});
    return window.acl.onWindowState(s=>setMaximized(s.maximized));
  },[]);

  useEffect(()=>{
    if(!openMenu)return;
    const close=(event:PointerEvent)=>{
      if(!root.current?.contains(event.target as Node))setOpenMenu(null);
    };
    const keys=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();setOpenMenu(null)}
    };
    document.addEventListener('pointerdown',close);
    document.addEventListener('keydown',keys);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',keys)};
  },[openMenu]);

  function menuKey(event:React.KeyboardEvent<HTMLDivElement>,id:string){
    if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      event.preventDefault();
      const index=menus.findIndex(m=>m.id===id);
      const next=menus[(index+(event.key==='ArrowRight'?1:-1)+menus.length)%menus.length];
      setOpenMenu(next.id);
      requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>(
        '[data-menu-trigger="'+next.id+'"]')?.focus());
    }
    if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Home'||event.key==='End'){
      event.preventDefault();
      const group=root.current?.querySelector('[data-menu-panel="'+id+'"]');
      const buttons=Array.from(group?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[]);
      if(!buttons.length)return;
      let index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(event.key==='Home')index=0;
      else if(event.key==='End')index=buttons.length-1;
      else index=(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
      buttons[index]?.focus();
    }
  }

  return <header className={'acl-app-header'+(window.acl.nativeTitlebar?' acl-native-caption':'')} ref={root}>
    <div className="acl-header-left">
      <button type="button" className="acl-header-back" onClick={onBack}
        title="Открыть или заменить видео/аудио" aria-label="Открыть медиа">
        <img src="./arrow_left.svg" alt="" draggable={false}/>
      </button>
      <nav className="acl-header-menu-bar" aria-label="Главное меню">
        {menus.map(menu=><div className="acl-header-menu" key={menu.id}
          onMouseEnter={()=>{if(openMenu&&openMenu!==menu.id)setOpenMenu(menu.id)}}
          onKeyDown={event=>menuKey(event,menu.id)}>
          <button type="button" className={'acl-header-menu-trigger'+
            (openMenu===menu.id?' is-open':'')}
            data-menu-trigger={menu.id} aria-haspopup="menu" aria-expanded={openMenu===menu.id}
            onClick={()=>setOpenMenu(value=>value===menu.id?null:menu.id)}
            onKeyDown={event=>{
              if(['ArrowDown','Enter',' '].includes(event.key)){
                event.preventDefault();setOpenMenu(menu.id);
                requestAnimationFrame(()=>root.current?.querySelector<HTMLButtonElement>(
                  '[data-menu-panel="'+menu.id+'"] button:not(:disabled)')?.focus());
              }
            }}>{menu.label}</button>
          {openMenu===menu.id&&<div className="acl-header-dropdown" role="menu"
            data-menu-panel={menu.id} aria-label={menu.label}>
            {menu.items.map(item=>item.separator?
              <div className="acl-menu-separator" role="separator" key={item.id}/>:
              <button type="button" key={item.id} role="menuitem"
                disabled={item.disabled} onClick={()=>{
                  setOpenMenu(null);item.onSelect?.();
                }}>
                <span>{item.checked?'✓　':''}{item.label}</span>
                {item.shortcut&&<kbd>{item.shortcut}</kbd>}
              </button>)}
          </div>}
        </div>)}
      </nav>
    </div>
    <div className="acl-header-right">
      <button type="button" className="acl-header-action acl-header-subtitles"
        disabled title="Генерация субтитров будет добавлена позже">
        <img src="./subtitle.svg" alt="" draggable={false}/>
        Генерировать субтитры
        <img src="./new.svg" className="acl-header-new" alt="New" draggable={false}/>
      </button>
      <button type="button" className="acl-header-action acl-header-export"
        disabled={!canExport} onClick={onExport}
        title="Экспортировать аудиомикс в WAV">
        <img src="./export.svg" alt="" draggable={false}/>
        Экспортировать
      </button>
      <button type="button" className="acl-header-action acl-header-process"
        disabled={!canProcess} onClick={onProcess}
        title="Обработать аудио с помощью нейросети">
        <img src="./clear.svg" alt="" draggable={false}/>
        Обработать аудио
      </button>
      {!window.acl.nativeTitlebar&&<div className="acl-window-actions" role="group" aria-label="Управление окном">
        <button type="button" title="Свернуть" aria-label="Свернуть окно"
          onClick={()=>void window.acl.windowAction('minimize')}>
          <span className="acl-window-minimize"/>
        </button>
        <button type="button" title={maximized?'Восстановить':'Развернуть'}
          aria-label={maximized?'Восстановить окно':'Развернуть окно'}
          onClick={()=>void window.acl.windowAction('maximize')}>
          <span className={'acl-window-maximize'+(maximized?' is-restored':'')}/>
        </button>
        <button type="button" className="acl-window-close" title="Закрыть"
          aria-label="Закрыть окно"
          onClick={()=>void window.acl.windowAction('close')}>
          <span className="acl-window-cross"/>
        </button>
      </div>}
    </div>
  </header>;
}
