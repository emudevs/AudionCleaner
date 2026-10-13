'use strict';
/** First-run Windows runtime setup. No system Python/Node/FFmpeg is required.
 * The Electron executable installs Python in the per-user ACL profile and
 * invokes bootstrap.py to populate a relocatable per-user venv.
 */
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const {spawn}=require('node:child_process');
const {pipeline}=require('node:stream/promises');

const PYTHON_VERSION='3.12.10';
const PYTHON_URL='https://www.python.org/ftp/python/'+PYTHON_VERSION+'/python-'+PYTHON_VERSION+'-amd64.exe';

function paths(dataDir){
 return {
  python:path.join(dataDir,'python','python.exe'),
  venv:path.join(dataDir,'.venv','Scripts','python.exe'),
  marker:path.join(dataDir,'.installed.json'),
  ready:path.join(dataDir,'.ready.json'),
 };
}
function ready(dataDir){
 const files=paths(dataDir);
 if(!Object.values(files).every(item=>fs.existsSync(item)))return false;
 try{
  const mark=JSON.parse(fs.readFileSync(files.marker,'utf8'));
  const finished=JSON.parse(fs.readFileSync(files.ready,'utf8'));
  return mark.schema===1 && mark.app_version==='1.0.0' &&
   mark.audio_separator==='0.47.0' && finished.app_version==='1.0.0' &&
   finished.models==='instrumental_full';
 }catch{return false}
}
function run(executable,args,options={},report=()=>{}){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{
   windowsHide:true,stdio:['ignore','pipe','pipe'],...options,
  });
  let errText='';
  const receive=chunk=>{
   const value=String(chunk);
   errText=(errText+value).slice(-12000);
   for(const line of value.split(/\r?\n|\r/g)){
    const clean=line.replace(/\x1b\[[0-9;]*m/g,'').trim();
    if(clean)report(clean);
   }
  };
  child.stdout.on('data',receive);
  child.stderr.on('data',receive);
  child.once('error',reject);
  child.once('close',code=>code===0?resolve():reject(
   Error(path.basename(executable)+' завершился с кодом '+code+'. '+errText.slice(-2000))));
 });
}
function requestDownload(url,redirects=0){
 return new Promise((resolve,reject)=>{
  if(redirects>5)return reject(Error('Слишком много перенаправлений'));
  const location=new URL(url);
  if(location.protocol!=='https:')return reject(Error('Загрузка разрешена только по HTTPS'));
  const request=https.get(location,{timeout:30000,headers:{'User-Agent':'ACL-Installer/2.0'}},
   response=>{
    if([301,302,303,307,308].includes(response.statusCode)){
     const dest=response.headers.location;
     response.resume();
     if(!dest)return reject(Error('Перенаправление без адреса'));
     return resolve(requestDownload(new URL(dest,location).href,redirects+1));
    }
    if(response.statusCode!==200){
     response.resume();
     return reject(Error('Сервер загрузки вернул HTTP '+response.statusCode));
    }
    resolve(response);
   });
  request.once('timeout',()=>request.destroy(Error('Превышено время ожидания загрузки')));
  request.once('error',reject);
 });
}
async function downloadPython(destination,progress){
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 for(let attempt=1;attempt<=3;attempt++){
  try{
   progress('Загружаю локальный Python '+PYTHON_VERSION+' ('+attempt+'/3)');
   const response=await requestDownload(PYTHON_URL);
   const size=Number(response.headers['content-length']||0);
   if(size>75*1024*1024)throw Error('Недопустимый размер установщика Python');
   const temp=destination+'.partial';
   const output=fs.createWriteStream(temp,{flags:'w'});
   let received=0,last=-1;
   response.on('data',chunk=>{
    received+=chunk.length;
    if(received>75*1024*1024)response.destroy(Error('Загружаемый файл слишком велик'));
    const pct=size?Math.floor(received/size*100):0;
    if(size&&pct>=last+5){last=pct;progress('Python: загружено '+pct+'%')}
   });
   await pipeline(response,output);
   if(received<5*1024*1024)throw Error('Загруженный установщик слишком мал');
   fs.renameSync(temp,destination);
   return;
  }catch(error){
   try{fs.rmSync(destination+'.partial',{force:true})}catch{}
   if(attempt===3)throw error;
   progress('Не удалось загрузить Python, повторяю: '+String(error.message||error));
  }
 }
}
async function installPython(dataDir,progress){
 const {python}=paths(dataDir);
 if(fs.existsSync(python))return python;
 const directory=path.dirname(python);
 fs.mkdirSync(directory,{recursive:true});
 const installer=path.join(dataDir,'python-installer.exe');
 try{
  await downloadPython(installer,progress);
  progress('Устанавливаю Python в каталог приложения (без прав администратора)…');
  await run(installer,['/quiet','InstallAllUsers=0','Include_pip=1',
   'Include_launcher=0','Include_tcltk=0','Include_test=0',
   'Include_doc=0','AssociateFiles=0','PrependPath=0',
   'Shortcuts=0','TargetDir='+directory],{},progress);
  if(!fs.existsSync(python))throw Error('Установщик Python не создал python.exe');
  await run(python,['-c','import venv, ssl, pip; print("Python готов")'],{},progress);
  return python;
 }finally{
  try{fs.rmSync(installer,{force:true})}catch{}
 }
}
async function ensureRuntime(dataDir,resourcesRoot,progress=()=>{}){
 if(process.platform!=='win32')throw Error('Автоматическая установка пока доступна только для Windows');
 if(ready(dataDir)){progress('Среда ACL готова');return paths(dataDir).venv}
 const py=await installPython(dataDir,progress);
 const bootstrap=path.join(resourcesRoot,'bootstrap.py');
 if(!fs.existsSync(bootstrap))throw Error('В сборке отсутствует bootstrap.py');
 progress('Настраиваю обработчик звука и GPU-зависимости. Первый запуск может занять некоторое время.');
 await run(py,['-u',bootstrap],{
  cwd:resourcesRoot,
  env:{...process.env,ACL_DATA_DIR:dataDir,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},
 },progress);
 if(!ready(dataDir))throw Error('Установка Python-бэкенда не завершена: проверка зависимостей не пройдена');
 progress('Все компоненты готовы. Открываю ACL…');
 return paths(dataDir).venv;
}
module.exports={ready,paths,ensureRuntime,run};
