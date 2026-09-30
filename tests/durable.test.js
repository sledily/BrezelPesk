import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentRooms } from '../src/persistent-rooms.js';
import { FileRoomStorage, PostgresRoomStorage } from '../src/room-storage.js';
import { dispatch } from '../src/engine.js';
import { validateInvariants } from '../src/rules.js';
import { RoomStore } from '../src/rooms.js';
import { forcePhase, givePool, PHASE, SUIT, PLAYER, addUnit, UNIT_TYPE, setUpMatch, must } from './helpers.js';
const id=()=>randomBytes(24).toString('hex');
const credentials=()=>({token:id(),recoveryCode:id()});
const limits={maxGames:5,totalBytes:32*1024*1024,reserveBytes:1024*1024};
async function fileStore(t, override={}){
  const dir=await mkdtemp(join(tmpdir(),'dendarv-v2-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=new FileRoomStorage(dir,{...limits,...override});await db.init();return db;
}
async function setup(db){
  const service=new PersistentRooms(db), creds=credentials();
  const host=await service.mutate('create',null,null,{playerCount:2,playerName:'White',seat:'WHITE',credentials:creds},id());
  const black=await service.mutate('join',host.code,null,{playerName:'Black',seat:'BLACK',credentials:credentials()},id());
  async function act(action,actor,body={}){
    const view=await service.view(host.code,actor.token);
    return service.mutate(action,host.code,actor.token,{...body,expectedRevision:view.viewer.private_revision},id());
  }
  await act('start',host);
  await act('command',black,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-S'}});
  await act('command',host,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-H'}});
  return {service,host,black,act};
}

for(const backend of ['file','postgres'])test(`${backend}: exact pending draw, retry, failure and restart`,async t=>{
  let db;
  if(backend==='file')db=await fileStore(t);
  else{
    let pool;
    if(process.env.DENDARV_TEST_DATABASE_URL){
      const {Pool}=await import('pg');
      const schema='test_'+randomBytes(12).toString('hex');
      const bootstrap=new Pool({connectionString:process.env.DENDARV_TEST_DATABASE_URL});
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      pool=new Pool({connectionString:process.env.DENDARV_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
      t.after(async()=>{await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);await bootstrap.end();});
    }else{
      const {PGlite}=await import('@electric-sql/pglite');const pg=new PGlite();
      let tail=Promise.resolve();
      const query=async(sql,params)=>sql.includes('CREATE TABLE')?(await pg.exec(sql)).at(-1):pg.query(sql,params);
      pool={query,end:()=>pg.close(),connect:async()=>{
        const previous=tail;let release;tail=new Promise(r=>release=r);await previous;
        return {query,release};
      }};
    }
    db=new PostgresRoomStorage(pool,limits);await db.init();t.after(()=>db.close());
  }
  const {service,host,black}=await setup(db);
  const initial=await service.view(host.code,host.token), original=await service.view(host.code,black.token);
  const request=id(), body={expectedRevision:initial.viewer.private_revision,command:{type:'DRAW_HARVEST',unit_id:'U-W-001',deck:'BLACK'}};
  const first=await service.mutate('command',host.code,host.token,body,request);
  const restored=new PersistentRooms(db);
  assert.deepEqual((await restored.view(host.code,host.token)).game.harvest.offer_ids,first.game.harvest.offer_ids);
  assert.deepEqual((await restored.mutate('command',host.code,host.token,body,request)).game.harvest.offer_ids,first.game.harvest.offer_ids);
  assert.deepEqual((await restored.view(host.code,black.token)).game,original.game);
  await assert.rejects(()=>restored.mutate('undo',host.code,host.token,{expectedRevision:first.viewer.private_revision},id()),e=>e.code==='NOTHING_TO_UNDO');
  await assert.rejects(()=>restored.mutate('command',host.code,host.token,{...body,command:{...body.command,deck:'RED'}},request),e=>e.code==='REQUEST_REUSED');
  const before=await db.read(host.code), originalTransact=db.transact.bind(db);
  db.transact=async(code,fn)=>{return originalTransact(code,async data=>{await fn(data);throw new Error('injected write failure');});};
  await assert.rejects(()=>restored.mutate('command',host.code,host.token,{expectedRevision:first.viewer.private_revision,command:{type:'KEEP_HARVEST_CARD',card_id:first.game.harvest.offer_ids[0]}},id()),e=>e.code==='SAVE_UNAVAILABLE');
  assert.deepEqual(await db.read(host.code),before);
  db.transact=originalTransact;
  // A COMMIT acknowledgement can be lost AFTER acceptance. Reconcile the identical request.
  const keepId=id(), keep={expectedRevision:first.viewer.private_revision,command:{type:'KEEP_HARVEST_CARD',card_id:first.game.harvest.offer_ids[0]}};
  db.transact=async(...args)=>{await originalTransact(...args);throw new Error('lost COMMIT response');};
  await assert.rejects(()=>restored.mutate('command',host.code,host.token,keep,keepId),e=>e.code==='SAVE_UNAVAILABLE');
  db.transact=originalTransact;
  const accepted=await db.read(host.code);
  await restored.mutate('command',host.code,host.token,keep,keepId);
  assert.deepEqual(await db.read(host.code),accepted);
  if (backend === 'postgres') {
    const otherProcess = new PersistentRooms(db);
    await otherProcess.view(host.code,host.token);
    const snapshot=await db.snapshot(host.code);
    assert.equal((await db.snapshot(host.code,snapshot.version)).data,null,'unchanged polling reads a version, not the private JSON document');
    await restored.mutate('recover',host.code,null,{recoveryCode:host.recoveryCode,token:id()},id());
    assert.equal((await otherProcess.view(host.code,host.token)).viewer.role,'SPECTATOR','a cached view revalidates another process takeover');
    for (let i=0;i<3;i++) await otherProcess.mutate('create',null,null,{playerName:'Additional',playerCount:2,credentials:credentials()},id());
    const requests = [service,otherProcess].map(s=>s.mutate('create',null,null,{playerName:'Race',playerCount:2,credentials:credentials()},id()));
    const outcomes=await Promise.allSettled(requests);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'STORAGE_CAPACITY');
  }
});

test('recovery transfers control, retains code/host and rejects old receipt replay',async t=>{
  const db=await fileStore(t),{service,host}=await setup(db), fresh=id();
  const view=await service.view(host.code,host.token), startRequest=id();
  const drawn=await service.mutate('command',host.code,host.token,{expectedRevision:view.viewer.private_revision,command:{type:'DRAW_HARVEST',unit_id:'U-W-001',deck:'RED'}},startRequest);
  const recovered=await service.mutate('recover',host.code,null,{recoveryCode:host.recoveryCode,token:fresh},id());
  assert.equal(recovered.view.viewer.is_host,true);
  assert.deepEqual(recovered.view.game.harvest.offer_ids,drawn.game.harvest.offer_ids);
  assert.equal((await service.view(host.code,host.token)).viewer.role,'SPECTATOR');
  await assert.rejects(()=>service.mutate('pass',host.code,host.token,{expectedRevision:view.viewer.private_revision},startRequest),e=>e.code==='SESSION_REPLACED');
  assert.equal((await service.mutate('recover',host.code,null,{recoveryCode:host.recoveryCode,token:id()},id())).seat,'WHITE');
});

test('concurrent admissions respect reserved space and count; retries do not consume new slots',async t=>{
  const db=await fileStore(t,{maxGames:1}),service=new PersistentRooms(db);
  const body={playerCount:2,playerName:'A',credentials:credentials()}, request=id();
  const results=await Promise.allSettled([service.mutate('create',null,null,body,request),service.mutate('create',null,null,{...body,credentials:credentials()},id())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'STORAGE_CAPACITY');
  const original=results.find(r=>r.status==='fulfilled').value;
  assert.equal((await service.mutate('create',null,null,body,request)).code,original.code);
  assert.equal((await db.inventory()).length,1);
});

test('admin recovery and Abandonment audit stay out of participant records; expiry retains archive',async t=>{
  const db=await fileStore(t),{service,host,black}=await setup(db),token=id(),recoveryCode=id();
  await service.admin(host.code,'recover',{requestId:id(),confirmed:true,seat:'WHITE',token,recoveryCode});
  await assert.rejects(()=>service.mutate('recover',host.code,null,{recoveryCode:host.recoveryCode,token:id()},id()),e=>e.code==='RECOVERY_DENIED');
  await service.admin(host.code,'abandon',{requestId:id(),confirmed:true});
  assert.equal((await db.read(host.code)).archive.status,'pending');
  await service.processArchives();
  const record=await service.export(host.code,black.token);
  assert.equal(record.status,'ABANDONED');
  assert.equal(record.audit,undefined);assert.doesNotMatch(JSON.stringify(record),/token_hash|recovery_hash/);
  await assert.rejects(()=>service.export(host.code,null),e=>e.code==='PARTICIPANT_REQUIRED');
  const inspected=await service.admin(host.code,'inspect');assert.equal(inspected.audit.length,2);assert.equal(inspected.archive.status,'ready');
  const future=new PersistentRooms(db,{now:()=>new Date(Date.now()+31*86400000)});
  await assert.rejects(()=>future.view(host.code,black.token),e=>e.code==='ROOM_ACCESS_EXPIRED');
  assert.equal((await future.admin(host.code,'inspect')).archive.status,'ready');
});

test('ordinary last affordable action waits for Pass and remains reversible',()=>{
  const core=new RoomStore({codeFactory:()=> 'ABC234'}),host=core.create({playerCount:2,playerName:'A'}),black=core.join(host.code,{playerName:'B',seat:'BLACK'});
  core.start(host.code,host.token);
  core.command(host.code,black.token,{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-S'});
  core.command(host.code,host.token,{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-H'});
  const room=core.get(host.code);forcePhase(room.committed_state,PHASE.BUILD);givePool(room.committed_state,PLAYER.WHITE,SUIT.CLOVERS,2);
  const before=structuredClone(room.committed_state);
  const result=core.command(host.code,host.token,{type:'BUILD_UNIT',square:'b1'});
  assert.equal(result.game.current_actor,'WHITE');assert.equal(result.viewer.can_undo,true);
  assert.deepEqual(core.view(host.code,black.token).game.units_by_id,core.view(host.code,null).game.units_by_id);
  core.undo(host.code,host.token);assert.deepEqual(core.get(host.code).committed_state,before);
});

test('completed spectator projection still hides Courts',async t=>{
  const db=await fileStore(t),{service,host}=await setup(db);
  let state=setUpMatch('private-finish');
  forcePhase(state,PHASE.RECRUIT,PLAYER.BLACK);givePool(state,PLAYER.BLACK,SUIT.DIAMONDS,20);
  state=must(state,{type:'RECRUIT_NOBLE',player:PLAYER.BLACK});
  const hidden=state.players.BLACK.court_noble_ids[0];
  forcePhase(state,PHASE.SIEGE,PLAYER.WHITE);
  state.units_by_id['U-W-001'].square='d4';state.units_by_id['U-B-001'].square='e5';
  givePool(state,PLAYER.WHITE,SUIT.SPADES,1000);
  await db.transact(host.code,async data=>{data.room.committed_state=state;return {write:data};});
  for(let i=0;i<20 && (await service.view(host.code,host.token)).room.status!=='COMPLETE';i++) {
    const view=await service.view(host.code,host.token);
    await service.mutate('command',host.code,host.token,{expectedRevision:view.viewer.private_revision,command:{type:'LAY_SIEGE',attacker_id:'U-W-001',defender_id:'U-B-001'}},id());
  }
  assert.deepEqual(validateInvariants((await db.read(host.code)).room.committed_state),[]);
  assert.equal((await db.read(host.code)).archive.status,'pending');
  const publicView=await service.view(host.code,null),privateView=await service.view(host.code,host.token);
  assert.equal(publicView.game.chronicle_complete,false);assert.equal(privateView.game.chronicle_complete,true);
  assert.equal(publicView.game.nobles_by_id[hidden],undefined);assert.ok(privateView.game.nobles_by_id[hidden]);
});

test('archive failure in one room survives restart and does not block another record', async t => {
  const db=await fileStore(t), a=await setup(db), b=await setup(db);
  for(const game of [a,b]) await game.service.admin(game.host.code,'abandon',{confirmed:true,requestId:id()});
  const original=db.transact.bind(db);
  db.transact=(code,fn)=>code===a.host.code?Promise.reject(new Error('archive destination failed')):original(code,fn);
  await a.service.processArchives();
  assert.equal((await db.read(a.host.code)).archive.status,'pending');
  assert.equal((await db.read(b.host.code)).archive.status,'ready');
  db.transact=original;
  await new PersistentRooms(db).processArchives();
  assert.equal((await db.read(a.host.code)).archive.status,'ready');
});

test('a synchronous file-save failure cannot leave Start accepted in memory', () => {
  const core=new RoomStore({codeFactory:()=> 'ABC234'});
  const host=core.create({playerCount:2,playerName:'A'});core.join(host.code,{seat:'BLACK',playerName:'B'});
  core.persist=()=>{throw new Error('disk failure');};
  assert.throws(()=>core.start(host.code,host.token),/disk failure/);
  assert.equal(core.view(host.code,host.token).room.status,'LOBBY');
});

for(const victor of [PLAYER.WHITE,PLAYER.BLACK]) test(`pending Quarter survives restart for ${victor} victor and publishes at the proper boundary`,async t=>{
  const db=await fileStore(t),{service,host,black}=await setup(db);
  let fixture;
  const attack={type:'LAY_SIEGE',player:PLAYER.WHITE,attacker_id:'ATTACKER',defender_id:'DEFENDER'};
  for(let i=0;i<80;i++){
    const state=setUpMatch(`quarter-${i}`,{automatic_passes:true,explicit_action_pass:true});
    forcePhase(state,PHASE.SIEGE,PLAYER.WHITE);
    addUnit(state,PLAYER.WHITE,UNIT_TYPE.ROOK,'d4',{vassalId:'NC-K-C',unitId:'ATTACKER'});
    addUnit(state,PLAYER.BLACK,UNIT_TYPE.PAWN,'d5',{vassalId:'NC-Q-C',unitId:'DEFENDER'});
    givePool(state,PLAYER.WHITE,SUIT.SPADES,99);
    const result=dispatch(state,attack);
    if(result.state?.pending_combat?.victor===victor){fixture=state;break;}
  }
  assert.ok(fixture);
  await db.transact(host.code,async data=>{data.room.committed_state=fixture;return {write:data};});
  const initial=await service.view(host.code,host.token),request=id();
  const body={expectedRevision:initial.viewer.private_revision,command:attack};
  await service.mutate('command',host.code,host.token,body,request);
  const saved=await db.read(host.code),pending=saved.room.draft_state??saved.room.committed_state;
  const restartedDb=new FileRoomStorage(db.directory,db.limits);await restartedDb.init();
  const restarted=new PersistentRooms(restartedDb),actor=victor===PLAYER.WHITE?host:black;
  const view=await restarted.view(host.code,actor.token);
  assert.equal(view.game.current_actor,victor);assert.deepEqual(view.game.pending_combat,pending.pending_combat);
  assert.deepEqual(await restartedDb.read(host.code),saved,'restart retains RNG, command history, pool, draft and pending response');
  await restarted.mutate('command',host.code,host.token,body,request);
  assert.deepEqual(await restartedDb.read(host.code),saved,'retry never rerolls the battle');
  const publicView=await restarted.view(host.code,null);
  assert.equal(Boolean(publicView.game.pending_combat),victor===PLAYER.BLACK,'defender handover automatically publishes; attacker choice remains private');
  await assert.rejects(()=>restarted.mutate('undo',host.code,actor.token,{expectedRevision:view.viewer.private_revision},id()));
  const choice={expectedRevision:view.viewer.private_revision,command:{type:'CHOOSE_QUARTER',quarter:true}},choiceId=id();
  const response=await restarted.mutate('command',host.code,actor.token,choice,choiceId);
  assert.equal(response.game.current_actor,PLAYER.WHITE);assert.equal(response.game.pending_combat,null);
  assert.equal((await restartedDb.read(host.code)).room.draft_state,null);
  await restarted.mutate('command',host.code,actor.token,choice,choiceId);
});

test('an action followed by Undo cannot make a stale revision valid again',async t=>{
  const db=await fileStore(t),{service,host}=await setup(db);
  await db.transact(host.code,async data=>{forcePhase(data.room.committed_state,PHASE.BUILD);givePool(data.room.committed_state,PLAYER.WHITE,SUIT.CLOVERS,2);return {write:data};});
  const before=await service.view(host.code,host.token);
  const command={type:'BUILD_UNIT',square:'b1'};
  const built=await service.mutate('command',host.code,host.token,{command,expectedRevision:before.viewer.private_revision},id());
  const undone=await service.mutate('undo',host.code,host.token,{expectedRevision:built.viewer.private_revision},id());
  assert.ok(undone.viewer.private_revision>built.viewer.private_revision);
  assert.equal(undone.room.revision,before.room.revision,'private actions do not advance the public revision');
  await assert.rejects(()=>service.mutate('command',host.code,host.token,{command,expectedRevision:before.viewer.private_revision},id()),e=>e.code==='STALE_VIEW');
  await service.mutate('abandon',host.code,host.token,{confirmed:true,expectedRevision:undone.viewer.private_revision},id());
  await assert.rejects(()=>service.mutate('undo',host.code,host.token,{expectedRevision:undone.viewer.private_revision},id()),e=>e.code==='MATCH_NOT_ACTIVE');
});
