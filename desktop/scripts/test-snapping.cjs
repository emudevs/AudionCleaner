const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const file=path.join(__dirname,'../src/timelineSnapping.ts');
const compiled=ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const mod={exports:{}};
new Function('module','exports','require',compiled)(mod,mod.exports,require);
const {snapToleranceMs,timelineSnapAnchors,snapPosition,trimEdgeBounds}=mod.exports;
const clip=(id,offset,duration,extra={})=>({
  id,laneId:id,name:id,kind:'clean',path:id+'.wav',url:'',
  offsetMs:offset,durationMs:duration,sourceStartMs:0,
  peaks:[],pending:false,muted:false,solo:false,gain:1,pan:0,...extra,
});
const clips=[clip('moving',1000,2000),clip('other',4500,1000),clip('negative',-500,400)];
const anchors=timelineSnapAnchors(clips,'moving',10000,3000,{startMs:7000,endMs:8000});
assert.deepEqual(anchors,[0,10000,3000,7000,8000,4500,5500,-500,-100]);
assert.ok(!anchors.includes(1000),'moving clip start must be excluded');
assert.ok(anchors.includes(3000),'playhead remains a snap point');
const bounds={min:-2000,max:10000};
assert.deepEqual(snapPosition(4496,anchors,[0,2000],10,bounds),{value:4500,guideMs:4500},
  'left edge aligns with another clip start');
assert.deepEqual(snapPosition(2496,anchors,[0,2000],10,bounds),{value:2500,guideMs:4500},
  'right edge aligns with another clip start');
assert.deepEqual(snapPosition(2470,anchors,[0,2000],10,bounds),{value:2470,guideMs:null},
  'no jump when outside the threshold');
assert.deepEqual(snapPosition(9900,[10000],[0,2000],150,{min:0,max:8000}),
  {value:8000,guideMs:10000},'snap to project end via right edge');
assert.deepEqual(snapPosition(100,[0],[0],200,{min:200,max:900}),
  {value:200,guideMs:null},'never guide to an unreachable boundary');
assert.equal(snapToleranceMs(4),2);
assert.equal(snapToleranceMs(.001),500,'time tolerance must be capped at wide zoom');
assert.equal(snapToleranceMs(0),0);
const trimmed=clip('trim',500,2000,{sourceStartMs:1000,sourceDurationMs:5000});
assert.deepEqual(trimEdgeBounds(trimmed,'left'),{min:-500,max:2400});
assert.deepEqual(trimEdgeBounds(trimmed,'right'),{min:600,max:4500});
assert.deepEqual(snapPosition(4497,[4500],[0],10,trimEdgeBounds(trimmed,'right')),
  {value:4500,guideMs:4500});
assert.deepEqual(snapPosition(4510,[5500],[0],1000,trimEdgeBounds(trimmed,'right')),
  {value:4500,guideMs:null},'source bound blocks inaccessible snap');
console.log('PASS: clip-edge magnetic snapping, trim bounds, playhead and range anchors');
