import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore, identifySeat } from '../src/rooms.js';
import { PersistentRooms } from '../src/persistent-rooms.js';
import { FileRoomStorage } from '../src/room-storage.js';
import { backupDatabase } from '../test-support/postgres-backup.js';
const id=()=>randomBytes(24).toString('hex');
const credentials=()=>({token:id(),recoveryCode:id()});
async function storage(t){const dir=await mkdtemp(join(tmpdir(),'lobby-'));t.after(()=>rm(dir,{recursive:true,force:true}));const db=new FileRoomStorage(dir);await db.init();return db;}

for (const count of [2,4]) {
  test(`Host chooses (${count} players): swapping seats keeps host identity and all recovery credentials`,()=>{
    const core=new RoomStore();
    const people=[core.create({playerCount:count,playerName:'Host',seatingMode:'HOST'})];
    for(let i=1;i<count;i++)people.push(core.join(people[0].code,{playerName:`P${i}`}));
    const code=people[0].code,room=core.get(code);
    const initial=new Map(people.map(p=>[p.token,core.view(code,p.token).viewer.participant_id]));
    assert.equal(room.status,'LOBBY');assert.equal(room.committed_state,null);
    const hostSeat=identifySeat(room,people[0].token),otherSeat=identifySeat(room,people[1].token);
    core.lobby(code,people[0].token,'assign',{participantId:initial.get(people[0].token),seat:otherSeat});
    assert.equal(core.view(code,people[0].token).viewer.seat,otherSeat);
    assert.equal(core.view(code,people[0].token).viewer.is_host,true);
    assert.equal(core.view(code,people[1].token).viewer.seat,hostSeat);
    assert.throws(()=>core.start(code,people[1].token),e=>e.code==='HOST_REQUIRED');
    core.start(code,people[0].token);
    for(const p of people){
      const next=id();const before=core.view(code,p.token).viewer;
      const recovered=core.recover(code,{recoveryCode:p.recoveryCode,token:next}).view;
      assert.equal(recovered.viewer.participant_id,initial.get(p.token));
      assert.equal(recovered.viewer.seat,before.seat);
      assert.equal(recovered.viewer.is_host,before.is_host);
      p.token=next;
    }
    assert.throws(()=>core.lobby(code,people[0].token,'remove',{participantId:initial.get(people[1].token)}),e=>e.code==='LOBBY_CLOSED');
  });

  test(`Random (${count} players): no colours before automatic Start and no identity lost in final assignment`,()=>{
    const core=new RoomStore();
    const host=core.create({playerCount:count,playerName:'Host',seatingMode:'RANDOM'}),people=[host];
    assert.deepEqual(host.view.room.seats,{});assert.equal(host.view.viewer.seat,null);
    assert.equal(host.view.viewer.can_start,false);assert.equal(host.view.game,null);
    assert.throws(()=>core.start(host.code,host.token),e=>e.code==='AUTOMATIC_START');
    for(let i=1;i<count;i++) {
      const joined=core.join(host.code,{playerName:`P${i}`,seat:'INVALID-IGNORED'});people.push(joined);
      if(i<count-1){assert.equal(joined.view.game,null);assert.equal(joined.view.viewer.seat,null);}
    }
    assert.equal(core.get(host.code).status,'ACTIVE');
    assert.equal(core.get(host.code).ready_sequence,0,'Random must not create a room-ready event');
    assert.equal(core.view(host.code,host.token).viewer.is_host,true);
    assert.equal(core.get(host.code).committed_state.status,'SETUP','Sovereigns selected only after Start');
    const assigned=people.map(p=>core.view(host.code,p.token).viewer.seat);
    assert.equal(new Set(assigned).size,count);
    for(const p of people){const token=id();assert.equal(core.recover(host.code,{recoveryCode:p.recoveryCode,token}).seat,assigned[people.indexOf(p)]);}
  });
}

