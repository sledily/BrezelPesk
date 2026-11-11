import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {PersistentRooms} from '../src/persistent-rooms.js';
import {defaultLimits} from '../src/room-storage.js';
import {reconnectRecap} from '../src/recap.js';
import {backupDatabase} from '../test-support/postgres-backup.js';

const id=()=>randomBytes(24).toString('hex');
const limits={...defaultLimits,maxGames:32};
const seats=['WHITE','GREEN','BLACK','RED'];

for(const playerCount of [2,4])test(`twelve-player pilot: ${12/playerCount} concurrent ${playerCount}-player games survive backup, reconnect and recovery`,async t=>{
  const database=await backupDatabase(t,limits);
  let service=new PersistentRooms(database.source);
  let nextPlayer=1;
  const people=Array.from({length:12},()=>({name:`Pilot ${nextPlayer++}`,token:id(),recoveryCode:id()}));
  const groups=Array.from({length:12/playerCount},(_,i)=>people.slice(i*playerCount,(i+1)*playerCount));
  const games=await Promise.all(groups.map(async people=>{
    const order=playerCount===2?['WHITE','BLACK']:seats;
    const host=await service.mutate('create',null,null,{playerCount,playerName:people[0].name,seat:'WHITE',credentials:people[0]},id());
    const clients=Object.fromEntries(order.map((seat,i)=>[seat,people[i]]));
    for(const seat of order.slice(1))await service.mutate('join',host.code,null,{seat,playerName:clients[seat].name,credentials:clients[seat]},id());
    const game={code:host.code,clients,people};
    game.act=async(action,seat,selection={})=>{
      const actor=clients[seat];
      const view=await service.view(game.code,actor.token);
      const body={...selection,expectedRevision:view.viewer.private_revision};
      const requestId=id();
      const result=await service.mutate(action,game.code,actor.token,body,requestId);
      game.lastRequest={action,actor,body,requestId};
      return result;
    };
    await game.act('start','WHITE');
    for(let step=0;step<playerCount;step++){
      const state=(await service.view(game.code,clients.WHITE.token)).game;
      assert.equal(state.status,'SETUP');
      await game.act('command',state.current_actor,{command:{type:'CHOOSE_SOVEREIGN',noble_id:state.sovereign_pool_ids[0]}});
    }
    return game;
  }));

  // Run genuine Harvest requests in parallel games. Each seat finishes its first
  // opportunity, giving reconnect playback a real, published personal boundary.
  await Promise.all(games.map(async game=>{
    for(let step=0;step<40;step++){
      const summary=await service.summary(game.code,game.clients.WHITE.token);
      const state=(await service.view(game.code,game.clients[summary.actor].token)).game;
      if(state.year_number!==1||state.phase!=='HARVEST')break;
      const h=state.harvest;
      let command;
      if(h.stage==='POKER')command={type:'FINISH_POKER'};
      else if(h.failsafe_pending)command={type:'RESOLVE_HARVEST_FAILSAFE',use:false};
      else if(h.offer_ids.length)command={type:'KEEP_HARVEST_CARD',card_id:h.offer_ids[0]};
      else command={type:'DRAW_HARVEST',unit_id:h.remaining_unit_ids[0],deck:'RED'};
      await game.act('command',state.current_actor,{command});
      if(step===39)assert.fail('Pilot Harvest did not finish');
    }
  }));

  const clients=games.flatMap(game=>Object.entries(game.clients).map(([seat,person])=>({game,seat,person})));
  assert.equal(clients.length,12);
  const expected=await Promise.all(clients.map(async client=>{
    const view=await service.view(client.game.code,client.person.token);
    assert.equal(view.viewer.role,'PLAYER');
    assert.equal(view.viewer.seat,client.seat);
    const recap=reconnectRecap(view.game,client.seat);
    if(client.seat==='WHITE')assert.ok(recap.steps.some(step=>step.kind==='harvest'&&step.actor!=='WHITE'),'returning White sees the other players’ saved Harvest actions');
    return {game:view.game,recap,revision:view.viewer.private_revision};
  }));
  const rows=(await database.source.pool.query('SELECT code,data,version,allocated_bytes FROM dendarv_rooms ORDER BY code')).rows;
  const logicalBytes=rows.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.data)),0);
  assert.equal(rows.length,groups.length);
  assert.ok(rows.reduce((sum,row)=>sum+Number(row.allocated_bytes),0)<=limits.totalBytes);

  const restored=await database.restore();
  service=new PersistentRooms(restored);
  assert.deepEqual((await restored.pool.query('SELECT code,data,version,allocated_bytes FROM dendarv_rooms ORDER BY code')).rows,rows);
  const replay=await Promise.all(clients.map(async client=>{
    const view=await service.view(client.game.code,client.person.token);
    return {game:view.game,recap:reconnectRecap(view.game,client.seat),revision:view.viewer.private_revision};
  }));
  assert.deepEqual(replay,expected,'all twelve private views and complete recap queues survive an independent database restore');

  await Promise.all(games.map(game=>{
    const r=game.lastRequest;
    return service.mutate(r.action,game.code,r.actor.token,r.body,r.requestId);
  }));
  assert.deepEqual((await restored.pool.query('SELECT code,data,version,allocated_bytes FROM dendarv_rooms ORDER BY code')).rows,rows,'retrying accepted requests neither redraws cards nor writes another version');

  await Promise.all(clients.map(async(client,i)=>{
    const token=id();
    const recovered=await service.mutate('recover',client.game.code,null,{recoveryCode:client.person.recoveryCode,token},id());
    assert.equal(recovered.seat,client.seat);
    assert.deepEqual(recovered.view.game,expected[i].game);
    assert.equal((await service.view(client.game.code,client.person.token)).viewer.role,'SPECTATOR');
    assert.deepEqual((await service.view(client.game.code,token)).game,expected[i].game);
    const other=games[(games.indexOf(client.game)+1)%games.length];
    assert.equal((await service.view(other.code,token)).viewer.role,'SPECTATOR','credentials from one game cannot control another');
  }));
  t.diagnostic(`${database.kind}; 12 players; ${groups.length} games; ${logicalBytes} logical JSON bytes after setup and first Harvest. This is continuity coverage, not a production load or annual-storage guarantee.`);
});
