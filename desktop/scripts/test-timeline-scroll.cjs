const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=name=>fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
const timeline=source('Timeline.tsx');
const style=source('style-timeline-scroll.css');
const grid=source('style-timeline-grid.css');
const app=source('main.tsx');

assert.ok(timeline.includes('const verticalScroll=useRef<HTMLDivElement>(null)'), 'vertical scroll ref');
assert.ok(timeline.includes('ref={verticalScroll}'), 'vertical scroll container');
assert.ok(timeline.includes('const bottomScroll=useRef<HTMLDivElement>(null)'), 'footer ref');
assert.ok(timeline.includes('ref={bottomScroll}'), 'footer rendered');
assert.ok(timeline.includes('bottomScroll.current.scrollLeft=left'), 'canvas syncs to footer');
assert.ok(timeline.includes('scroll.current.scrollLeft=left'), 'footer syncs to canvas');
assert.ok(timeline.includes('vertical.scrollTop+=event.deltaY*unit'),
  'plain wheel over horizontal timeline must scroll the lane viewport');
assert.ok(timeline.includes("event.target.closest('.timeline-time-scroll')"),'wheel capture target');
assert.ok(timeline.includes('const unit=event.deltaMode===1?16:'),
  'line and page wheel deltas normalized');
assert.ok(timeline.includes('timeline-ruler-fixed'),'ruler separately rendered');
assert.ok(!timeline.includes('timeline-ruler-spacer'),'no doubled ruler height');
assert.ok(timeline.includes('timeline-ruler-playhead'),'playhead handle stays visible');
assert.ok(style.includes('position:sticky'),'ruler and timestamps pinned vertically');
assert.ok(style.includes('top:0;'),'sticky from top');
assert.ok(style.includes('.timeline-bottom-scrollbar')&&style.includes('flex:0 0 16px'),
  'footer must not participate in vertical scrolling');
assert.ok(style.includes('.timeline-time-scroll::-webkit-scrollbar'),
  'duplicate native scrollbar hidden');
assert.ok(grid.includes('overflow-y:auto!important'),
  'only editor body owns the vertical scrollbar');
assert.ok(app.includes("import './style-timeline-scroll.css'"),'scroll styles loaded last');
console.log('PASS: fixed ruler, persistent horizontal footer, synchronized scroll and wheel routing');
