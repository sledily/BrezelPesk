import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatch,replayCommandLog} from '../src/engine.js';
import {RoomStore} from '../src/rooms.js';
import {PersistentRooms} from '../src/persistent-rooms.js';
import {FileRoomStorage} from '../src/room-storage.js';
import {backupDatabase} from '../test-support/postgres-backup.js';
import {projectSpectator} from '../src/projection.js';
import {formatChronicle} from '../src/notation.js';
import {validateInvariants,liveUnits} from '../src/rules.js';
import {setUpMatch,setUpFourPlayerMatch,forcePhase,giveResource,must,PHASE,SUIT} from './helpers.js';
const at='2026-10-08T06:00:00.000Z';
const id=()=>randomBytes(24).toString('hex');
const credentials=()=>({token:id(),recoveryCode:id()});
function position(count=4){const s=count===4?setUpFourPlayerMatch('resign'):setUpMatch('resign');forcePhase(s,PHASE.BUILD);s.harvest=null;return s;}
function resign(s,player='RED'){return must(s,{type:'RESIGN',player,confirmed:true,at});}
function vote(s,player,choice){return must(s,{type:'RESIGNATION_VOTE',player,choice,at:'2026-10-08T07:00:00.000Z'});}
function unanimous(s,choice){for(const p of s.pending_resignation.survivors) s=vote(s,p,choice);return s;}
function noble(s,owner,id,location='COURT'){
 s.decks.NOBLE=s.decks.NOBLE.filter(x=>x!==id);Object.assign(s.nobles_by_id[id],{owner,location:`${owner}_${location}`,assigned_unit_id:null});
 if(location==='COURT') s.players[owner].court_noble_ids.push(id);
}
test('two-player resignation is confirmed, irreversible, replayable and records the reason',()=>{
 let s=setUpMatch('replay-resign');
 if(s.harvest.failsafe_pending) s=must(s,{type:'RESOLVE_HARVEST_FAILSAFE',player:s.current_actor,use_failsafe:false});
 assert.equal(dispatch(s,{type:'RESIGN',player:'BLACK',at}).error.code,'CONFIRM_REQUIRED');
 s=resign(s,'BLACK');assert.equal(s.winner,'WHITE');assert.equal(s.status,'COMPLETE');
 assert.match(formatChronicle(s),/resignation/);
 assert.deepEqual(replayCommandLog(s),s);
 assert.equal(dispatch(s,{type:'RESIGN',player:'WHITE',confirmed:true,at}).error.code,'MATCH_COMPLETE');
});
test('public changeable ballot pauses all commands, disallows resigning votes and resolves only unanimity',()=>{
 let s=resign(position());const deadline=s.pending_resignation.deadline;
 assert.equal(dispatch(s,{type:'PASS_PHASE',player:s.current_actor}).error.code,'NEGOTIATION_PENDING');
 assert.equal(dispatch(s,{type:'RESIGNATION_VOTE',player:'RED',choice:'WHITE',at}).error.code,'NOT_VOTER');
 s=vote(s,'WHITE','WHITE');s=vote(s,'BLACK','WHITE');assert.ok(s.pending_resignation);
 s=vote(s,'WHITE','NONE');assert.equal(s.pending_resignation.deadline,deadline);
 assert.equal(projectSpectator(s).pending_resignation.votes.WHITE,'NONE');
 s=unanimous(s,'NONE');assert.equal(s.pending_resignation,null);assert.equal(s.players.RED.eliminated,true);
 assert.deepEqual(validateInvariants(s),[]);
 s.rules.resource_flow_v2=true;
 assert.match(formatChronicle(s),/Red: Rsg[\s\S]*System: Award Red>None Unanimous/);
 assert.doesNotMatch(formatChronicle(s),/VoteCast/);
 assert.equal(s.event_log.filter(e=>e.type==='ResignationVoteCast').length,6);
});
test('no-spoils cleanup returns tapped cards and affected Hostages without exposing secret Court identities',()=>{
 let s=position();const card=giveResource(s,'RED',SUIT.CLOVERS,7,{counter:true,tapped:true});
 noble(s,'RED','NC-J-C-A');noble(s,'BLACK','NC-J-D-A','DUNGEON');s.players.RED.dungeon_noble_id='NC-J-D-A';s.nobles_by_id['NC-J-D-A'].location='RED_DUNGEON';
 noble(s,'RED','NC-J-H-A','DUNGEON');s.players.WHITE.dungeon_noble_id='NC-J-H-A';s.nobles_by_id['NC-J-H-A'].location='WHITE_DUNGEON';
 s=unanimous(resign(s),'NONE');
 assert.equal(s.players.RED.dungeon_noble_id,null);assert.equal(s.players.WHITE.dungeon_noble_id,null);
 for(const id of ['NC-J-C-A','NC-J-D-A','NC-J-H-A']) assert.ok(s.decks.NOBLE.includes(id));
 assert.ok(s.decks.BLACK.includes(card));assert.equal(s.resources_by_id[card].has_counter,false);
 assert.equal(liveUnits(s,'RED').length,0);assert.deepEqual(validateInvariants(s),[]);
 const e=projectSpectator(s).event_log.find(e=>e.type==='ResignedNoblesReturned');assert.equal(e.payload.noble_ids,undefined);
 s=resign(s,'GREEN');assert.equal(s.pending_resignation,null);assert.equal(s.players.GREEN.eliminated,true);
 s=resign(s,'BLACK');assert.equal(s.winner,'WHITE');assert.deepEqual(validateInvariants(s),[]);
});
for(const choice of ['CARD','HOLDING'])test(`awarded resignation spoils preserve obligations and resolve ${choice} without an invented battle`,()=>{
 let s=position();noble(s,'RED','NC-J-C-A');noble(s,'RED','NC-J-D-A');noble(s,'RED','NC-J-H-A');
 const card=giveResource(s,'RED',SUIT.HEARTS,8,{counter:true});s.resources_by_id[card].mandatory_spend_year=s.year_number;
 const tapped=giveResource(s,'RED',SUIT.CLOVERS,8,{tapped:true});
 s=unanimous(resign(s),'WHITE');assert.ok(s.pending_conquest);assert.equal(s.current_actor,'WHITE');
 assert.equal(s.players.WHITE.court_noble_ids.length,2);assert.ok(s.players.WHITE.resource_hand_ids.includes(card));assert.ok(s.players.RED.resource_hand_ids.includes(tapped));
 assert.equal(s.resources_by_id[card].has_counter,true);assert.equal(s.resources_by_id[card].mandatory_spend_year,s.year_number);
 s=must(s,{type:'CHOOSE_CONQUEST',player:'WHITE',choice});
 assert.equal(s.pending_conquest,null);assert.deepEqual(validateInvariants(s),[]);
 assert.equal(s.event_log.some(e=>e.type==='CombatResolved'),false);
 if(choice==='HOLDING')assert.ok(liveUnits(s,'WHITE').some(u=>u.square==='a8' && u.irreplaceable));
});
for(const backend of ['file','postgres'])test(`${backend}: ballot deadline, lost acknowledgements, recovery and restart remain durable`,async t=>{
 let db;if(backend==='postgres')db=(await backupDatabase(t)).source;else {const dir=await mkdtemp(join(tmpdir(),'resignation-'));t.after(()=>rm(dir,{recursive:true,force:true}));db=new FileRoomStorage(dir);await db.init();}
 let time=Date.parse(at);const now=()=>new Date(time);let service=new PersistentRooms(db,{now});
 const people={};const host=await service.mutate('create',null,null,{playerCount:4,playerName:'White',seat:'WHITE',credentials:credentials()},id());people.WHITE=host;
 for(const seat of ['GREEN','BLACK','RED'])people[seat]=await service.mutate('join',host.code,null,{playerName:seat,seat,credentials:credentials()},id());
 await db.transact(host.code,async data=>{data.room.committed_state=position();data.room.status='ACTIVE';return {write:data,result:null};});
 async function act(action,p,body={}){const view=await service.view(host.code,people[p].token);return service.mutate(action,host.code,people[p].token,{...body,expectedRevision:view.viewer.private_revision},id());}
 const view=await service.view(host.code,people.RED.token), request=id(),body={confirmed:true,expectedRevision:view.viewer.private_revision};
 const original=db.transact.bind(db);let lose=true;db.transact=async(...args)=>{const result=await original(...args);if(lose){lose=false;throw Error('lost ack');}return result;};
 await assert.rejects(()=>service.mutate('resign',host.code,people.RED.token,body,request),e=>e.code==='SAVE_UNAVAILABLE');db.transact=original;
 service=new PersistentRooms(db,{now});const retry=await service.mutate('resign',host.code,people.RED.token,body,request);
 assert.equal(retry.game.pending_resignation.deadline,'2026-10-09T06:00:00.000Z');
 await act('vote','WHITE',{choice:'WHITE'});await act('vote','BLACK',{choice:'WHITE'});
 const newToken=id();await service.mutate('recover',host.code,null,{recoveryCode:people.GREEN.recoveryCode,token:newToken},id());people.GREEN.token=newToken;
 const stale=await service.view(host.code,newToken);time+=86400000;
 service=new PersistentRooms(db,{now});
 await assert.rejects(()=>service.mutate('vote',host.code,newToken,{choice:'WHITE',expectedRevision:stale.viewer.private_revision},id()),e=>e.code==='STALE_VIEW');
 const after=await service.view(host.code,newToken);assert.equal(after.game.pending_resignation,null);assert.equal(after.game.pending_conquest,null);
 const data=await db.read(host.code);assert.equal(data.room.committed_state.event_log.filter(e=>e.type==='ResignationResolved').length,1);
 assert.equal(data.room.committed_state.event_log.find(e=>e.type==='ResignationResolved').payload.reason,'TIMEOUT');
 assert.deepEqual(validateInvariants(data.room.committed_state),[]);
});