test('Free choice holds for host Start; removing/leaving revokes old credentials and never transfers hosting',()=>{
  const core=new RoomStore(),host=core.create({playerCount:2,playerName:'Host',seat:'BLACK',seatingMode:'FREE'});
  const guest=core.join(host.code,{playerName:'Guest',seat:'WHITE'});
  assert.equal(core.get(host.code).status,'LOBBY');assert.equal(core.get(host.code).ready_sequence,1);
  assert.throws(()=>core.lobby(host.code,host.token,'assign',{participantId:guest.view.viewer.participant_id,seat:'BLACK'}),e=>e.code==='SEATING_MODE');
  assert.throws(()=>core.lobby(host.code,host.token,'leave'),e=>e.code==='HOST_CANNOT_LEAVE');
  assert.throws(()=>core.lobby(host.code,guest.token,'remove',{participantId:host.view.viewer.participant_id}),e=>e.code==='HOST_REQUIRED');
  core.lobby(host.code,host.token,'remove',{participantId:guest.view.viewer.participant_id});
  assert.equal(core.view(host.code,guest.token).viewer.role,'SPECTATOR');
  assert.throws(()=>core.recover(host.code,{recoveryCode:guest.recoveryCode}),e=>e.code==='RECOVERY_DENIED');
  const next=core.join(host.code,{playerName:'Replacement',seat:'WHITE'});
  assert.equal(core.get(host.code).ready_sequence,2);
  core.lobby(host.code,next.token,'leave');
  assert.equal(core.get(host.code).seats.WHITE,null);
  assert.equal(core.view(host.code,host.token).viewer.is_host,true);
});

for(const backend of ['file','postgres'])test(`${backend}: final Random join races, lost acknowledgement, restart and recovery retain the one accepted assignment`,async t=>{
  const db=backend==='file'?await storage(t):(await backupDatabase(t)).source;
  let service=new PersistentRooms(db);
  const host=await service.mutate('create',null,null,{playerCount:2,playerName:'Host',seatingMode:'RANDOM',credentials:credentials()},id());
  const guests=[credentials(),credentials()], requests=[id(),id()];
  const bodies=guests.map((c,i)=>({playerName:`Guest ${i}`,credentials:c}));
  const original=db.transact.bind(db);
  let drop=true;
  db.transact=async(...args)=>{const result=await original(...args);if(drop){drop=false;throw new Error('lost commit acknowledgement');}return result;};
  const results=await Promise.allSettled(bodies.map((b,i)=>service.mutate('join',host.code,null,b,requests[i])));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,0);
  assert.ok(results.some(r=>r.reason.code==='SAVE_UNAVAILABLE'));
  assert.ok(results.some(r=>r.reason.code==='MATCH_ALREADY_STARTED'));
  db.transact=original;
  const stored=await db.read(host.code),accepted=guests.findIndex(c=>identifySeat(stored.room,c.token));
  const exact=structuredClone(stored.room);
  service=new PersistentRooms(db);
  const retried=await service.mutate('join',host.code,null,bodies[accepted],requests[accepted]);
  assert.equal(retried.view.room.status,'ACTIVE');
  assert.deepEqual((await db.read(host.code)).room,exact);
  const token=id();
  const recovered=await service.mutate('recover',host.code,null,{recoveryCode:host.recoveryCode,token},id());
  assert.equal(recovered.view.viewer.is_host,true);
  assert.equal(recovered.seat,identifySeat(exact,host.token));
  assert.deepEqual((await db.read(host.code)).room.committed_state,exact.committed_state);
});

