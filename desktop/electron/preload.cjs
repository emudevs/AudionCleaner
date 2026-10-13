const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('acl',{
 nativeTitlebar:process.platform==='win32'||process.platform==='darwin',
 windowAction:action=>ipcRenderer.invoke('acl:window-action',action),
 windowState:()=>ipcRenderer.invoke('acl:window-state'),
 onWindowState:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('acl:window-state',listener);return ()=>ipcRenderer.removeListener('acl:window-state',listener)},
 request:(method,params={},id)=>ipcRenderer.invoke('acl:request',method,params,id),
 openMedia:()=>ipcRenderer.invoke('acl:open-media'),
 saveAudio:name=>ipcRenderer.invoke('acl:save-audio',name),
 saveProject:(document,existingPath,saveAs=false)=>ipcRenderer.invoke('acl:project-save',document,existingPath,saveAs),
 openProject:()=>ipcRenderer.invoke('acl:project-open'),
 registerMedia:path=>ipcRenderer.invoke('acl:register-media',path),
 releaseMedia:url=>ipcRenderer.invoke('acl:release-media',url),
 diagnostics:()=>ipcRenderer.invoke('acl:diagnostics'),
 forceStopBackend:()=>ipcRenderer.invoke('acl:force-stop'),
 restartBackend:()=>ipcRenderer.invoke('acl:restart-backend'),
 filePath:file=>webUtils.getPathForFile(file),
 onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('acl:event',listener);return ()=>ipcRenderer.removeListener('acl:event',listener)}
});
