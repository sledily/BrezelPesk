import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileRoomStorage} from '../src/room-storage.js';
import {PersistentRooms} from '../src/persistent-rooms.js';
import {NotificationDelivery,notificationOpportunities,notificationPayload,validateSubscription,syncNotifications} from '../src/notifications.js';
import {backupDatabase} from '../test-support/postgres-backup.js';
import {setUpMatch,forcePhase,PHASE} from './helpers.js';
const id=()=>randomBytes(24).toString('hex');
const creds=()=>({token:id(),recoveryCode:id()});
function subscription(){const key=createECDH('prime256v1');key.generateKeys();return {endpoint:`https://fcm.googleapis.com/fcm/send/${id()}`,keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};}
async function fixture(t,backend='file',mode='FREE'){
 let db;if(backend==='postgres')db=(await backupDatabase(t)).source;else{const dir=await mkdtemp(join(tmpdir(),'notify-'));t.after(()=>rm(dir,{recursive:true,force:true}));db=new FileRoomStorage(dir);await db.init();}
 let time=Date.parse('2026-10-08T12:00:00Z');let service=new PersistentRooms(db,{now:()=>new Date(time),notificationsEnabled:true});
 const host=await service.mutate('create',null,null,{playerCount:2,playerName:'Host',seat:'WHITE',seatingMode:mode,credentials:creds()},id());
 const act=async(action,person,body={},request=id())=>{const view=await service.view(host.code,person.token);return service.mutate(action,host.code,person.token,{...body,expectedRevision:view.viewer.private_revision},request);};
 return {db,host,act,get service(){return service;},get time(){return time;},advance(ms){time+=ms;},restart(){service=new PersistentRooms(db,{now:()=>new Date(time),notificationsEnabled:true});},
 join:()=>service.mutate('join',host.code,null,{playerName:'Guest',seat:'BLACK',credentials:creds()},id()),
 delivery(send,options={}){return new NotificationDelivery(db,{send,publicOrigin:'https://game.example',now:()=>time,...options});}};
}

