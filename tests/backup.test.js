import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PersistentRooms } from '../src/persistent-rooms.js';
import { backupDatabase } from '../test-support/postgres-backup.js';
import { forcePhase,givePool,PHASE,PLAYER,SUIT } from './helpers.js';

const id=()=>randomBytes(24).toString('hex');
async function room(service) {
  const host=await service.mutate('create',null,null,{playerCount:2,playerName:'Restore White',credentials:{token:id(),recoveryCode:id()}},id());
  const black=await service.mutate('join',host.code,null,{seat:'BLACK',playerName:'Restore Black',credentials:{token:id(),recoveryCode:id()}},id());
  const act=async(action,actor,body={},request=id())=>service.mutate(action,host.code,actor.token,{...body,expectedRevision:(await service.view(host.code,actor.token)).viewer.private_revision},request);
  await act('start',host);
  await act('command',black,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-S'}});
  await act('command',host,{command:{type:'CHOOSE_SOVEREIGN',noble_id:'NC-K-H'}});
  return {host,black,act};
}
async function snapshot(db) {
  return {
    capacity:(await db.pool.query('SELECT * FROM dendarv_capacity ORDER BY id')).rows,
    rooms:(await db.pool.query('SELECT code,data,allocated_bytes,version FROM dendarv_rooms ORDER BY code')).rows,
  };
}

test('a complete database backup restores credentials, receipts, exact private state, audit, archives and limits',async t=>{
  const database=await backupDatabase(t),source=database.source,service=new PersistentRooms(source);
  t.diagnostic(database.kind);
  const harvest=await room(service),undo=await room(service),ready=await room(service);
  await service.admin(ready.host.code,'abandon',{confirmed:true,requestId:id()});
  await service.processArchives();
  const pending=await room(service);
  await service.admin(pending.host.code,'recover',{confirmed:true,requestId:id(),seat:'WHITE',token:id(),recoveryCode:id()});
  await service.admin(pending.host.code,'abandon',{confirmed:true,requestId:id()});
  const drawId=id(),drawBody={expectedRevision:(await service.view(harvest.host.code,harvest.host.token)).viewer.private_revision,
    command:{type:'DRAW_HARVEST',unit_id:'U-W-001',deck:'BLACK'}};
  const drawn=await service.mutate('command',harvest.host.code,harvest.host.token,drawBody,drawId);
  await source.transact(undo.host.code,async data=>{
    forcePhase(data.room.committed_state,PHASE.BUILD);givePool(data.room.committed_state,PLAYER.WHITE,SUIT.CLOVERS,2);
    return {write:data};
  });
  await undo.act('command',undo.host,{command:{type:'BUILD_UNIT',square:'b1'}});
  const before=await snapshot(source);
  const restored=await database.restore(), restarted=new PersistentRooms(restored);
  assert.deepEqual(await snapshot(restored),before,'all stored tables, versions and operational metadata survive actual backup restoration');
  const retried=await restarted.mutate('command',harvest.host.code,harvest.host.token,drawBody,drawId);
  assert.deepEqual(retried.game.harvest.offer_ids,drawn.game.harvest.offer_ids);
  assert.deepEqual(await snapshot(restored),before,'receipt replay does not apply another draw');
  const undoView=await restarted.view(undo.host.code,undo.host.token);
  assert.equal(undoView.viewer.can_undo,true);
  await restarted.mutate('undo',undo.host.code,undo.host.token,{expectedRevision:undoView.viewer.private_revision},id());
  const recovered=await restarted.mutate('recover',harvest.host.code,null,{recoveryCode:harvest.host.recoveryCode,token:id()},id());
  assert.equal(recovered.view.viewer.is_host,true);
  assert.equal((await restarted.view(harvest.host.code,harvest.host.token)).viewer.role,'SPECTATOR');
  assert.equal((await restarted.admin(ready.host.code,'inspect')).archive.status,'ready');
  assert.equal((await restarted.admin(pending.host.code,'inspect')).archive.status,'pending');
  await restarted.processArchives();
  const archived=await restarted.admin(pending.host.code,'inspect');
  assert.equal(archived.archive.status,'ready');assert.equal(archived.audit.length,2);
  await assert.rejects(()=>restarted.export(pending.host.code,null),e=>e.code==='PARTICIPANT_REQUIRED');
  assert.equal((await restarted.export(pending.host.code,pending.black.token)).status,'ABANDONED');
});
