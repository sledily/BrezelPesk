import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { RoomError } from './src/rooms.js';
import { PersistentRooms } from './src/persistent-rooms.js';
import { openRoomStorage } from './src/room-storage.js';
import {pushConfiguration} from './src/web-push.js';
import {NotificationDelivery} from './src/notifications.js';
import { AdminAuth } from './src/admin-auth.js';
import { archiveZip } from './src/archive-zip.js';

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT ?? process.env.DENDARV_PORT ?? 4173);
const host = process.env.DENDARV_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const storage = await openRoomStorage();
const push=pushConfiguration();
const rooms = new PersistentRooms(storage,{notificationsEnabled:push.enabled});
const delivery=new NotificationDelivery(storage,{send:push.send,publicOrigin:push.publicOrigin,isPresent:(...args)=>rooms.notificationPresent(...args)});
const maintenanceSecret=process.env.DENDARV_MAINTENANCE_TOKEN;
let lastMaintenance=0;
function maintenanceAuthorized(token) {
  if(!maintenanceSecret || maintenanceSecret.length<32 || typeof token!=='string') return false;
  const a=Buffer.from(token),b=Buffer.from(maintenanceSecret);return a.length===b.length && timingSafeEqual(a,b);
}
const admin = new AdminAuth(process.env.DENDARV_ADMIN_PASSWORD);
const publicFiles = new Set(['index.html','Dendarv_Play.html','notification-worker.js','src/styles.css','admin.html','src/admin.js','src/admin.css',
  ...['constants','rng','notation','model','rules','engine','projection','persistence','format','online','presentation','tabletop','event-presentation','browser-notifications','ui'].map(n=>`src/${n}.js`)]);
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8' };
const bearer = request => (request.headers.authorization ?? '').startsWith('Bearer ') ? request.headers.authorization.slice(7) : null;
const security = { 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY' };
function json(response,status,body,headers={}) { response.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...security,...headers}); response.end(JSON.stringify(body)); if ((body?.view ?? body)?.room?.code) wakeArchives(); }
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
  if(request.method==='GET' && url.pathname==='/api/notifications/config') return json(response,200,{enabled:push.enabled,publicKey:push.publicKey??null,origin:push.publicOrigin??null});
  if(request.method==='POST' && url.pathname==='/api/maintenance') {
    if(!maintenanceAuthorized(token)) throw new RoomError('FORBIDDEN','Maintenance authentication required',403);
    if(Date.now()-lastMaintenance<10000) return json(response,202,{accepted:true});
    lastMaintenance=Date.now();await archives();return json(response,200,{accepted:true});
  }
  if(request.method==='POST' && url.pathname==='/api/admin/login') {
    const session=admin.login((await readJson(request)).password,request.socket.remoteAddress);
    return json(response,200,{csrf:session.csrf,expires:admin.sessions.get(session.token).expires},{'Set-Cookie':`dendarv_admin=${session.token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=3600${process.env.NODE_ENV==='production'||process.env.RENDER?'; Secure':''}`});
  }
  if(segments[1]==='admin') {
    const session=admin.check(request);
    if(request.method==='GET' && url.pathname==='/api/admin/session') return json(response,200,{csrf:session.csrf,expires:session.expires});
    if(request.method==='POST' && url.pathname==='/api/admin/logout') {
      admin.logout(request);
      return json(response,200,{ok:true},{'Set-Cookie':`dendarv_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${process.env.NODE_ENV==='production'||process.env.RENDER?'; Secure':''}`});
    }
    if(request.method==='GET' && url.pathname==='/api/admin/archives.zip') {
      const zip=archiveZip(await rooms.archiveFiles());
      response.writeHead(200,{...security,'Content-Type':'application/zip',
        'Content-Disposition':'attachment; filename="BrezelPesk-archives.zip"','Content-Length':zip.length});
      return response.end(zip);
    }
    if(request.method==='GET' && segments.length===2) return json(response,200,await rooms.adminInventory());
    if(segments[2]==='rooms' && segments[3] &&
      ((request.method==='GET' && segments.length===4) ||
       (request.method==='POST' && segments.length===5 && ['recover','abandon','retry-archive','delete-archive'].includes(segments[4])))) {
      const action=request.method==='GET'?'inspect':segments[4];
      const result = await rooms.admin(segments[3],action,request.method==='GET'?{}:await readJson(request));
      if(['abandon','retry-archive'].includes(action))wakeArchives();
      return json(response,200,result);
    }
    throw new RoomError('NOT_FOUND','Administrator route not found',404);
  }
  if(request.method==='POST' && url.pathname==='/api/rooms') return json(response,201,await rooms.mutate('create',null,null,await readJson(request),request.headers['idempotency-key']));
  if(segments[1]==='rooms' && segments[2]) {
    const code=segments[2], action=segments[3];
    if(request.method==='GET' && !action) {
      const view=await rooms.view(code,token,request.headers['x-dendarv-spectator'],request.headers['x-dendarv-visible']==='1');
      const etag='"'+createHash('sha256').update(JSON.stringify(view)).digest('hex')+'"';
      if(request.headers['if-none-match']===etag) { response.writeHead(304,{...security,ETag:etag});return response.end(); }
      return json(response,200,view,{ETag:etag});
    }
    if(request.method==='GET' && action==='export') return json(response,200,await rooms.export(code,token));
    if(request.method==='GET' && action==='summary') return json(response,200,await rooms.summary(code,token));
    if(request.method==='POST' && ['join','start','command','undo','pass','recover','abandon','rename','assign','remove','leave','cancel','resign','vote','notifications'].includes(action)) {
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
    const relative=path==='/'?'index.html':['/admin','/admin/'].includes(path)?'admin.html':path.slice(1);
    if(!publicFiles.has(relative)) throw new RoomError('NOT_FOUND','Not found',404);
    const file=resolve(root,relative);
    if(await realpath(file)!==file || !(await stat(file)).isFile()) throw new RoomError('NOT_FOUND','Not found',404);
    response.writeHead(200,{...security,'Content-Type':types[extname(file)]??'application/octet-stream',...(relative==='admin.html'?{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}:{})});
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
  try{pending=await rooms.processDeadlines();pending=(await rooms.processArchives()) || pending;pending=(await delivery.process()) || pending;}catch{pending=true;}
  finally{archiving=false;}
  if(pending || archiveWakeRequested){archiveTimer=setTimeout(archives,archiveWakeRequested?0:60000);archiveTimer.unref();}
}
function wakeArchives(){
  if(archiving){archiveWakeRequested=true;return;}
  clearTimeout(archiveTimer);archiveTimer=setTimeout(archives,0);archiveTimer.unref();
}
// Do not hold health/startup behind a slow push provider. Requests independently
// reconcile expired ballots before accepting gameplay.
wakeArchives();
server.listen(port,host,()=>process.stdout.write(`BrezelPesk is running at http://${host}:${server.address().port}\n`));
let closing=false;
process.on('SIGTERM',()=>{if(closing)return;closing=true;clearTimeout(archiveTimer);server.close(async()=>{await storage.close();});});
