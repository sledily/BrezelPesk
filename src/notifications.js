import { createHash, randomBytes, ECDH } from 'node:crypto';
import { RoomError } from './rooms.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new RoomError('INVALID_SUBSCRIPTION',message,400); };
// Restrict browser-supplied destinations to known public push services. Never
// turn a subscription into an arbitrary server-side HTTP request.
export function validateSubscription(value) {
  let url;
  try { url=new URL(value?.endpoint); } catch { fail('The browser returned an invalid push endpoint.'); }
  const host=url.hostname;
  const allowed=host==='fcm.googleapis.com' || host==='updates.push.services.mozilla.com'
    || host==='web.push.apple.com' || host.endsWith('.notify.windows.com');
  if(url.protocol!=='https:' || url.port || url.username || url.password || url.hash || !allowed || url.href.length>2048)
    fail('This browser push service is not supported.');
  const {p256dh,auth}=value.keys??{};
  const validKey=(v,length)=>typeof v==='string' && /^[A-Za-z0-9_-]+={0,2}$/.test(v) && Buffer.from(v,'base64url').length===length;
  if(!validKey(p256dh,65) || !validKey(auth,16)) fail('The browser returned invalid push keys.');
  try { ECDH.convertKey(Buffer.from(p256dh,'base64url'),'prime256v1'); } catch { fail('The browser returned an invalid encryption key.'); }
  return {endpoint:url.href,keys:{p256dh,auth}};
}

export function notificationOpportunities(room) {
  const result={};
  const add=(seat,key,kind)=>{const person=room.seats[seat];if(person) result[person.participant_id]={key,kind,seat};};
  if(['COMPLETE','ABANDONED'].includes(room.status)) {
    for(const seat of room.seat_order) add(seat,`end:${room.status}:${room.ended_at}`,'ENDED');
  } else if(room.status==='LOBBY') {
    if(room.seating_mode!=='RANDOM' && room.seat_order.every(s=>room.seats[s])) add(room.host_seat,`ready:${room.ready_sequence??0}`,'READY');
  } else if(room.status==='ACTIVE') {
    const published=room.committed_state;
    // Only the entitled responder gets an alert for a private required choice.
    // Ordinary draft actions never grant the next player's published period.
    const s=room.draft_state?.pending_combat || room.draft_state?.pending_conquest ? room.draft_state : published;
    if(s.pending_resignation) {
      for(const seat of s.pending_resignation.survivors) add(seat,`ballot:${s.pending_resignation.started_at}`,'VOTE');
    } else if(s.pending_conquest) add(s.current_actor,`conquest:${s.pending_conquest.defeated_king_id}`,'CONQUEST');
    else if(s.pending_combat) add(s.current_actor,`quarter:${s.pending_combat.defeated_unit_id??s.pending_combat.noble_id}:${s.event_log.filter(e=>e.type==='CombatResolved').at(-1)?.sequence}`,'QUARTER');
    else if(s.active_ransom) add(s.current_actor,`ransom:${s.year_number}:${s.active_ransom.noble_id}:${s.active_ransom.stage}`,'RANSOM');
    else if(!s.players[s.current_actor]?.eliminated) add(s.current_actor,`turn:${s.year_number}:${s.phase}:${s.current_actor}:${s.phase==='HARVEST'?s.harvest?.stage:''}`,'TURN');
  }
  return result;
}

export function setSubscription(data, seat, tokenHash, subscription) {
  const person=data.room.seats[seat];
  data.notifications??={subscriptions:{},jobs:{},sequence:0};
  const n=data.notifications;
  if(subscription===null) {delete n.subscriptions[person.participant_id];delete n.jobs[person.participant_id];return;}
  const clean=validateSubscription(subscription);
  const old=n.subscriptions[person.participant_id];
  const id=hash([tokenHash,clean]);
  n.subscriptions[person.participant_id]={id,token_hash:tokenHash,subscription:clean};
  if(old?.id!==id) delete n.jobs[person.participant_id];
}

