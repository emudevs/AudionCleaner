// Versioned on-disk project format and lossless media references.
// No media bytes, Electron-only URLs or waveform peaks are embedded.
'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

const KIND='anime-audio-cleaner-project';
const VERSION=1;
const EXT='.aclproj';
const MAX_SIZE=8*1024*1024;
const MAX_CLIPS=4096;

function assertString(value,name){
 if(typeof value!=='string'||!value.trim()||value.length>32768)
  throw Error('Некорректное поле проекта: '+name);
 return value;
}
function validate(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||
    data.format!==KIND||data.version!==VERSION)
  throw Error('Неподдерживаемый формат или версия проекта ACL');
 if(!data.media||typeof data.media!=='object')
  throw Error('Проект не содержит видео/аудиоисточник');
 assertString(data.media.path,'media.path');
 if(!Number.isInteger(data.media.stream)||data.media.stream<0||data.media.stream>1000)
  throw Error('Некорректная звуковая дорожка видео');
 if(!Number.isFinite(data.positionMs)||data.positionMs<0)
  throw Error('Некорректная позиция каретки');
 if(data.selection && (!Number.isFinite(data.selection.startMs)||
    !Number.isFinite(data.selection.endMs)||
    data.selection.startMs<0||data.selection.endMs<=data.selection.startMs))
  throw Error('Некорректная область выделения');
 if(!data.ui||!data.ui.layout||!data.ui.panels)
  throw Error('В проекте отсутствуют настройки интерфейса');
 if(!Array.isArray(data.tracks)||data.tracks.length>MAX_CLIPS)
  throw Error('Неверное количество клипов в проекте');
 const ids=new Set();
 for(const [i,t] of data.tracks.entries()){
  if(!t||typeof t!=='object'||Array.isArray(t))throw Error('Неверный клип '+i);
  assertString(t.id,'tracks['+i+'].id');
  assertString(t.path,'tracks['+i+'].path');
  if(ids.has(t.id))throw Error('В проекте повторяются идентификаторы клипов');
  ids.add(t.id);
  if(!['original','clean','import'].includes(t.kind))
   throw Error('Неизвестный тип аудиодорожки');
  if(!Number.isFinite(t.durationMs)||t.durationMs<=0||t.durationMs>172800000)
   throw Error('Некорректная длительность клипа '+i);
  if(t.sourceStartMs!==undefined&&
    (!Number.isFinite(t.sourceStartMs)||t.sourceStartMs<0))
   throw Error('Неверное смещение источника у клипа '+i);
  if(t.offsetMs!==undefined&&!Number.isFinite(t.offsetMs))
   throw Error('Неверное положение клипа '+i);
  if(t.streamIndex!==undefined&&
    (!Number.isInteger(t.streamIndex)||t.streamIndex<0))
   throw Error('Неверный индекс аудиопотока');
  for(const parameter of ['gain','clipGain','pan','fadeInMs','fadeOutMs',
    'fadeInCurve','fadeOutCurve']){
   if(t[parameter]!==undefined&&!Number.isFinite(t[parameter]))
    throw Error('Некорректный параметр '+parameter+' у клипа '+i);
  }
  if(t.fxOriginal){
   if(typeof t.fxOriginal!=='object')throw Error('Некорректный исходник FX');
   assertString(t.fxOriginal.path,'fxOriginal.path');
  }
 }
 if(data.settings && (typeof data.settings!=='object'||Array.isArray(data.settings)))
  throw Error('Неверные настройки проекта');
 if(data.ui && (typeof data.ui!=='object'||Array.isArray(data.ui)))
  throw Error('Неверное расположение панелей');
 return data;
}
function sourcePath(projectPath,storedPath){
 const value=assertString(storedPath,'путь к медиа');
 return path.isAbsolute(value)?path.normalize(value):
   path.resolve(path.dirname(projectPath),value);
}
function storedPath(projectPath,absolutePath){
 const value=assertString(absolutePath,'путь к медиа');
 if(!path.isAbsolute(value))throw Error('Источник должен иметь абсолютный путь: '+value);
 const rel=path.relative(path.dirname(projectPath),value);
 // Different Windows volumes and UNC roots require absolute references.
 if(path.isAbsolute(rel))return value;
 return rel.split(path.sep).join('/');
}
function mapSources(body,projectPath,mapper){
 const data=structuredClone(body);
 data.media.path=mapper(projectPath,data.media.path);
 for(const clip of data.tracks){
  clip.path=mapper(projectPath,clip.path);
  if(clip.fxOriginal)clip.fxOriginal.path=mapper(projectPath,clip.fxOriginal.path);
 }
 return data;
}
async function writeProject(filePath,document){
 const absolute=path.resolve(filePath);
 if(path.extname(absolute).toLowerCase()!==EXT)throw Error('Ожидается файл .aclproj');
 const data=validate(document);
 const portable=mapSources(data,absolute,storedPath);
 const json=JSON.stringify(portable,null,2)+'\n';
 if(Buffer.byteLength(json,'utf8')>MAX_SIZE)throw Error('Проект слишком большой');
 const tempfile=path.join(path.dirname(absolute),
   '.'+path.basename(absolute)+'.'+randomUUID()+'.tmp');
 try{
  await fs.writeFile(tempfile,json,{encoding:'utf8',flag:'wx'});
  // Replace within the same directory; on Windows destination may exist.
  try{await fs.rename(tempfile,absolute)}
  catch(error){
   if(!['EEXIST','EPERM','EACCES'].includes(error.code))throw error;
   // Preserve existing file until replacement content is ready.
   const old=absolute+'.'+randomUUID()+'.old';
   let moved=false;
   try{
    try{await fs.rename(absolute,old);moved=true}catch(e){
     if(e.code!=='ENOENT')throw e;
    }
    await fs.rename(tempfile,absolute);
    if(moved)await fs.unlink(old).catch(()=>{});
   }catch(err){
    if(moved)await fs.rename(old,absolute).catch(()=>{});
    throw err;
   }
  }
 }finally{await fs.unlink(tempfile).catch(()=>{})}
 return absolute;
}
async function readProject(filePath){
 const absolute=path.resolve(filePath);
 const stat=await fs.stat(absolute);
 if(stat.size>MAX_SIZE)throw Error('Файл проекта превышает 8 МБ');
 const body=validate(JSON.parse(await fs.readFile(absolute,'utf8')));
 const data=mapSources(body,absolute,sourcePath);
 const sources=new Set([data.media.path]);
 for(const clip of data.tracks){
  sources.add(clip.path);
  if(clip.fxOriginal)sources.add(clip.fxOriginal.path);
 }
 const missing=[];
 for(const source of sources){
  try{
   const stat=await fs.stat(source);
   if(!stat.isFile())missing.push(source);
  }catch{missing.push(source)}
 }
 return {path:absolute,document:data,missing};
}
function replaceMissingPaths(document,mapping){
 const replacement=value=>mapping.get(value)||value;
 const next=structuredClone(document);
 next.media.path=replacement(next.media.path);
 next.tracks=next.tracks.map(t=>({...t,path:replacement(t.path),
   ...(t.fxOriginal?{fxOriginal:{...t.fxOriginal,path:replacement(t.fxOriginal.path)}}:{})}));
 return next;
}
module.exports={KIND,VERSION,EXT,validate,sourcePath,storedPath,mapSources,readProject,writeProject,replaceMissingPaths};
