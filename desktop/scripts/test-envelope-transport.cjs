const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const load=(name)=>{
  const source=fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
  const js=ts.transpileModule(source,{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText;
  const mod={exports:{}};
  const localRequire=(id)=>id==='./editorOperations'?load('editorOperations.ts'):require(id);
  new Function('module','exports','require',js)(mod,mod.exports,localRequire);
  return mod.exports;
};
const {fadeGain,sampleFade,fadeCurvePath}=load('editorOperations.ts');
const original={id:'a',laneId:'lane',name:'Clean',kind:'clean',
  path:'voice.wav',streamIndex:0,offsetMs:0,sourceStartMs:0,
  durationMs:2000,gain:1,clipGain:1,fadeInMs:0,fadeOutMs:0,
  peaks:[],muted:false,solo:false,pan:0};
const right={...original,id:'b',offsetMs:2000,sourceStartMs:2000};
const {continuousPlaybackChains,currentPlaybackSegment}=load('audioTransport.ts');
let chains=continuousPlaybackChains([right,original]);
assert.equal(chains.length,1,'Adjacent source segments must use one player');
assert.equal(chains[0].leaderId,'a');
assert.equal(currentPlaybackSegment(chains[0],1999)?.id,'a');
assert.equal(currentPlaybackSegment(chains[0],2000)?.id,'b');
assert.equal(currentPlaybackSegment(chains[0],4000),null);
chains=continuousPlaybackChains([original,{...right,offsetMs:2020}]);
assert.equal(chains.length,2,'A real 20ms gap must not be hidden');
chains=continuousPlaybackChains([original,{...right,sourceStartMs:2010}]);
assert.equal(chains.length,2,'Nonadjacent source offsets must not be joined');
chains=continuousPlaybackChains([original,{...right,path:'other.wav'}]);
assert.equal(chains.length,2,'Different files cannot share a playback transport');
assert.equal(fadeGain(0),0);
assert.equal(fadeGain(1),1);
assert.ok(fadeGain(.5,-1)>fadeGain(.5,0));
assert.ok(fadeGain(.5,1)<fadeGain(.5,0));
assert.ok(Math.abs(sampleFade({...original,fadeInMs:1000,fadeInCurve:1},500)-
  fadeGain(.5,1))<1e-6);
assert.ok(fadeCurvePath('in',100,100,2)!==fadeCurvePath('in',100,100,-2));
console.log('PASS: zero-gap playback chains, real gaps retained, source continuity, fade curves');