test('subscription validation rejects arbitrary destinations and invalid crypto keys',()=>{
 const valid=subscription();assert.deepEqual(validateSubscription(valid),valid);
 for(const endpoint of ['http://fcm.googleapis.com/send','https://127.0.0.1/a','https://example.org/a','https://fcm.googleapis.com.evil.test/a','https://user@fcm.googleapis.com/a','https://fcm.googleapis.com:8443/a'])
  assert.throws(()=>validateSubscription({...valid,endpoint}),e=>e.code==='INVALID_SUBSCRIPTION');
 assert.throws(()=>validateSubscription({...valid,keys:{...valid.keys,p256dh:'A'.repeat(87)}}));
});
for(const backend of ['file','postgres'])test(`${backend}: ready alert is opt-in, durable and deduplicated across mutation retries and worker races`,async t=>{
 const f=await fixture(t,backend);const sub=subscription();
 await f.act('notifications',f.host,{subscription:sub});const guest=await f.join();
 const data=await f.db.read(f.host.code),person=data.room.seats.WHITE.participant_id;
 assert.equal(data.notifications.jobs[person].kind,'READY');
 assert.equal(Object.keys(data.notifications.jobs).length,1);
 const view=await f.service.view(f.host.code,f.host.token);assert.equal(view.viewer.notifications_enabled,true);
 assert.doesNotMatch(JSON.stringify(view),/fcm\/send|p256dh|token_hash/);
 assert.equal((await f.service.view(f.host.code,guest.token)).viewer.notifications_enabled,false);
 f.restart();const calls=[];const send=async(sub,payload)=>calls.push(JSON.parse(payload));
 await Promise.all([f.delivery(send).process(),f.delivery(send).process()]);await f.delivery(send).process();
 assert.equal(calls.length,1);assert.equal(calls[0].url,`https://game.example/?room=${f.host.code}`);
 assert.doesNotMatch(JSON.stringify(calls),/recovery|noble|court|token/i);
 await f.act('rename',f.host,{name:'Renamed Table'});await f.delivery(send).process();assert.equal(calls.length,1);
 await f.act('notifications',f.host,{subscription:null});assert.equal((await f.service.view(f.host.code,f.host.token)).viewer.notifications_enabled,false);
});
test('Random does not emit room-ready and opting in does not replay old opportunities',async t=>{
 const f=await fixture(t,'file','RANDOM');await f.act('notifications',f.host,{subscription:subscription()});await f.join();
 const data=await f.db.read(f.host.code);assert.ok(Object.values(data.notifications.jobs).every(j=>j.kind!=='READY'));
});
test('stale ready alerts are discarded, and refilling produces a distinct event',async t=>{
 const f=await fixture(t);await f.act('notifications',f.host,{subscription:subscription()});const guest=await f.join();
 const first=Object.values((await f.db.read(f.host.code)).notifications.jobs)[0].id;
 await f.act('leave',guest);const calls=[];await f.delivery(async(...args)=>calls.push(args)).process();assert.equal(calls.length,0);
 await f.join();const second=Object.values((await f.db.read(f.host.code)).notifications.jobs)[0].id;assert.notEqual(first,second);
});
test('recovery revokes the old browser subscription without exposing it to the new session',async t=>{
 const f=await fixture(t);await f.act('notifications',f.host,{subscription:subscription()});await f.join();
 const next=id();await f.service.mutate('recover',f.host.code,null,{recoveryCode:f.host.recoveryCode,token:next},id());
 const calls=[];await f.delivery(async(...args)=>calls.push(args)).process();assert.equal(calls.length,0);
 assert.equal((await f.service.view(f.host.code,next)).viewer.notifications_enabled,false);
 assert.equal(Object.keys((await f.db.read(f.host.code)).notifications.subscriptions).length,0);
});
test('temporary push failure retries independently; lost successful acknowledgement keeps the same notification id',async t=>{
 const f=await fixture(t);await f.act('notifications',f.host,{subscription:subscription()});await f.join();
 const calls=[];let fail=true;
 const send=async(sub,payload)=>{calls.push(JSON.parse(payload));if(fail)throw Error('push unavailable');};
 assert.equal(await f.delivery(send).process(),true);await f.delivery(send).process();assert.equal(calls.length,1);
 f.advance(3000);fail=false;
 const original=f.db.transact.bind(f.db);let failAck=true;
 f.db.transact=async(code,fn)=>original(code,async current=>{const change=await fn(current);if(failAck && Object.values(change.write?.notifications?.jobs??{}).some(j=>j.status==='sent')){failAck=false;throw Error('save failed');}return change;});
 assert.equal(await f.delivery(send).process(),true);f.db.transact=original;
 f.advance(61000);f.restart();await f.delivery(send).process();
 assert.equal(calls.length,3);assert.equal(new Set(calls.map(c=>c.id)).size,1);
 await f.delivery(send).process();assert.equal(calls.length,3);
});
test('gone endpoints are removed and a foreground observation suppresses an alert permanently',async t=>{
 const f=await fixture(t);await f.act('notifications',f.host,{subscription:subscription()});const guest=await f.join();
 await f.delivery(async()=>{throw {statusCode:410};}).process();assert.equal((await f.service.view(f.host.code,f.host.token)).viewer.notifications_enabled,false);
 await f.act('leave',guest);await f.act('notifications',f.host,{subscription:subscription()});await f.join();
 await f.service.view(f.host.code,f.host.token,null,true);
 let sends=0;const worker=f.delivery(async()=>sends++,{isPresent:(...args)=>f.service.notificationPresent(...args)});
 await worker.process();f.advance(60000);await worker.process();assert.equal(sends,0);
});
test('decision triggers follow published turns and targeted responses, never arbitrary draft actions',async t=>{
 const f=await fixture(t);await f.join();const stored=await f.db.read(f.host.code),room=stored.room;
 room.status='ACTIVE';room.committed_state=setUpMatch('notifications');forcePhase(room.committed_state,PHASE.BUILD);
 const person=room.seats.WHITE.participant_id;const initial=notificationOpportunities(room);
 assert.equal(initial[person].kind,'TURN');
 room.draft_state=structuredClone(room.committed_state);room.draft_state.current_actor='BLACK';
 assert.deepEqual(notificationOpportunities(room),initial);
 room.draft_state.pending_combat={noble_id:'secret-id',victor:'BLACK'};
 assert.equal(notificationOpportunities(room)[room.seats.BLACK.participant_id].kind,'QUARTER');
 room.draft_state=null;
 for(const [field,value,kind] of [['pending_conquest',{defeated_king_id:'king'},'CONQUEST'],['active_ransom',{noble_id:'noble',stage:'OWNER'},'RANSOM']]){
  room.committed_state[field]=value;assert.equal(notificationOpportunities(room)[person].kind,kind);room.committed_state[field]=null;
 }
 room.committed_state.pending_resignation={started_at:'now',survivors:['WHITE','BLACK']};assert.equal(Object.values(notificationOpportunities(room)).filter(v=>v.kind==='VOTE').length,2);
 room.status='ABANDONED';room.ended_at='now';assert.equal(Object.values(notificationOpportunities(room)).filter(v=>v.kind==='ENDED').length,2);
 const payload=notificationPayload(room,person,{id:'id',kind:'ENDED'},'https://game.example');assert.doesNotMatch(JSON.stringify(payload),/secret-id|noble|court/i);
});

