// Keep the editor's bundled UI artwork in sync with the original Icons folder.
// Vite's publicDir is desktop/public so packaged apps do not depend on E: paths.
const fs=require('node:fs');
const path=require('node:path');

const source=path.resolve(__dirname,'../../Icons');
const destination=path.resolve(__dirname,'../public');
if(!fs.existsSync(source)){
  throw new Error('Не найдена папка исходных SVG: '+source);
}
fs.mkdirSync(destination,{recursive:true});

let count=0;
for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.svg'))continue;
  const input=path.join(source,entry.name);
  const output=path.join(destination,entry.name);
  let svg=fs.readFileSync(input,'utf8');
  if(/^cursor(?:_|\.svg)/i.test(entry.name)){
    // Artwork uses a 64×64 viewBox. Display it at the conventional
    // 32px pointer size without touching the original SVG in Icons.
    svg=svg.replace(/<svg width="64" height="64"/,
      '<svg width="32" height="32"');
  }
  if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==svg)
    fs.writeFileSync(output,svg,'utf8');
  count++;
}
// Include the original context-menu SVGs without renaming or modifying them.
const menuSource=path.join(source,'menu');
const menuDestination=path.join(destination,'menu');
if(fs.existsSync(menuSource)){
 fs.mkdirSync(menuDestination,{recursive:true});
 for(const entry of fs.readdirSync(menuSource,{withFileTypes:true})){
  if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.svg'))continue;
  const input=path.join(menuSource,entry.name),output=path.join(menuDestination,entry.name);
  const data=fs.readFileSync(input,'utf8');
  if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==data)
   fs.writeFileSync(output,data,'utf8');
  count++;
 }
}
console.log('ACL UI icons synchronized:',count);
