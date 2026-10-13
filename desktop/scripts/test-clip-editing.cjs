const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const files={};
for(const name of ['editor','clipEditing']){
  const input=fs.readFileSync(path.join(__dirname,'../src/'+name+'.ts'),'utf8');
  const js=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  new Function('module','exports','require',js)(module,module.exports,dep=>{
    if(dep==='./editor')return files.editor;
    throw Error('Unexpected dependency '+dep);
  });
  files[name]=module.exports;
}
const {moveClipGroup,groupMoveDelta,toggleClipDisabled,duplicateSelectedClips}=files.clipEditing;
const clip=(id,offsetMs,durationMs,extra={})=>({id,offsetMs,durationMs,name:id,
  kind:'clean',path:'test.wav',url:'file:',peaks:[[0,1]],muted:false,solo:false,
  gain:1,pan:0,pending:false,...extra});
const tracks=[clip('a',1000,1000),clip('b',2500,1500),clip('c',6000,1200)];
const originals={a:1000,b:2500};
const moved=moveClipGroup(tracks,originals,1000,10000);
assert.deepEqual(moved.map(t=>t.offsetMs),[2000,3500,6000]);
assert.equal(moved[2],tracks[2],'unselected clip is unchanged');
assert.equal(groupMoveDelta(tracks,originals,-99999,10000),-11000,
  'clamp the group at the earliest allowed overhang');
assert.equal(moveClipGroup(tracks,originals,0,10000),tracks,'no-op returns original array');
const muted=toggleClipDisabled(tracks,['a','c']);
assert.equal(muted[0].clipMuted,true);
assert.equal(muted[1].clipMuted,undefined);
assert.equal(muted[2].clipMuted,true);
assert.equal(toggleClipDisabled(muted,['a','c'])[0].clipMuted,false);
assert.equal(toggleClipDisabled(muted,['a','b'])[1].clipMuted,true,
  'mixed state mutes all selected');
let id=0;
const copies=duplicateSelectedClips(tracks,['a','b'],10000,()=>String(++id),250);
assert.equal(copies.tracks.length,5);
assert.deepEqual(copies.ids,['1','2']);
assert.deepEqual(copies.tracks.slice(3).map(t=>t.offsetMs),[1250,2750]);
assert.equal(copies.tracks[3].path,'test.wav');
assert.notEqual(copies.tracks[3].peaks,tracks[0].peaks);
const original=[clip('original',0,1000,{kind:'original',laneId:'original'})];
const copied=duplicateSelectedClips(original,['original'],10000,()=> 'new');
assert.equal(copied.tracks[1].kind,'import');
assert.equal(copied.tracks[1].laneId,'new');
assert.equal(copied.tracks[1].clipMuted,true);
assert.equal(copies.tracks[3].laneId,'1');
assert.equal(copies.tracks[3].clipMuted,true);
assert.equal(copies.tracks[4].laneId,'2');
console.log('PASS: group movement, shared bounds, clip mute, duplicate and source reuse');
