import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {PersistentRooms} from '../src/persistent-rooms.js';
import {FileRoomStorage,defaultLimits} from '../src/room-storage.js';
import {backupDatabase} from '../test-support/postgres-backup.js';
import {archiveZip} from '../src/archive-zip.js';
import {AdminAuth} from '../src/admin-auth.js';
const id=()=>randomBytes(24).toString('hex');
async function fileDB(t,limits=defaultLimits){
  const dir=await mkdtemp(join(tmpdir(),'dendarv-admin-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=new FileRoomStorage(dir,limits);await db.init();return db;
}
async function match(db) {
  const service=new PersistentRooms(db),body={playerCount:2,playerName:'Private White',seat:'WHITE',credentials:{token:id(),recoveryCode:id()}},request=id();
  const host=await service.mutate('create',null,null,body,request);
  const black=await service.mutate('join',host.code,null,{playerName:'Private Black',seat:'BLACK',credentials:{token:id(),recoveryCode:id()}},id());
  const act=async(action,actor,body={})=>service.mutate(action,host.code,actor.token,{...body,expectedRevision:(await service.view(host.code,actor.token)).viewer.private_revision},id());
  await act('start',host);await act('command',black,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-S'}});
  await act('command',host,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-H'}});
  return {service,host,black,act,body,request};
}
for(const backend of ['file','postgres'])test(`${backend}: explicit archive deletion reclaims admission, preserves audit, survives retry and cannot resurrect a room`,async t=>{
  const database=backend==='postgres'?await backupDatabase(t):null,db=database?.source??await fileDB(t);
  const {service,host,black,body,request}=await match(db),code=host.code;
  const deletion={confirmed:true,requestId:id(),confirmCode:code};
  await assert.rejects(()=>service.admin(code,'delete-archive',deletion),e=>e.code==='ARCHIVE_REQUIRED');
  await service.admin(code,'abandon',{confirmed:true,requestId:id()});
  await service.processArchives();
  const before=await db.read(code),files=await service.archiveFiles();
  assert.deepEqual(await db.read(code),before,'download never modifies stored records or retention');
  assert.equal(files.length,3);assert.equal(JSON.parse(files[1].content).status,'ABANDONED');
  assert.doesNotMatch(JSON.stringify(files),/token_hash|recovery_hash|subscriptions|audit|receipts/);
  await assert.rejects(()=>service.admin(code,'delete-archive',{...deletion,confirmed:false}),e=>e.code==='CONFIRM_REQUIRED');
  await assert.rejects(()=>service.admin(code,'delete-archive',{...deletion,confirmCode:'WRONG2'}),e=>e.code==='CONFIRM_REQUIRED');
  await service.view(code,black.token); // cache the live record before another process deletes it
  const other=new PersistentRooms(db),original=db.transact.bind(db);
  db.transact=async()=>{throw new Error('save unavailable');};
  await assert.rejects(()=>other.admin(code,'delete-archive',deletion),/save unavailable/);
  assert.deepEqual(await db.read(code),before,'a rejected save cannot remove the archive');
  let originalConnect;
  if(database) {
    originalConnect=db.pool.connect.bind(db.pool);
    db.pool.connect=async()=>{const client=await originalConnect(),query=client.query.bind(client);
      return {query:(sql,params)=>sql.includes('pg_database_size')?Promise.resolve({rows:[{bytes:defaultLimits.totalBytes*5}]}):query(sql,params),release:(...args)=>client.release(...args)};
    };
  }
  let lost=true;
  db.transact=async(...args)=>{const result=await original(...args);if(lost){lost=false;throw new Error('lost acknowledgement');}return result;};
  await assert.rejects(()=>other.admin(code,'delete-archive',deletion),/lost acknowledgement/);
  db.transact=original;if(originalConnect)db.pool.connect=originalConnect;
  assert.deepEqual(await new PersistentRooms(db).admin(code,'delete-archive',deletion),{ok:true});
  const tombstone=await db.read(code);
  assert.deepEqual(tombstone.audit.map(entry=>entry.action),['ABANDON','DELETE-ARCHIVE']);
  assert.equal(tombstone.audit[1].code,code);assert.equal(tombstone.archive,null);
  assert.doesNotMatch(JSON.stringify(tombstone),/Private White|Private Black|token_hash|recovery_hash|committed_state|draft_state|notifications/);
  assert.deepEqual(Object.keys(tombstone.receipts),['admin:'+deletion.requestId]);
  await assert.rejects(()=>service.view(code,black.token),e=>e.code==='ARCHIVE_DELETED');
  await assert.rejects(()=>service.summary(code,host.token),e=>e.code==='ARCHIVE_DELETED');
  await assert.rejects(()=>service.mutate('create',null,null,body,request),e=>e.code==='ARCHIVE_DELETED');
  await assert.rejects(()=>service.mutate('recover',code,null,{recoveryCode:host.recoveryCode,token:id()},id()),e=>e.code==='ARCHIVE_DELETED');
  await assert.rejects(()=>service.admin(code,'delete-archive',{...deletion,confirmCode:'WRONG2'}),e=>e.code==='REQUEST_REUSED');
  assert.equal((await service.archiveFiles()).length,1);assert.equal((await db.pendingArchives()).length,0);
  const inventory=await service.adminInventory();assert.equal(inventory.rooms[0].status,'DELETED');assert.equal(inventory.rooms[0].counts_as_game,false);
  assert.ok(Number(inventory.rooms[0].bytes)<5000);
  for(let n=0;n<5;n++)await service.mutate('create',null,null,{playerCount:2,playerName:'New host',credentials:{token:id(),recoveryCode:id()}},id());
  assert.equal((await db.inventory()).filter(row=>row.counts_as_game).length,5,'deleted game releases one game slot');
  if(database){const restored=await database.restore();assert.deepEqual(await restored.read(code),tombstone);assert.deepEqual(await new PersistentRooms(restored).admin(code,'delete-archive',deletion),{ok:true});}
});

test('admin recovery preserves a pending draw, rejects stale inspection, and never reopens an ended game',async t=>{
  const db=await fileDB(t),{service,host,black,act}=await match(db),code=host.code;
  await act('command',host,{command:{type:'DRAW_HARVEST',unit_id:'U-W-001',deck:'BLACK'}});
  const before=await db.read(code),inspection=await service.admin(code,'inspect');
  assert.deepEqual(inspection.record.state,before.room.draft_state??before.room.committed_state);
  assert.doesNotMatch(JSON.stringify(inspection),/token_hash|recovery_hash/);
  const recovery={confirmed:true,requestId:id(),seat:'WHITE',token:id(),recoveryCode:id(),expectedRevision:inspection.revision};
  await assert.rejects(()=>service.admin(code,'recover',{...recovery,expectedRevision:inspection.revision-1}),e=>e.code==='STALE_VIEW');
  await service.admin(code,'recover',recovery);
  const after=await db.read(code);
  assert.deepEqual(after.room.committed_state,before.room.committed_state);assert.deepEqual(after.room.draft_state,before.room.draft_state);
  assert.deepEqual(after.room.draft_history,before.room.draft_history);
  assert.equal((await service.view(code,host.token)).viewer.role,'SPECTATOR');
  await assert.rejects(()=>service.mutate('recover',code,null,{recoveryCode:host.recoveryCode,token:id()},id()),e=>e.code==='RECOVERY_DENIED');
  await service.admin(code,'recover',recovery);assert.equal((await db.read(code)).audit.length,1);
  const newer={confirmed:true,requestId:id(),seat:'WHITE',token:id(),recoveryCode:id()};await service.admin(code,'recover',newer);
  await assert.rejects(()=>service.admin(code,'recover',recovery),e=>e.code==='RECOVERY_REPLACED');
  await service.admin(code,'abandon',{confirmed:true,requestId:id()});
  const abandoned=await service.admin(code,'inspect');
  assert.deepEqual(abandoned.record.state,inspection.record.state,'unfinished draw remains exact');
  assert.equal(abandoned.record.state.winner,null);
  const terminalCode={...newer,requestId:id(),token:id(),recoveryCode:id()};await service.admin(code,'recover',terminalCode);
  const readonly=await service.mutate('recover',code,null,{recoveryCode:terminalCode.recoveryCode,token:id()},id());
  assert.equal(readonly.view.room.status,'ABANDONED');
  await assert.rejects(()=>service.mutate('command',code,readonly.token,{expectedRevision:readonly.view.viewer.private_revision,command:{type:'PASS_PHASE'}},id()));
  const expired=new PersistentRooms(db,{now:()=>new Date(Date.now()+31*86400000)});
  await assert.rejects(()=>expired.admin(code,'recover',{...newer,requestId:id()}),e=>e.code==='ROOM_ACCESS_EXPIRED');
  assert.equal((await expired.archiveFiles()).length,3,'archive outlives participant expiry');
  assert.equal((await service.export(code,black.token)).audit,undefined);
});

test('pending archives can be downloaded without waiting, explicitly retried, or deleted without resurrection by workers',async t=>{
  const db=await fileDB(t),{service,host}=await match(db),code=host.code;
  await service.admin(code,'abandon',{confirmed:true,requestId:id()});
  const before=await db.read(code),files=await service.archiveFiles();assert.equal(files.length,3);assert.deepEqual(await db.read(code),before);
  await db.transact(code,data=>{data.archive.next_attempt=Date.now()+86400000;data.archive.attempts=2;return {write:data};});
  const retry={confirmed:true,requestId:id()};await service.admin(code,'retry-archive',retry);await service.admin(code,'retry-archive',retry);
  assert.equal((await db.read(code)).archive.next_attempt,0);assert.equal((await db.read(code)).audit.length,2);
  await service.admin(code,'delete-archive',{confirmed:true,requestId:id(),confirmCode:code});
  await service.processArchives();assert.equal((await db.read(code)).room.status,'DELETED');
});

test('unformattable archive aborts the entire download instead of silently omitting a record',async t=>{
  const db=await fileDB(t),{service,host}=await match(db);
  await service.admin(host.code,'abandon',{confirmed:true,requestId:id()});
  await db.transact(host.code,data=>{data.archive.record.state=null;return {write:data};});
  await assert.rejects(()=>service.archiveFiles(),e=>e.code==='ARCHIVE_UNAVAILABLE');
});

test('ZIP extracts with Python standard-library CRC verification and exact Unicode records',()=>{
  const files=[{name:'manifest.json',content:'{"games":1}'},{name:'ABC234/record.json',content:'{"name":"Éléonore ♧ 王"}'},{name:'ABC234/chronicle.txt',content:'Status: Unfinished / Abandoned.\n'}];
  const zip=archiveZip(files),python=spawnSync('python3',['-c',
    'import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([{ "name":n, "content":z.read(n).decode("utf-8")} for n in z.namelist()]))'],{input:zip});
  assert.equal(python.status,0,python.stderr.toString());assert.deepEqual(JSON.parse(python.stdout.toString()),files);
  assert.throws(()=>archiveZip([{name:'../escape.json',content:'x'}]),/filename/);
  assert.throws(()=>archiveZip(files,4),/limit/);
});

test('administrator sessions expire, require CSRF, and revoke on sign-out',()=>{
  const auth=new AdminAuth('synthetic-password-long-enough'),session=auth.login('synthetic-password-long-enough');
  const request={method:'POST',headers:{cookie:`dendarv_admin=${session.token}`,'x-admin-csrf':session.csrf}};
  assert.throws(()=>auth.check({...request,headers:{cookie:request.headers.cookie}}),e=>e.code==='CSRF_REQUIRED');
  assert.equal(auth.check(request).csrf,session.csrf);auth.logout(request);
  assert.throws(()=>auth.check(request),e=>e.code==='ADMIN_REQUIRED');
  const expired=auth.login('synthetic-password-long-enough');auth.sessions.get(expired.token).expires=0;
  assert.throws(()=>auth.check({method:'GET',headers:{cookie:`dendarv_admin=${expired.token}`}}),e=>e.code==='ADMIN_REQUIRED');
});
