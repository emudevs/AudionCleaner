'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('aclSetup',{
 onProgress:callback=>{
  const fn=(_event,message)=>callback(String(message));
  ipcRenderer.on('acl:setup-progress',fn);
  return ()=>ipcRenderer.removeListener('acl:setup-progress',fn);
 },
 onFailure:callback=>{
  const fn=(_event,message)=>callback(String(message));
  ipcRenderer.on('acl:setup-failure',fn);
  return ()=>ipcRenderer.removeListener('acl:setup-failure',fn);
 },
 retry:()=>ipcRenderer.send('acl:setup-retry'),
});
