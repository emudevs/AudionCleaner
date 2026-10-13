'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const setup=require('../electron/setup.cjs');
const pkg=require('../package.json');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'acl-portable-test-'));
try{
 assert.equal(setup.ready(temp),false,'empty user profile must enter first-run setup');
 const data=setup.paths(temp);
 for(const k of ['python','venv']){
  fs.mkdirSync(path.dirname(data[k]),{recursive:true});
  fs.writeFileSync(data[k],'python');
 }
 fs.writeFileSync(data.marker,JSON.stringify({schema:1,app_version:'1.0.0',audio_separator:'0.47.0'}));
 assert.equal(setup.ready(temp),false,'models not downloaded yet');
 fs.writeFileSync(data.ready,JSON.stringify({schema:1,app_version:'1.0.0',models:'instrumental_full'}));
 assert.equal(setup.ready(temp),true,'fully provisioned user profile must skip setup');
 fs.writeFileSync(data.ready,JSON.stringify({schema:1,app_version:'1.0.0',models:'bad'}));
 assert.equal(setup.ready(temp),false,'incomplete model cache cannot be treated as ready');
 assert.ok(pkg.build.extraResources.some(p=>p.to==='bootstrap.py'));
 assert.ok(pkg.build.extraResources.some(p=>p.to==='tools/ffmpeg/bin/ffmpeg.exe'));
 assert.ok(pkg.build.extraResources.some(p=>p.to==='tools/ffmpeg/bin/ffprobe.exe'));
 const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
 assert.ok(main.includes("app.isPackaged?process.resourcesPath"));
 assert.ok(main.includes("ACL_DATA_DIR:dataDir()"));
 assert.ok(main.includes('void startStandaloneSetup()'));
 console.log('PASS: one-click Windows setup readiness, model cache, resources and startup paths');
}finally{fs.rmSync(temp,{recursive:true,force:true})}
