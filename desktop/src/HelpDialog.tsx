import {useEffect,useRef} from 'react';

type Props={mode:'keys'|'about';onClose:()=>void};
const keys=[
 ['Открыть проект','Ctrl+O'],['Сохранить проект','Ctrl+S'],
 ['Сохранить как','Ctrl+Shift+S'],['Отменить / Повторить','Ctrl+Z / Ctrl+Y'],
 ['Копировать / Вырезать / Вставить','Ctrl+C / Ctrl+X / Ctrl+V'],
 ['Дублировать фрагмент','Ctrl+D'],['Экспортировать микс','Ctrl+M'],
 ['Выделить всё','Ctrl+A'],['Воспроизведение / Пауза','Пробел'],
 ['Выделение / Перемещение','V'],['Лезвие','B'],
 ['Управление громкостью','G'],['Выключение фрагмента','M'],
 ['Магнитная привязка','N'],['Перемотка','J / L, ← / →'],
 ['Масштаб таймлайна','+ / −'],['Масштаб 100%','0'],
];
export function HelpDialog({mode,onClose}:Props){
 const dialog=useRef<HTMLElement>(null);
 useEffect(()=>{
  const handle=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();onClose()}};
  document.addEventListener('keydown',handle,true);
  dialog.current?.focus();
  return()=>document.removeEventListener('keydown',handle,true);
 },[onClose]);
 const shortcuts=mode==='keys';
 return <div className="acl-dialog-shade" onPointerDown={e=>{
   if(e.target===e.currentTarget)onClose();
 }}>
  <section className="acl-modal acl-help-modal" role="dialog" aria-modal="true"
    aria-labelledby="acl-help-title" ref={dialog} tabIndex={-1}>
   <header className="acl-modal-header">
    <div className="acl-modal-titles">
     <h2 id="acl-help-title">{shortcuts?'Горячие клавиши':'О программе'}</h2>
    </div>
    <button type="button" className="acl-modal-close" onClick={onClose}
      title="Закрыть" aria-label="Закрыть окно">×</button>
   </header>
   <div className="acl-modal-body">
    {shortcuts?<>
      <div className="acl-help-section-heading">Монтаж и управление</div>
      <div className="acl-shortcut-grid">
       {keys.map(([label,shortcut])=><div className="acl-shortcut-row" key={label}>
        <span>{label}</span><div className="acl-shortcut-chords">
          {shortcut.split(' / ').map((s,i)=><kbd key={i}>{s}</kbd>)}
        </div>
       </div>)}
      </div>
      <p className="acl-help-hint">В текстовых полях горячие клавиши не перехватывают ввод.</p>
    </>:<>
      <div className="acl-about-identity">
       <div className="acl-about-mark"><img src="./audio_wave.svg" alt=""/></div>
       <div><strong>Anime Audio Cleaner</strong><span>ACL · 2.0.0 alpha</span></div>
      </div>
      <p className="acl-about-description">Многодорожечный аудиоредактор с нейросетевой очисткой звука.
        Работа с видеозаписями, клипами, эффектами и аудиомиксом в одном проекте.</p>
      <div className="acl-about-details">
       <span>Платформа</span><strong>Electron · React · Python</strong>
       <span>Обработка</span><strong>Локально на компьютере</strong>
       <span>Проекты</span><strong>.aclproj</strong>
      </div>
    </>}
   </div>
   <footer className="acl-modal-footer">
    <button type="button" className="primary" onClick={onClose}>Закрыть</button>
   </footer>
  </section>
 </div>;
}
