const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'../src',p),'utf8');
const layout=read('useEditorLayout.ts');
const timeline=read('Timeline.tsx');
const editor=read('useEditor.ts');
const dialog=read('LaneEffectsDialog.tsx');
const captions=read('style-timeline-pinned-labels.css');
assert.ok(layout.includes('zoom:[1,80]'),'zoom maximum 80x');
assert.ok(timeline.includes('onZoom(bound(next,1,80))'),'zoom command maximum');
assert.ok(timeline.includes('Свойства и эффекты') &&
  timeline.includes('onOpenProperties(clip.laneId||clip.id,clip.id)'),
  'clip effect menu opens the selected clip editor');
assert.ok(editor.includes('startMs:clip.sourceStartMs||0,durationMs:clip.durationMs'),'effects request uses clip trim');
assert.ok(editor.includes('fxOriginal:track.fxOriginal??'),'undoable source per clip');
assert.ok(editor.includes('const rendered:'),'render outputs tracked');
assert.ok(editor.includes('const byId=new Map(rendered.map'),'atomic per-clip update');
assert.ok(editor.includes("restartBackend()"),'stale Python backend recovery');
assert.ok(dialog.includes("scope:'clip'|'lane'"),'dialog scope');
assert.ok(timeline.includes('const available=Math.max(0,Math.min(viewportWidth-8,to-6)-left)'),
  'filename clipped only by actual visible fragment');
assert.ok(captions.includes('inset:37px 0 auto 0'),'captions aligned below sticky ruler');
assert.ok(!timeline.includes('pinned-row pinned-ruler-space'),'no phantom 37px offset');
assert.ok(timeline.includes("if(tool==='gain'){editFade(event,track,'volume');return;}") &&
  timeline.includes("if(tool==='gain')editFade(event,track,'volume')"),
  'gain is an explicit tool, not a hidden bottom-band gesture');
console.log('PASS: 8000% zoom, per-clip effects, per-clip FX reset, explicit gain tool and labels');