export function syncNotifications(before, data, now) {
  const n=data.notifications;
  if(!n) return;
  const previous=before?notificationOpportunities(before):{}, current=notificationOpportunities(data.room);
  const people=Object.fromEntries(Object.values(data.room.seats).filter(Boolean).map(p=>[p.participant_id,p]));
  for(const [person,sub] of Object.entries(n.subscriptions)) {
    if(people[person]?.token_hash!==sub.token_hash || data.room.status==='CANCELLED') {
      delete n.subscriptions[person];delete n.jobs[person];continue;
    }
    const opportunity=current[person];
    if(n.jobs[person] && n.jobs[person].key!==opportunity?.key) delete n.jobs[person];
    if(!opportunity || previous[person]?.key===opportunity.key) continue;
    const sequence=++n.sequence;
    n.jobs[person]={...opportunity,id:hash([data.room.code,person,sequence]),subscription_id:sub.id,
      created_at:now,status:'pending',attempts:0,next_attempt:now,lease_until:0};
  }
}

export function notificationPayload(room, person, job, publicOrigin) {
  const body={TURN:'It is your turn.',RANSOM:'A Ransom decision is waiting for you.',QUARTER:'A Quarter decision is waiting for you.',
    CONQUEST:'Choose the Conquest reward.',VOTE:'A resignation-spoils vote is waiting for you.',READY:'Everyone has joined. You can start the game.',
    ENDED:room.status==='ABANDONED'?'This game was closed as unfinished.':'This game has ended.'}[job.kind];
  return {id:job.id,code:room.code,title:room.name??`Game ${room.code}`,body,
    tag:`dendarv-${room.code}-${person}`,url:new URL(`/?room=${room.code}`,publicOrigin).href};
}

export class NotificationDelivery {
  constructor(storage,{send,publicOrigin,now=()=>Date.now(),isPresent=()=>false}={}) {
    this.storage=storage;this.send=send;this.publicOrigin=publicOrigin;this.now=now;this.isPresent=isPresent;
  }
  async process() {
    if(!this.send) return false;
    let pending=false;
    for(const {code} of await this.storage.inventory()) {
      let snapshot;
      try {snapshot=await this.storage.read(code);}catch{pending=true;continue;}
      for(const person of Object.keys(snapshot?.notifications?.jobs??{})) {
        try {
          const claim=await this.storage.transact(code,async stored=>{
            const data=structuredClone(stored), n=data?.notifications, job=n?.jobs[person], sub=n?.subscriptions[person];
            if(!job || job.status!=='pending') return {result:null};
            const owner=Object.values(data.room.seats).find(p=>p?.participant_id===person);
            if(!sub || sub.id!==job.subscription_id || owner?.token_hash!==sub.token_hash
              || notificationOpportunities(data.room)[person]?.key!==job.key
              || this.now()-job.created_at>30*86400000) {
              delete n.jobs[person];return {write:data,result:null};
            }
            // A foreground browser already saw the opportunity; no reminder later.
            if(this.isPresent(code,person,sub.token_hash)) {job.status='seen';return {write:data,result:null};}
            if(job.next_attempt>this.now() || job.lease_until>this.now()) {pending=true;return {result:null};}
            job.lease=randomBytes(16).toString('hex');job.lease_until=this.now()+60000;
            return {write:data,result:{subscription:sub.subscription,job:structuredClone(job),payload:notificationPayload(data.room,person,job,this.publicOrigin)}};
          });
          if(!claim) continue;
          let status='sent';
          try { await this.send(claim.subscription,JSON.stringify(claim.payload),claim.job.id); }
          catch(error) {status=[404,410].includes(error.statusCode)?'expired':'retry';}
          await this.storage.transact(code,async stored=>{
            const data=structuredClone(stored),n=data?.notifications,job=n?.jobs[person];
            if(!job || job.id!==claim.job.id || job.lease!==claim.job.lease) return {result:null};
            if(status==='expired') {delete n.subscriptions[person];delete n.jobs[person];}
            else if(status==='sent') {job.status='sent';job.sent_at=this.now();job.lease_until=0;}
            else {pending=true;job.attempts++;job.lease_until=0;job.next_attempt=this.now()+Math.min(3600000,1000*2**Math.min(job.attempts,12));}
            return {write:data,result:null};
          });
        } catch {pending=true;}
      }
    }
    return pending;
  }
}
