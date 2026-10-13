const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const ts=require('typescript');
const {
 KIND,VERSION,writeProject,readProject,storedPath,sourcePath,
 replaceMissingPaths,
}=require('../electron/project-files.cjs');

function typescriptModule(name){
 const source=require('node:fs').readFileSync(path.resolve(__dirname,'../src',name),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
 }}).outputText;
 const mod={exports:{}};
 new Function('module','exports','require',js)(mod,mod.exports,require);
 return mod.exports;
}
async function run(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'acl-project-test-'));
 try{
  const folder=path.join(root,'session');
  const assets=path.join(folder,'assets');
  await fs.mkdir(assets,{recursive:true});
  const movie=path.join(assets,'anime.mp4');
  const clean=path.join(assets,'clean.wav');
  await fs.writeFile(movie,'video');
  await fs.writeFile(clean,'audio');
  const {makeProjectDocument,projectEditSignature}=typescriptModule('projectFormat.ts');
  const layout={sidebar:44,timeline:75,labels:208,zoom:35,trackHeight:125};
  const panels={settingsOpen:false,mixerOpen:true,previewOpen:false};
  const track={
   id:'clean1',laneId:'clean',name:'Clean',kind:'clean',
   path:clean,url:'acl-media://ephemeral/media',
   sourceStartMs:1200,sourceDurationMs:4000,durationMs:900,
   offsetMs:3100,streamIndex:0,peaks:[[.8,.5],[.1,.2]],pending:false,
   muted:false,solo:false,gain:.7,pan:.2,clipGain:1.2,
   fadeInMs:100,fadeOutMs:200,fadeInCurve:1.25,fadeOutCurve:-.5,
   waveIntervalMs:20,fx:true,fxSettings:{highpass_enabled:true},
   fxOriginal:{path:movie,url:'acl-media://old-source/media',streamIndex:2,
    sourceStartMs:800,sourceDurationMs:8000,peaks:[[.4,.4]],waveIntervalMs:100},
  };
  const doc=makeProjectDocument(movie,2,[track],{precision:'fp32'},3200,
    {startMs:2400,endMs:3400},layout,panels);
  assert.equal(doc.format,KIND);
  assert.equal(doc.version,VERSION);
  assert.ok(!('peaks' in doc.tracks[0]));
  assert.ok(!('waveIntervalMs' in doc.tracks[0]));
  assert.ok(!('waveIntervalMs' in doc.tracks[0].fxOriginal));
  assert.ok(!('url' in doc.tracks[0]));
  assert.ok(!('url' in doc.tracks[0].fxOriginal));
  assert.ok(!('peaks' in doc.tracks[0].fxOriginal));
  const signature=projectEditSignature(doc);
  assert.equal(signature,projectEditSignature({...doc,positionMs:8000}),
    'playhead movement must not dirty saved project');
  const file=path.join(folder,'cut.aclproj');
  await writeProject(file,doc);
  let raw=await fs.readFile(file,'utf8');
  assert.ok(raw.includes('assets/anime.mp4'));
  assert.ok(raw.includes('assets/clean.wav'));
  assert.ok(!raw.includes('acl-media://'));
  assert.ok(!raw.includes('"peaks"'));
  let restored=await readProject(file);
  assert.deepEqual(restored.missing,[]);
  assert.equal(restored.document.media.path,movie);
  assert.equal(restored.document.tracks[0].path,clean);
  assert.equal(restored.document.tracks[0].fxOriginal.path,movie);
  assert.equal(restored.document.tracks[0].fadeInCurve,1.25);
  assert.equal(restored.document.ui.layout.zoom,35);
  assert.equal(restored.document.tracks[0].sourceStartMs,1200);
  assert.equal(restored.document.positionMs,3200);
  // Save existing project again without leaving a truncated file.
  const updated={...doc,positionMs:4000};
  await writeProject(file,updated);
  restored=await readProject(file);
  assert.equal(restored.document.positionMs,4000);
  const before=await fs.readFile(file,'utf8');
  await assert.rejects(writeProject(file,{...doc,version:999}),/Неподдерживаемый/);
  assert.equal(await fs.readFile(file,'utf8'),before,'failed write must preserve old file');
  const moved=path.join(root,'relocated');
  await fs.rename(folder,moved);
  restored=await readProject(path.join(moved,'cut.aclproj'));
  assert.deepEqual(restored.missing,[],'relative paths survive moving project with its assets');
  const movedClip=path.join(moved,'assets','clean.wav');
  await fs.rename(movedClip,movedClip+'.back');
  restored=await readProject(path.join(moved,'cut.aclproj'));
  assert.deepEqual(restored.missing,[movedClip]);
  const relinked=replaceMissingPaths(restored.document,new Map([[movedClip,movedClip+'.back']]));
  assert.equal(relinked.tracks[0].path,movedClip+'.back');
  assert.equal(relinked.tracks[0].fxOriginal.path,path.join(moved,'assets','anime.mp4'));
  const target=path.join(moved,'cut.aclproj');
  assert.equal(sourcePath(target,storedPath(target,movedClip+'.back')),movedClip+'.back');
  console.log('PASS: project save/load, fx origins, relative paths, relink, overwrite protection and no waveform bloat');
 }finally{
  await fs.rm(root,{recursive:true,force:true});
 }
}
run().catch(error=>{console.error(error);process.exitCode=1});
