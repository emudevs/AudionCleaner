const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
function load(relative){
  const source=fs.readFileSync(path.join(__dirname,'../src',relative),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022
  }}).outputText;
  const mod={exports:{}};
  new Function('module','exports','require',js)(mod,mod.exports,require);
  return mod.exports;
}
const {emptyTrackHistory,trackHistoryReducer}=load('useTrackHistory.ts');
const {splitClipAt}=load('editorOperations.ts');
const original={id:'original',laneId:'original',kind:'original',
  name:'Original',offsetMs:0,durationMs:5000,sourceStartMs:0,
  peaks:Array.from({length:250},()=>[.3,.3]),
  path:'media.mp4',url:'file:media',gain:1,clipGain:1,muted:false,solo:false,pan:0};
let state=trackHistoryReducer(emptyTrackHistory,{type:'reset',tracks:[original]});
state=trackHistoryReducer(state,{type:'edit',record:true,
  update:t=>splitClipAt(t,'original',2300,'right')});
assert.equal(state.present.length,2,'Original should be editable');
assert.equal(state.past.length,1);
state=trackHistoryReducer(state,{type:'undo'});
assert.equal(state.present.length,1);
state=trackHistoryReducer(state,{type:'redo'});
assert.equal(state.present.length,2);
state=trackHistoryReducer(state,{type:'begin'});
for(let i=0;i<20;i++){
  state=trackHistoryReducer(state,{type:'edit',record:true,
    update:t=>t.map(c=>c.id==='right'?{...c,offsetMs:2300+i*10}:c)});
}
state=trackHistoryReducer(state,{type:'end'});
assert.equal(state.past.length,2,'One drag should be one undo');
const before=state.present.find(t=>t.id==='right').offsetMs;
state=trackHistoryReducer(state,{type:'undo'});
assert.notEqual(state.present.find(t=>t.id==='right').offsetMs,before);
state=trackHistoryReducer(state,{type:'redo'});
assert.equal(state.present.find(t=>t.id==='right').offsetMs,before);
state=trackHistoryReducer(state,{type:'edit',record:false,
  update:t=>t.map(c=>({...c,pending:false}))});
assert.equal(state.past.length,2,'Waveform metadata must not fill Undo');
console.log('PASS: Original cuts, Undo/Redo, drag transaction, unrecorded wave updates');
