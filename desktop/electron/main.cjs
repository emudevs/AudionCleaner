const {app,BrowserWindow,dialog,ipcMain,Menu}=require('electron');
const {registerScheme,registerPath,releasePath,releaseAll,activeGrants,activateScheme}=require('./media.cjs');
const {existsSync}=require('node:fs');
const {readProject,writeProject,replaceMissingPaths,validate}=require('./project-files.cjs');
registerScheme();
const path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {EventEmitter}=require('node:events');
const setup=require('./setup.cjs');
const backendEvents=new EventEmitter();
let win,backend,setupWin;
let setupActive=false;
let quitting=false;
function getRoot(){return app.isPackaged?process.resourcesPath:path.resolve(__dirname,'../..')}
function dataDir(){return app.getPath('userData')}
let restartAfterExit=false;
const pending=new Map();
function failPending(error){
 for(const job of pending.values()){
   if(job.timeout)clearTimeout(job.timeout);
   job.reject(error);
 }
 pending.clear();
}
function send(event){if(win&&!win.isDestroyed())win.webContents.send('acl:event',event)}
function startBackend(){
 const root=getRoot();
 const py=process.env.ACL_PYTHON || (app.isPackaged?
  setup.paths(dataDir()).venv:
  (process.platform==='win32'?path.join(root,'.venv','Scripts','python.exe'):path.join(root,'.venv','bin','python')));
 backend=spawn(py,['-u','-m','backend.service'],{
  cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true,
  detached:process.platform!=='win32',
  env:{...process.env,...(app.isPackaged?{ACL_DATA_DIR:dataDir()}:{}),PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}
 });
 const child=backend;
 let buffer='';
 backend.stdout.on('data',data=>{
  buffer+=data.toString('utf8');
   if(buffer.length>16*1024*1024){buffer='';send({type:'event',event:'backend.error',message:'Python IPC line exceeded 16 MB'});}
  let index;
  while((index=buffer.indexOf('\n'))>=0){
   const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
   try{
    const message=JSON.parse(line);
    if(message.type==='result'){
     const job=pending.get(message.id);if(job){pending.delete(message.id);if(job.timeout)clearTimeout(job.timeout);message.ok?job.resolve(message.result):job.reject(Error(message.error))}
    }else{
     if(message.event==='backend.ready')backendEvents.emit('ready',message);
     send(message);
    }
   }catch(error){send({type:'event',event:'backend.error',message:String(error)})}
  }
 });
 backend.stderr.on('data',data=>send({type:'event',event:'backend.log',message:data.toString().slice(-1000)}));
 backend.on('error',error=>{send({type:'event',event:'backend.error',message:'Python failed: '+error.message});failPending(error)});
 backend.on('close',code=>{
  if(backend===child)backend=null;
  failPending(Error('Python backend closed: '+code));
  if(restartAfterExit&&!quitting){
   restartAfterExit=false;
   setTimeout(()=>{if(!backend&&!quitting)startBackend()},400);
  }
 });
}

function killBackendTree(pid){
 if(!Number.isInteger(pid)||pid<2)throw Error('Invalid backend PID');
 if(process.platform==='win32'){
  execFileSync('taskkill',['/PID',String(pid),'/T','/F'],
    {windowsHide:true,timeout:7000,stdio:'ignore'});
  return;
 }
 // A model runner can start a new POSIX session. Killing only the
 // backend process group would leave that child alive.
 const lines=execFileSync('ps',['-eo','pid=,ppid='],
   {encoding:'utf8',timeout:2500}).split(/\r?\n/);
 const tree=new Map();
 for(const line of lines){
  const m=/^\s*(\d+)\s+(\d+)\s*$/.exec(line);
  if(!m)continue;
  const child=Number(m[1]),parent=Number(m[2]);
  if(!tree.has(parent))tree.set(parent,[]);
  tree.get(parent).push(child);
 }
 const victims=[],visited=new Set();
 const visit=current=>{
  if(visited.has(current))return;
  visited.add(current);
  for(const child of tree.get(current)||[])visit(child);
  victims.push(current);
 };
 visit(pid);
 for(const child of victims){
  try{process.kill(child,'SIGKILL')}catch(_error){}
 }
}
ipcMain.handle('acl:restart-backend',async()=>{
 // Never kill a live separation, export or waveform task.
 if(pending.size)throw Error('Дождись завершения фоновых задач перед перезапуском Python ('+pending.size+')');
 return new Promise((resolve,reject)=>{
  let timer;
  const cleanup=()=>{
   clearTimeout(timer);
   backendEvents.removeListener('ready',onReady);
  };
  const onReady=()=>{
   cleanup();
   resolve({restarted:true});
  };
  backendEvents.once('ready',onReady);
  timer=setTimeout(()=>{
   cleanup();
   reject(Error('Python не запустился после перезагрузки за 15 секунд'));
  },15000);
  if(!backend){
   restartAfterExit=false;
   startBackend();
   return;
  }
  restartAfterExit=true;
  try{killBackendTree(backend.pid)}
  catch(error){
   send({type:'event',event:'backend.log',message:'Restart Python: '+String(error)});
   try{backend.kill('SIGKILL')}catch(_ignored){}
  }
 });
});

