import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { RoomError } from './src/rooms.js';
import { PersistentRooms } from './src/persistent-rooms.js';
import { openRoomStorage } from './src/room-storage.js';
import { AdminAuth } from './src/admin-auth.js';

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT ?? process.env.DENDARV_PORT ?? 4173);
const host = process.env.DENDARV_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const storage = await openRoomStorage();
const rooms = new PersistentRooms(storage);
const admin = new AdminAuth(process.env.DENDARV_ADMIN_PASSWORD);
const publicFiles = new Set(['index.html','Dendarv_Play.html','src/styles.css',
  ...['constants','rng','notation','model','rules','engine','projection','persistence','format','online','presentation','tabletop','ui'].map(n=>`src/${n}.js`)]);
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8' };
const bearer = request => (request.headers.authorization ?? '').startsWith('Bearer ') ? request.headers.authorization.slice(7) : null;
const security = { 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer' };
function json(response,status,body,headers={}) { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...security,...headers}); response.end(JSON.stringify(body)); if (['COMPLETE','ABANDONED'].includes((body?.view ?? body)?.room?.status)) wakeArchives(); }
async function readJson(request) {
  const chunks=[]; let size=0;
  for await (const chunk of request) {
    size += chunk.length; if (size > 65536) throw new RoomError('REQUEST_TOO_LARGE','Request body is too large',413);
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
  catch { throw new RoomError('INVALID_JSON','Request body must be valid JSON'); }
}
const recoverAttempts = new Map();
function limitRecovery(request) {
  const key=request.socket.remoteAddress, now=Date.now();
  const times=(recoverAttempts.get(key)??[]).filter(t=>now-t<60000);
  if(times.length>=10) throw new RoomError('RATE_LIMIT','Wait before another recovery attempt',429);
  times.push(now);recoverAttempts.set(key,times);
  for(const [ip, values] of recoverAttempts) if(now-values.at(-1)>60000) recoverAttempts.delete(ip);
}
async function handleApi(request,response,url) {
  const segments=url.pathname.split('/').filter(Boolean), token=bearer(request);
  if(request.method==='GET' && url.pathname==='/api/health') return json(response,200,{ok:true,service:'brezelpesk',saving_paused:rooms.paused});
  if(request.method==='POST' && url.pathname==='/api/admin/login') {
    const session=admin.login((await readJson(request)).password,request.socket.remoteAddress);
    return json(response,200,{csrf:session.csrf},{'Set-Cookie':`dendarv_admin=${session.token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=3600${process.env.NODE_ENV==='production'||process.env.RENDER?'; Secure':''}`});
  }
  if(segments[1]==='admin') {
    admin.check(request);
    if(request.method==='GET' && segments.length===2) return json(response,200,{rooms:await storage.inventory(),limits:storage.limits});
    if(segments[2]==='rooms' && segments[3]) {
      const action=request.method==='GET'?'inspect':segments[4];
      const result = await rooms.admin(segments[3],action,request.method==='GET'?{}:await readJson(request));
      if(action==='abandon')wakeArchives();
      return json(response,200,result);
    }
  }
  if(request.method==='POST' && url.pathname==='/api/rooms') return json(response,201,await rooms.mutate('create',null,null,await readJson(request),request.headers['idempotency-key']));
  if(segments[1]==='rooms' && segments[2]) {
    const code=segments[2], action=segments[3];
    if(request.method==='GET' && !action) {
      const view=await rooms.view(code,token,request.headers['x-dendarv-spectator']);
      const etag='"'+createHash('sha256').update(JSON.stringify(view)).digest('hex')+'"';
      if(request.headers['if-none-match']===etag) { response.writeHead(304,{...security,ETag:etag});return response.end(); }
      return json(response,200,view,{ETag:etag});
    }
    if(request.method==='GET' && action==='export') return json(response,200,await rooms.export(code,token));
    if(request.method==='GET' && action==='summary') return json(response,200,await rooms.summary(code,token));
    if(request.method==='POST' && ['join','start','command','undo','pass','recover','abandon','rename'].includes(action)) {
      if(action==='recover') limitRecovery(request);
      return json(response,200,await rooms.mutate(action,code,token,await readJson(request),request.headers['idempotency-key']));
    }
  }
  throw new RoomError('NOT_FOUND','API route not found',404);
}
const server=createServer(async(request,response)=>{
  try {
    const url=new URL(request.url,'http://localhost');
    if(request.method==='POST' && request.headers.origin && new URL(request.headers.origin).host!==request.headers.host) throw new RoomError('ORIGIN_DENIED','Cross-origin writes are not accepted',403);
    if(url.pathname.startsWith('/api/')) return await handleApi(request,response,url);
    if(!['GET','HEAD'].includes(request.method)) throw new RoomError('METHOD_NOT_ALLOWED','Method not allowed',405);
    let path;try {path=decodeURIComponent(url.pathname);} catch {throw new RoomError('INVALID_PATH','Invalid path');}
    const relative=path==='/'?'index.html':path.slice(1);
    if(!publicFiles.has(relative)) throw new RoomError('NOT_FOUND','Not found',404);
    const file=resolve(root,relative);
    if(await realpath(file)!==file || !(await stat(file)).isFile()) throw new RoomError('NOT_FOUND','Not found',404);
    response.writeHead(200,{...security,'Content-Type':types[extname(file)]??'application/octet-stream'});
    if(request.method==='HEAD')return response.end();
    createReadStream(file).on('error',()=>response.destroy()).pipe(response);
  }catch(error){
    const status=error instanceof RoomError?error.status:503;
    json(response,status,{error:{code:error instanceof RoomError?error.code:'SERVICE_UNAVAILABLE',message:error instanceof RoomError?error.message:'The service is temporarily unavailable'}});
  }
});
let archiving=false, archiveTimer=null, archiveWakeRequested=false;
async function archives(){
  if(archiving){archiveWakeRequested=true;return;}
  archiveWakeRequested=false;
  archiving=true;let pending=false;
  try{pending=await rooms.processArchives();}catch{pending=true;}
  finally{archiving=false;}
  if(pending || archiveWakeRequested){archiveTimer=setTimeout(archives,archiveWakeRequested?0:60000);archiveTimer.unref();}
}
function wakeArchives(){
  if(archiving){archiveWakeRequested=true;return;}
  clearTimeout(archiveTimer);archiveTimer=setTimeout(archives,0);archiveTimer.unref();
}
// Scan at startup, then only while work remains or a new terminal record arrives.
await archives();
server.listen(port,host,()=>process.stdout.write(`BrezelPesk is running at http://${host}:${server.address().port}\n`));
let closing=false;
process.on('SIGTERM',()=>{if(closing)return;closing=true;clearTimeout(archiveTimer);server.close(async()=>{await storage.close();});});
