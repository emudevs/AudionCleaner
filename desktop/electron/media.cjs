const {protocol} = require('electron');
const {randomUUID} = require('node:crypto');
const {createReadStream, statSync} = require('node:fs');
const {Readable} = require('node:stream');
const path = require('node:path');

const sources = new Map();
const mime = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
};

function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'acl-media',
    privileges: {standard: true, secure: true, stream: true, supportFetchAPI: true},
  }]);
}

function registerPath(filePath) {
  const id = randomUUID();
  sources.set(id, filePath);
  return 'acl-media://' + id + '/media';
}

function releasePath(url) {
  try{
    const uri=new URL(url);
    if(uri.protocol!=='acl-media:')return false;
    return sources.delete(uri.hostname);
  }catch{return false}
}
function releaseAll(){sources.clear()}

function activateScheme() {
  protocol.handle('acl-media', async request => {
    try {
      const url = new URL(request.url);
      const name = sources.get(url.hostname);
      if (!name) return new Response('Unknown media', {status: 404});
      const size = statSync(name).size;
      let start = 0, end = Math.max(0, size - 1);
      let status = 200;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) return new Response('', {status: 416});
        if (match[1]) start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
        if (!match[1] && match[2]) start = Math.max(0, size - Number(match[2]));
        if (start > end || start >= size) {
          return new Response('', {status: 416, headers: {'Content-Range': 'bytes */' + size}});
        }
        status = 206;
      }
      const headers = {
        'Content-Type': mime[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, max-age=60',
      };
      if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
      if (size === 0) return new Response(null, {status: 204});
      const body = Readable.toWeb(createReadStream(name, {start, end}));
      return new Response(body, {status, headers});
    } catch (error) {
      return new Response(String(error), {status: 500});
    }
  });
}

module.exports = {registerScheme, registerPath, releasePath, releaseAll, activeGrants:()=>sources.size, activateScheme};