ipcMain.handle('acl:force-stop',async()=>{
 if(!backend)return {stopped:false};
 restartAfterExit=true;
 const pid=backend.pid;
 try{killBackendTree(pid)}
 catch(error){
  send({type:'event',event:'backend.log',message:'Force stop: '+String(error)});
  try{backend.kill('SIGKILL')}catch(_error){}
 }
 return {stopped:true};
});

function sendWindowState(){
 if(win&&!win.isDestroyed())win.webContents.send('acl:window-state',{maximized:win.isMaximized()});
}
ipcMain.handle('acl:window-state',event=>{
 const target=BrowserWindow.fromWebContents(event.sender);
 if(!target)return {maximized:false};
 return {maximized:target.isMaximized()};
});
ipcMain.handle('acl:window-action',(event,action)=>{
 const target=BrowserWindow.fromWebContents(event.sender);
 if(!target||!['minimize','maximize','close'].includes(action))return false;
 if(action==='minimize')target.minimize();
 else if(action==='maximize')target.isMaximized()?target.unmaximize():target.maximize();
 else target.close();
 return true;
});
function createWindow(){
 if(process.platform!=='darwin')Menu.setApplicationMenu(null);
 win=new BrowserWindow({
  width:1480,height:940,minWidth:980,minHeight:660,
  // Windows uses the real system caption controls in the 40px header.
  // Linux keeps its previous custom buttons; macOS keeps normal traffic lights.
  frame:process.platform!=='linux',
  ...(process.platform==='win32'?{
    titleBarStyle:'hidden',
    titleBarOverlay:{color:'#0b0c0e',symbolColor:'#d8d9df',height:40},
  }:{}),
  backgroundColor:'#111214',
  webPreferences:{preload:path.join(__dirname,'preload.cjs'),
    contextIsolation:true,nodeIntegration:false,sandbox:false}
 });
 win.on('maximize',()=>sendWindowState());
 win.on('unmaximize',()=>sendWindowState());
 if(!app.isPackaged)win.loadURL('http://127.0.0.1:5173');
 else win.loadFile(path.join(__dirname,'../dist/index.html'));
}
ipcMain.handle('acl:request',(_event,method,params={},requestedId)=>{
 if(!backend || !backend.stdin.writable)return Promise.reject(Error('Python backend unavailable'));
 const id=typeof requestedId==='string' && /^[0-9a-f-]{36}$/i.test(requestedId)?requestedId:randomUUID();
 if(pending.has(id))return Promise.reject(Error('Duplicate IPC request ID'));
 const child=backend;
 return new Promise((resolve,reject)=>{
  const timeoutMs=method==='media.inspect'||method==='media.thumbnail'?120000:
    method==='media.waveform'||method==='process.start'?0:30000;
  const timeout=timeoutMs?setTimeout(()=>{
   pending.delete(id);
   reject(Error('Python не ответил на '+method+' за '+Math.round(timeoutMs/1000)+' секунд'));
  },timeoutMs):null;
  pending.set(id,{resolve,reject,timeout});
  child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{
   if(!error)return;
   const entry=pending.get(id);
   if(!entry)return;
   pending.delete(id);
   if(entry.timeout)clearTimeout(entry.timeout);
   reject(Error('Не удалось передать команду Python: '+error.message));
  });
 });
});
ipcMain.handle('acl:project-save',async(_event,document,existingPath,saveAs=false)=>{
 const validated=validate(document);
 let filePath=typeof existingPath==='string'&&!saveAs?existingPath:null;
 if(!filePath){
  const base=(validated.media.path||'Anime Audio Cleaner').split(/[\\/]/).pop()
    .replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*]/g,'_')||'Проект ACL';
  const result=await dialog.showSaveDialog(win,{
   title:'Сохранить проект Anime Audio Cleaner',
   defaultPath:base+'.aclproj',
   filters:[{name:'Проект Anime Audio Cleaner',extensions:['aclproj']}],
  });
  if(result.canceled||!result.filePath)return null;
  filePath=result.filePath.toLowerCase().endsWith('.aclproj')?result.filePath:result.filePath+'.aclproj';
 }
 return {path:await writeProject(filePath,validated)};
});
ipcMain.handle('acl:project-open',async()=>{
 const picked=await dialog.showOpenDialog(win,{
  title:'Открыть проект Anime Audio Cleaner',
  properties:['openFile'],
  filters:[{name:'Проект Anime Audio Cleaner',extensions:['aclproj']}],
 });
 if(picked.canceled||!picked.filePaths.length)return null;
 const loaded=await readProject(picked.filePaths[0]);
 if(!loaded.missing.length)return {path:loaded.path,document:loaded.document};
 const mapping=new Map();
 for(const missing of loaded.missing){
  const repaired=await dialog.showOpenDialog(win,{
   title:'Не найден исходный файл: '+path.basename(missing),
   message:'Укажите местоположение медиафайла, чтобы восстановить проект. Отмена оставит текущий проект без изменений.',
   defaultPath:path.dirname(missing),
   properties:['openFile'],
   filters:[{name:'Все файлы',extensions:['*']}],
  });
  if(repaired.canceled||!repaired.filePaths.length)return null;
  const replacement=repaired.filePaths[0];
  if(!existsSync(replacement))throw Error('Файл не найден: '+replacement);
  mapping.set(missing,replacement);
 }
 return {path:loaded.path,document:replaceMissingPaths(loaded.document,mapping)};
});

