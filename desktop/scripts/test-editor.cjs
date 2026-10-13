/* No extra runner required: transpile the pure TypeScript model with the
 * TypeScript already installed by npm and assert its edit invariants. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');

const file=path.join(__dirname,'../src/editorOperations.ts');
const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const mod={exports:{}};
new Function('module','exports','require',compiled)(mod,mod.exports,require);
const {groupLanes,splitClipAt,reorderLane,sampleFade,fadeCurvePath}=mod.exports;

const original={id:'original',laneId:'original',kind:'original',name:'Original',
  path:'original.mkv',durationMs:4000,sourceStartMs:0,offsetMs:0,peaks:[],
  gain:1,clipGain:1,muted:false,solo:false,pan:0};
const clean={...original,id:'clean',laneId:'clean',kind:'clean',name:'Clean',
  path:'voice.wav',durationMs:2000,offsetMs:1000,fadeInMs:100,
  fadeOutMs:400,peaks:Array.from({length:100},()=>[.25,.25])};
const imported={...original,id:'import',laneId:'import',kind:'import',name:'Additional'};
let clips=[original,clean,imported];
const originalParts=splitClipAt(clips,'original',1700,'original-right');
assert.equal(originalParts.length,4,'Original must now support cutting');
assert.equal(originalParts[1].sourceStartMs,1700);
assert.equal(splitClipAt(clips,'clean',1050,'invalid'),clips,'Do not split tiny clips');
clips=splitClipAt(clips,'clean',1700,'right');
assert.equal(clips.length,4);
assert.equal(groupLanes(clips).length,3,'Split stays in its original lane');
assert.equal(clips[1].durationMs,700);
assert.equal(clips[2].sourceStartMs,700);
assert.equal(clips[2].durationMs,1300);
assert.equal(clips[2].offsetMs,1700);
assert.equal(clips[1].fadeInMs,100);
assert.equal(clips[1].fadeOutMs,0);
assert.equal(clips[2].fadeInMs,0);
assert.equal(clips[2].fadeOutMs,400);
assert.equal(clips[1].peaks.length,35);
assert.equal(clips[2].peaks.length,65);
assert.deepEqual(groupLanes(reorderLane(clips,'original','clean')).map(l=>l.id),
  ['clean','original','import'],'Original can now be reordered');
const ordered=reorderLane(clips,'import','clean');
assert.deepEqual(groupLanes(ordered).map(l=>l.id),['original','import','clean']);
assert.equal(sampleFade(clean,999),0);
assert.equal(sampleFade(clean,1000),0);
assert.ok(sampleFade(clean,1050)>0&&sampleFade(clean,1050)<1);
assert.ok(sampleFade(clean,1800)>.99);
assert.ok(sampleFade(clean,2900)>0&&sampleFade(clean,2900)<1);
assert.equal(sampleFade(clean,3000),0);
assert.match(fadeCurvePath('in',100,40),/^M0.00 40.00/);
console.log('PASS: clip split, editable Original, grouped lanes, reorder, fades');
