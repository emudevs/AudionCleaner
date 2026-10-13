import {useCallback,useEffect,useMemo,useState} from 'react';
import type {useEditor} from './useEditor';
import type {LayoutState} from './useEditorLayout';
import {makeProjectDocument,projectEditSignature} from './projectFormat';
import type {ProjectPanels} from './projectFormat';

type Editor=ReturnType<typeof useEditor>;
type Input={
 editor:Editor;
 layout:LayoutState;
 setLayout:(key:keyof LayoutState,value:number)=>void;
 panels:ProjectPanels;
 restorePanels:(panels:ProjectPanels)=>void;
};

export function useProjectFiles({editor,layout,setLayout,panels,restorePanels}:Input){
 const [projectPath,setProjectPath]=useState<string|null>(null);
 const [savedSignature,setSavedSignature]=useState<string|null>(null);
 const [fileBusy,setFileBusy]=useState(false);
 const [lastSavedMedia,setLastSavedMedia]=useState<string|null>(null);
 const [menuOpen,setMenuOpen]=useState(false);
 // Media playback updates position many times a second. Do not rebuild and
 // stringify the whole project on every clock tick.
 const baseSnapshot=useMemo(()=>editor.media?
   makeProjectDocument(editor.media.path,editor.stream,editor.tracks,editor.settings,
     0,editor.selection,layout,panels):null,
   [editor.media?.path,editor.stream,editor.tracks,editor.settings,
     editor.selection,layout,panels]);
 const signature=useMemo(()=>baseSnapshot?projectEditSignature(baseSnapshot):null,
   [baseSnapshot]);
 const snapshot=baseSnapshot?{...baseSnapshot,positionMs:Math.max(0,Math.round(editor.position))}:null;
 const dirty=!!snapshot&&signature!==savedSignature;

 // A replaced video begins a new unsaved project. Never overwrite the
 // previous project's file with a completely different video by accident.
 useEffect(()=>{
   if(projectPath&&lastSavedMedia&&editor.media&&
      editor.media.path!==lastSavedMedia){
     setProjectPath(null);
     setSavedSignature(null);
     setLastSavedMedia(null);
   }
 },[editor.media?.path,projectPath,lastSavedMedia]);

 const allowDiscard=useCallback(()=>!dirty||window.confirm(
   'В проекте есть несохранённые изменения. Продолжить без сохранения?'
 ),[dirty]);

 const saveProject=useCallback(async(saveAs=false)=>{
   if(!snapshot||fileBusy||editor.processId||editor.effectBusy){
     if(!snapshot)editor.setError('Для сохранения сначала открой видео или аудио.');
     return false;
   }
   setMenuOpen(false);
   setFileBusy(true);
   try{
     const result=await window.acl.saveProject(snapshot,
       snapshot.media.path===lastSavedMedia?projectPath:null,saveAs);
     if(!result)return false;
     setProjectPath(result.path);
     setLastSavedMedia(snapshot.media.path);
     setSavedSignature(projectEditSignature(snapshot));
     editor.setExportResult('Проект сохранён: '+result.path);
     return true;
   }catch(e){
     editor.setError('Сохранение проекта: '+String(e));
     return false;
   }finally{setFileBusy(false)}
 },[snapshot,fileBusy,editor.processId,editor.effectBusy,
   projectPath,lastSavedMedia,editor.setError,editor.setExportResult]);

 const openProject=useCallback(async()=>{
   if(fileBusy||editor.processId||editor.effectBusy)return false;
   setMenuOpen(false);
   if(!allowDiscard())return false;
   setFileBusy(true);
   try{
     const data=await window.acl.openProject();
     if(!data)return false;
     const ok=await editor.restoreProject(data.document);
     if(!ok)return false;
     for(const [key,value] of Object.entries(data.document.ui.layout||{})){
       if(key in layout && typeof value==='number')
         setLayout(key as keyof LayoutState,value);
     }
     restorePanels(data.document.ui.panels||panels);
     setProjectPath(data.path);
     setLastSavedMedia(data.document.media.path);
     setSavedSignature(projectEditSignature(data.document));
     editor.setExportResult('Проект открыт: '+data.path);
     return true;
   }catch(e){
     editor.setError('Открытие проекта: '+String(e));
     return false;
   }finally{setFileBusy(false)}
 },[fileBusy,editor.processId,editor.effectBusy,editor.restoreProject,
    editor.setError,editor.setExportResult,allowDiscard,setLayout,restorePanels,panels,layout]);

 const resetProjectAssociation=useCallback(()=>{
   setProjectPath(null);setSavedSignature(null);setLastSavedMedia(null);
 },[]);

 useEffect(()=>{
   const close=(e:BeforeUnloadEvent)=>{
     if(!dirty)return;
     e.preventDefault();
     e.returnValue='';
   };
   window.addEventListener('beforeunload',close);
   return()=>window.removeEventListener('beforeunload',close);
 },[dirty]);

 return {projectPath,dirty,fileBusy,menuOpen,setMenuOpen,saveProject,
   openProject,allowDiscard,resetProjectAssociation};
}
