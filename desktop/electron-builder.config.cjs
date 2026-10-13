'use strict';
// Electron Builder config for native GitHub Actions runners.
// On Windows the setup script downloads the matching FFmpeg binaries.
// macOS/Linux remain experimental packages until runtime installers exist.
const path=require('node:path');
const fs=require('node:fs');
const pkg=require('./package.json');
const windows=process.platform==='win32';
const resources=pkg.build.extraResources.filter(item=>{
  const to=item.to||'';
  const windowsTool=to.startsWith('tools/ffmpeg/');
  if(windowsTool&&!windows)return false;
  // FFmpeg may ship with binaries but no standalone root LICENSE file.
  if(to.startsWith('licenses/')&&!fs.existsSync(path.resolve(__dirname,item.from)))return false;
  return true;
});
module.exports={
  ...pkg.build,
  extraResources:resources,
  // Never attempt to sign ephemeral CI binaries without signing identities.
  ...(process.platform==='darwin'?{
    mac:{...pkg.build.mac,identity:null},
  }:{}),
};