test('room resignation rejects unpublished and compulsory decisions; terminal access is private and expires',()=>{
 let time=Date.parse(at);const core=new RoomStore({now:()=>new Date(time)});
 const host=core.create({playerCount:2,playerName:'White',seat:'WHITE'});
 const guest=core.join(host.code,{playerName:'Black',seat:'BLACK'});
 const room=core.get(host.code);room.committed_state=position(2);room.status='ACTIVE';
 room.draft_state=structuredClone(room.committed_state);room.draft_owner='WHITE';
 assert.throws(()=>core.lifecycle(host.code,guest.token,'resign',{confirmed:true}),e=>e.code==='UNPUBLISHED_TURN');
 core.get(host.code).draft_state=null;
 for(const field of ['active_ransom','pending_combat','pending_conquest']){
   core.get(host.code).committed_state[field]={};
   assert.equal(core.view(host.code,guest.token).viewer.can_resign,false);
   // Failed reducer calls restore a clone, so reset through the current room.
   assert.throws(()=>core.lifecycle(host.code,guest.token,'resign',{confirmed:true}),e=>['RESIGNATION_UNAVAILABLE','PENDING_DECISION'].includes(e.code));
   core.get(host.code).committed_state[field]=null;room.committed_state[field]=null;
 }
 assert.throws(()=>core.command(host.code,host.token,{type:'EXPIRE_RESIGNATION',at:'2099-01-01'}),e=>e.code==='USE_LIFECYCLE');
 const result=core.lifecycle(host.code,guest.token,'resign',{confirmed:true});
 assert.equal(result.room.status,'COMPLETE');assert.equal(result.terminal_record.state.winner,'WHITE');
 assert.equal(core.view(host.code).terminal_record,null);
 assert.ok(core.view(host.code,host.token).terminal_record.state.command_log);
 assert.doesNotMatch(JSON.stringify(result.terminal_record),/token_hash|recovery_hash/);
 assert.throws(()=>core.pass(host.code,host.token),e=>e.code==='MATCH_NOT_ACTIVE');
 time+=30*86400000;assert.throws(()=>core.view(host.code,guest.token),e=>e.code==='ROOM_ACCESS_EXPIRED');
});