for(const backend of ['file','postgres'])test(`${backend}: confirmed cancellation closes invitations, retries safely and releases a game slot without an archive`,async t=>{
  const db=backend==='file'?await storage(t):(await backupDatabase(t)).source;
  let service=new PersistentRooms(db);
  const make=()=>({playerCount:2,playerName:'Host',seatingMode:'HOST',credentials:credentials()});
  const body=make(),createId=id(),host=await service.mutate('create',null,null,body,createId);
  for(let i=1;i<5;i++)await service.mutate('create',null,null,make(),id());
  await assert.rejects(()=>service.mutate('create',null,null,make(),id()),e=>e.code==='STORAGE_CAPACITY');
  const request=id(),cancel={confirmed:true,expectedRevision:host.view.viewer.private_revision};
  await assert.rejects(()=>service.mutate('cancel',host.code,host.token,{...cancel,confirmed:false},id()),e=>e.code==='CONFIRM_REQUIRED');
  const original=db.transact.bind(db);
  db.transact=async(...args)=>{await original(...args);throw new Error('lost cancellation response');};
  await assert.rejects(()=>service.mutate('cancel',host.code,host.token,cancel,request),e=>e.code==='SAVE_UNAVAILABLE');
  db.transact=original;service=new PersistentRooms(db);
  assert.equal((await service.mutate('cancel',host.code,host.token,cancel,request)).cancelled,true);
  assert.equal((await db.read(host.code)).archive,null);
  await assert.rejects(()=>service.view(host.code,host.token),e=>e.code==='ROOM_CANCELLED');
  await assert.rejects(()=>service.summary(host.code,null),e=>e.code==='ROOM_CANCELLED');
  await assert.rejects(()=>service.mutate('join',host.code,null,{playerName:'Late',credentials:credentials()},id()),e=>e.code==='ROOM_CANCELLED');
  await assert.rejects(()=>service.mutate('create',null,null,body,createId),e=>e.code==='ROOM_CANCELLED');
  const newRoom=await service.mutate('create',null,null,make(),id());assert.ok(newRoom.code);
  assert.equal((await db.inventory()).filter(r=>r.counts_as_game!==false).length,5);
});

test('leaving acknowledges the same request after revocation; stale controls cannot remove a replacement',async t=>{
  const db=await storage(t),service=new PersistentRooms(db);
  const host=await service.mutate('create',null,null,{playerCount:2,playerName:'Host',seat:'WHITE',credentials:credentials()},id());
  const guest=await service.mutate('join',host.code,null,{playerName:'Guest',seat:'BLACK',credentials:credentials()},id());
  const oldId=guest.view.viewer.participant_id,request=id(),body={expectedRevision:guest.view.viewer.private_revision};
  assert.equal((await service.mutate('leave',host.code,guest.token,body,request)).left,true);
  assert.equal((await service.mutate('leave',host.code,guest.token,body,request)).left,true);
  await service.mutate('join',host.code,null,{playerName:'Replacement',seat:'BLACK',credentials:credentials()},id());
  const now=await service.view(host.code,host.token);
  await assert.rejects(()=>service.mutate('remove',host.code,host.token,{participantId:oldId,expectedRevision:now.viewer.private_revision},id()),e=>e.code==='PARTICIPANT_NOT_FOUND');
  assert.equal((await service.view(host.code,host.token)).room.seats.BLACK.name,'Replacement');
});

test('older Free choice lobbies receive stable participant identities before management',()=>{
  const core=new RoomStore();
  const host=core.create({playerCount:2,playerName:'Host',seat:'WHITE'});
  const guest=core.join(host.code,{playerName:'Guest',seat:'BLACK'});
  const room=core.rooms[host.code];
  delete room.seating_mode;
  for(const p of Object.values(room.seats)) delete p.participant_id;
  const oldRecord=structuredClone(room);
  const first=core.view(host.code,host.token);
  core.rooms[host.code]=structuredClone(oldRecord);
  const second=core.view(host.code,host.token);
  assert.deepEqual(first.room.participants,second.room.participants);
  assert.equal(second.room.seating_mode,'FREE');
  assert.throws(()=>core.lobby(host.code,host.token,'remove',{}),e=>e.code==='PARTICIPANT_NOT_FOUND');
  core.lobby(host.code,host.token,'remove',{participantId:second.room.seats.BLACK.participant_id});
  assert.equal(core.view(host.code,guest.token).viewer.role,'SPECTATOR');
});