test('lost join acknowledgement creates one alert; later terminal alerts include all opted-in participants and exclude exports',async t=>{
 const f=await fixture(t);await f.act('notifications',f.host,{subscription:subscription()});
 const body={playerName:'Guest',seat:'BLACK',credentials:creds()},request=id(),original=f.db.transact.bind(f.db);
 let lose=true;f.db.transact=async(...args)=>{const result=await original(...args);if(lose){lose=false;throw Error('lost ack');}return result;};
 await assert.rejects(()=>f.service.mutate('join',f.host.code,null,body,request),e=>e.code==='SAVE_UNAVAILABLE');
 f.db.transact=original;const before=await f.db.read(f.host.code);f.restart();
 const guest=await f.service.mutate('join',f.host.code,null,body,request);assert.deepEqual((await f.db.read(f.host.code)).notifications,before.notifications);
 await f.act('notifications',guest,{subscription:subscription()});await f.act('start',f.host);await f.act('abandon',f.host,{confirmed:true});
 const calls=[];await f.delivery(async(sub,payload)=>calls.push(JSON.parse(payload))).process();
 assert.equal(calls.length,2);assert.ok(calls.every(p=>p.body==='This game was closed as unfinished.'));
 const exported=await f.service.export(f.host.code,guest.token);assert.equal(exported.notifications,undefined);assert.doesNotMatch(JSON.stringify(exported),/p256dh|fcm.googleapis|subscription_id/);
 const admin=await f.service.admin(f.host.code,'inspect');assert.equal(admin.notifications.subscribers,2);assert.doesNotMatch(JSON.stringify(admin.notifications),/p256dh|fcm.googleapis/);
});

test('configuration is disabled by default and malformed origins fail before a delivery can start',async()=>{
 const {pushConfiguration}=await import('../src/web-push.js');
 assert.deepEqual(pushConfiguration({}),{enabled:false});
 assert.throws(()=>pushConfiguration({DENDARV_PUBLIC_ORIGIN:'http://localhost',DENDARV_VAPID_PUBLIC_KEY:'x',DENDARV_VAPID_PRIVATE_KEY:'y',DENDARV_VAPID_SUBJECT:'mailto:admin@example.org'}),/HTTPS/);
});
