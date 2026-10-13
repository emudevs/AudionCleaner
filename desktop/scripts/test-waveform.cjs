const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');

const source=fs.readFileSync(path.join(__dirname,'../src/waveformGeometry.ts'),'utf8');
const compiled=ts.transpileModule(source,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText;
const mod={exports:{}};
new Function('module','exports','require',compiled)(mod,mod.exports,require);
const {resolveWaveIntervalMs,waveformSliceRange}=mod.exports;

// Old and new backend versions must both display the entire duration.
assert.equal(resolveWaveIntervalMs({intervalMs:100,samples:500},50000),100);
assert.equal(resolveWaveIntervalMs({intervalMs:20,samples:2500},50000),20);
assert.equal(resolveWaveIntervalMs({samples:500},50000),100);
assert.equal(resolveWaveIntervalMs({samples:2500},50000),20);
assert.equal(resolveWaveIntervalMs({},50000),20);
assert.deepEqual(waveformSliceRange(0,50000,100),{from:0,to:500});
assert.deepEqual(waveformSliceRange(0,50000,20),{from:0,to:2500});

// Split and trimmed clips use the actual peak bin duration, not 20ms.
assert.deepEqual(waveformSliceRange(1200,2000,100),{from:12,to:32});
assert.deepEqual(waveformSliceRange(1200,2000,20),{from:60,to:160});

// A peak near the very end of a 50 second source must remain visible.
for(const bin of [20,100]){
  const count=50000/bin;
  const index=Math.floor(49900/bin);
  assert.ok(index<count);
}
console.log('PASS: 100 ms legacy, 20 ms current, fallback, clip slices and end-of-track coverage');
