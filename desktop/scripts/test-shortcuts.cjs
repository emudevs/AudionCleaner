const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../src/shortcutKeys.ts'),'utf8');
const js=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const mod={exports:{}};
new Function('exports','module',js)(mod.exports,mod);
const k=mod.exports.shortcutKey;
for(const [code,key,result] of [
 ['KeyS','ы','s'],['KeyO','щ','o'],['KeyZ','я','z'],['KeyY','н','y'],
 ['KeyC','с','c'],['KeyX','ч','x'],['KeyV','м','v'],
 ['KeyD','в','d'],['KeyB','и','b'],['KeyG','п','g'],
 ['KeyM','ь','m'],['KeyN','т','n'],['KeyJ','о','j'],
 ['KeyK','л','k'],['KeyL','д','l'],['KeyA','ф','a'],
 ['Space',' ',' '],['Equal','=','+'],['NumpadAdd','+','+'],
 ['Minus','-','-'],['NumpadSubtract','-','-'],
 ['Digit0','0','0'],['ArrowLeft','ArrowLeft','arrowleft'],
 ['Escape','Escape','escape'],['Unidentified','ж','ж']
]){
 assert.equal(k({code,key}),result,code+' / '+key);
}
console.log('PASS: physical RU/EN shortcuts, zoom and non-letter keys');