ipcMain.handle('acl:save-audio',async(_event,defaultName)=>{
 const result=await dialog.showSaveDialog(win,{
  title:'Экспортировать аудиомикс',
  defaultPath:typeof defaultName==='string'?defaultName:'ACL_mix.wav',
  filters:[{name:'Wave PCM',extensions:['wav']}]
 });
 return result.canceled?null:result.filePath;
});
ipcMain.handle('acl:open-media',async()=>{
 const result=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Media',extensions:['mkv','mp4','mov','avi','webm','mp3','wav','flac','aac','m4a','ogg','opus']},{name:'All',extensions:['*']}]});
 return result.canceled?null:{path:result.filePaths[0],url:registerPath(result.filePaths[0])};
});
ipcMain.handle('acl:diagnostics',async()=>({
  registeredMedia:activeGrants(),
  pendingIpcRequests:pending.size,
  electronMemory:await process.getProcessMemoryInfo(),
  processes:app.getAppMetrics().map(entry=>({
    pid:entry.pid,
    type:entry.type,
    memory:entry.memory,
  })),
}));
ipcMain.handle('acl:release-media',(_e,url)=>releasePath(url));
ipcMain.handle('acl:register-media',(_event,path)=>{
 if(typeof path!=='string'||!existsSync(path))throw Error('Media file missing');
 return registerPath(path);
});
function launchEditor(){
 if(quitting)return;
 startBackend();
 createWindow();
 if(setupWin&&!setupWin.isDestroyed())setupWin.close();
 setupWin=null;
}
async function startStandaloneSetup(){
 if(setupActive||quitting)return;
 setupActive=true;
 if(!setupWin||setupWin.isDestroyed()){
  setupWin=new BrowserWindow({
   width:700,height:475,minWidth:630,minHeight:440,
   backgroundColor:'#101116',resizable:false,autoHideMenuBar:true,
   webPreferences:{
    preload:path.join(__dirname,'setup-preload.cjs'),
    contextIsolation:true,nodeIntegration:false,sandbox:false,
   },
  });
  Menu.setApplicationMenu(null);
  await setupWin.loadFile(path.join(__dirname,'setup.html'));
 }
 const destination=dataDir();
 const progress=message=>{
  if(setupWin&&!setupWin.isDestroyed())
   setupWin.webContents.send('acl:setup-progress',String(message));
 };
 try{
  await setup.ensureRuntime(destination,getRoot(),progress);
  launchEditor();
 }catch(error){
  if(!setupWin||setupWin.isDestroyed())return;
  setupWin.webContents.send('acl:setup-failure',String(error.message||error));
 }finally{setupActive=false}
}
ipcMain.on('acl:setup-retry',event=>{
 if(!setupWin||setupWin.isDestroyed()||event.sender!==setupWin.webContents)return;
 void startStandaloneSetup();
});
app.whenReady().then(()=>{
 activateScheme();
 if(!app.isPackaged){
  launchEditor();
 }else if(process.platform==='win32'&&setup.ready(dataDir())){
  launchEditor();
 }else if(process.platform==='win32'){
  void startStandaloneSetup();
 }else{
  dialog.showErrorBox('Anime Audio Cleaner','Автоматическая установка этой сборки поддерживается только на Windows.');
  app.quit();
 }
 app.on('activate',()=>{
  if(BrowserWindow.getAllWindows().length===0){
   if(app.isPackaged&&!setup.ready(dataDir()))void startStandaloneSetup();
   else launchEditor();
  }
 });
}).catch(error=>{dialog.showErrorBox('Ошибка запуска ACL',String(error));app.quit()});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
app.on('before-quit',()=>{
 quitting=true;restartAfterExit=false;releaseAll();
 if(backend){
  try{killBackendTree(backend.pid)}
  catch(_error){try{backend.kill('SIGKILL')}catch(_ignored){}}
  backend=null;
 }
});