test('resigning current Harvest actor resumes with a surviving actor and exact replay',()=>{
 let s=setUpFourPlayerMatch('harvest-resignation');
 if(s.harvest.failsafe_pending)s=must(s,{type:'RESOLVE_HARVEST_FAILSAFE',player:s.current_actor,use_failsafe:false});
 const player=s.current_actor;
 s=resign(s,player);s=unanimous(s,'NONE');
 assert.notEqual(s.current_actor,player);
 assert.ok(s.harvest.remaining_unit_ids.every(id=>s.units_by_id[id].owner===s.current_actor));
 assert.deepEqual(replayCommandLog(s),s);
});

test('deadline worker retries failed writes and never changes state or RNG twice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'deadline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=new FileRoomStorage(dir);await db.init();let time=Date.parse(at);
 const service=new PersistentRooms(db,{now:()=>new Date(time)});
 const host=await service.mutate('create',null,null,{playerCount:4,playerName:'Host',seat:'WHITE',credentials:credentials()},id());
 await db.transact(host.code,async data=>{data.room.committed_state=resign(position());data.room.status='ACTIVE';return {write:data,result:null};});
 const before=await db.read(host.code);time+=86400000;
 const original=db.transact.bind(db);db.transact=async()=>{throw Error('unavailable');};
 assert.equal(await service.processDeadlines(),true);assert.deepEqual(await db.read(host.code),before);
 await assert.rejects(()=>service.view(host.code,host.token),e=>e.code==='SAVE_UNAVAILABLE');
 db.transact=original;assert.equal(await service.processDeadlines(),false);
 const once=await db.read(host.code);assert.equal(await service.processDeadlines(),false);assert.deepEqual(await db.read(host.code),once);
});
