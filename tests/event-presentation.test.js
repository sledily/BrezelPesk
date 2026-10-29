import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PresentationTracker,CombatPresenter,combatHTML,COMBAT_BEATS,COMBAT_DURATION,KING_COMBAT_DURATION} from '../src/event-presentation.js';
import {dispatch} from '../src/engine.js';
import {PersistentRooms} from '../src/persistent-rooms.js';
import {FileRoomStorage} from '../src/room-storage.js';
import {projectSpectator} from '../src/projection.js';
import {setUpMatch,forcePhase,givePool,PHASE,SUIT} from './helpers.js';
function battle(seed='motion') {
  const state=setUpMatch(seed);forcePhase(state,PHASE.SIEGE);givePool(state,'WHITE',SUIT.SPADES,20);
  state.units_by_id['U-W-001'].square='d4';state.units_by_id['U-B-001'].square='e5';
  return state;
}
function resolve(state){const result=dispatch(state,{type:'LAY_SIEGE',player:'WHITE',attacker_id:'U-W-001',defender_id:'U-B-001'});assert.equal(result.ok,true,JSON.stringify(result.error));return result.state;}
function outcomeModel(outcome){
  for(let n=0;n<100;n++){const before=battle('motion-'+n),after=resolve(before),event=after.event_log.findLast(e=>e.type==='CombatResolved');if(event.payload.outcome===outcome){const tracker=new PresentationTracker();tracker.read(projectSpectator(before),'viewer');return {model:tracker.read(projectSpectator(after),'viewer').combat,before,after,event};}}
  throw new Error('No deterministic test fixture');
}
function clock() {
  let now=0,id=0;const timers=new Map();return {setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:key=>timers.delete(key),
    advance:ms=>{const end=now+ms;while(true){const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();}now=end;},pending:()=>timers.size};
}

test('combat motion uses exact stored rolls and public combatant snapshots, survives casualty cleanup and baseline reload',()=>{
  const {before,after,event,model}=outcomeModel('ATTACKER_WIN');
  assert.deepEqual(model.attacker.rolls,event.payload.attacker_rolls);assert.deepEqual(model.defender.rolls,event.payload.defender_rolls);
  assert.equal(model.defender.unit.square,'e5');assert.equal(model.defender.unit.vassal_noble_id,'NC-K-S');
  assert.equal(model.victory,'WHITE');assert.equal(model.kingFall,true);
  const tracker=new PresentationTracker(),reloaded=tracker.read(projectSpectator(after),'public');
  assert.equal(reloaded.combat,null);assert.deepEqual(reloaded.restored,model);
  assert.equal(tracker.read(projectSpectator(after),'public').combat,null);
  assert.equal(tracker.read(projectSpectator(after),'different-viewer').combat,null);
  assert.equal(tracker.read(projectSpectator(before),'different-viewer').combat,null);
  const retained=tracker.previous;assert.equal(Object.keys(retained.nobles).length,2,'only assigned public Nobles retained');
  assert.equal(retained.command_log,undefined);assert.equal(retained.seed,undefined);
});

test('ordinary Undo sequence reuse cannot suppress a fresh CombatResolved event',()=>{
  const before=battle('reuse'),tracker=new PresentationTracker();tracker.read(before,'same');
  const original=structuredClone(before),eventSequence=before.event_sequence+1;
  before.event_log.push({event_id:`EV-${String(eventSequence).padStart(6,'0')}`,sequence:eventSequence,type:'UnitMobilized',payload:{}});
  tracker.read(before,'same');tracker.read(original,'same');
  assert.ok(tracker.read(resolve(original),'same').combat);
});

test('publication controls combat presentation: an unpassed private Siege stays absent for an opponent',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dendarv-presentation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=new FileRoomStorage(dir);await db.init();const rooms=new PersistentRooms(db),id=()=>randomBytes(24).toString('hex');
  const host=await rooms.mutate('create',null,null,{playerCount:2,playerName:'White',credentials:{token:id(),recoveryCode:id()}},id());
  const black=await rooms.mutate('join',host.code,null,{playerName:'Black',seat:'BLACK',credentials:{token:id(),recoveryCode:id()}},id());
  await db.transact(host.code,data=>{data.room.status='ACTIVE';data.room.committed_state=battle('publish-tie');return {write:data};});
  // Choose a tie, keeping the public position unchanged until explicit Pass.
  let state;for(let n=0;n<100;n++){const s=battle('publish-'+n);if(resolve(s).event_log.findLast(e=>e.type==='CombatResolved').payload.outcome==='TIE'){state=s;break;}}
  assert.ok(state);await db.transact(host.code,data=>{data.room.committed_state=state;return {write:data};});
  const opponent=new PresentationTracker();opponent.read((await rooms.view(host.code,black.token)).game,'black');
  const ownBefore=await rooms.view(host.code,host.token),own=new PresentationTracker();own.read(ownBefore.game,'white');
  const response=await rooms.mutate('command',host.code,host.token,{expectedRevision:ownBefore.viewer.private_revision,command:{type:'LAY_SIEGE',attacker_id:'U-W-001',defender_id:'U-B-001'}},id());
  assert.ok(own.read(response.game,'white').combat);assert.equal(opponent.read((await rooms.view(host.code,black.token)).game,'black').combat,null);
  await rooms.mutate('pass',host.code,host.token,{expectedRevision:response.viewer.private_revision},id());
  const published=(await rooms.view(host.code,black.token)).game;assert.ok(opponent.read(published,'black').combat);
  assert.equal(opponent.read(published,'black').combat,null,'polls never replay a battle');
});

test('approved eleven-second timeline is local, skippable, reduced-motion aware and cancellable',()=>{
  const {model}=outcomeModel('TIE'),timer=clock(),renders=[],finished=[];
  const presenter=new CombatPresenter({...timer,render:(model,stage)=>renders.push(stage),onComplete:model=>finished.push(model.eventId)});
  presenter.show(model);assert.equal(presenter.busy,true);assert.deepEqual(renders,['opening']);
  for(let i=1;i<COMBAT_BEATS.length;i++){timer.advance(COMBAT_BEATS[i].at-COMBAT_BEATS[i-1].at);assert.equal(renders.at(-1),COMBAT_BEATS[i].stage);}
  timer.advance(COMBAT_DURATION-COMBAT_BEATS.at(-1).at);assert.equal(presenter.busy,false);assert.equal(renders.at(-1),'complete');assert.equal(finished.length,1);
  presenter.show(model);timer.advance(1000);presenter.skip();assert.equal(presenter.busy,false);assert.equal(timer.pending(),0);assert.equal(finished.length,2);
  presenter.show(model,{reducedMotion:true});assert.equal(timer.pending(),0);assert.equal(renders.at(-1),'complete');assert.equal(finished.length,3);
  presenter.show(model);presenter.clear();timer.advance(20000);assert.equal(finished.length,3);assert.equal(presenter.model,null);
  const king=outcomeModel('ATTACKER_WIN').model;presenter.show(king);timer.advance(COMBAT_DURATION);assert.equal(presenter.busy,true);timer.advance(KING_COMBAT_DURATION-COMBAT_DURATION);assert.equal(presenter.busy,false);
});

test('each combat beat exposes the correct arithmetic and consequence without false randomness',()=>{
  const {model}=outcomeModel('ATTACKER_WIN');
  assert.doesNotMatch(combatHTML(model,'opening'),/Highest die .* plus/);
  assert.match(combatHTML(model,'raw'),/Raw dice/);assert.match(combatHTML(model,'highest'),/Highest dice retained/);
  const bonus=combatHTML(model,'bonus');assert.match(bonus,new RegExp(`Highest ${model.attacker.high}.*${model.attacker.bonus} Rx bonus`));
  assert.match(combatHTML(model,'impact'),/White wins/);assert.match(combatHTML(model,'result'),/king-fallen/);
  assert.match(combatHTML(model,'complete','Choose Quarter.'),/Choose Quarter/);assert.match(combatHTML(model,'complete'),/Return to board/);
  assert.equal(model.attacker.total,model.attacker.high+model.attacker.bonus);assert.equal(model.defender.total,model.defender.high+model.defender.bonus);
});

test('routine cues respond to a changed visible hand or Unit, not redraws and selections',()=>{
  const state=battle('routine'),tracker=new PresentationTracker();tracker.read(state,'player');
  const next=structuredClone(state);next.units_by_id['U-W-001'].square='c3';
  assert.deepEqual(tracker.read(next,'player').changes,[{kind:'unit',id:'U-W-001',square:'c3'}]);
  assert.deepEqual(tracker.read(next,'player').changes,[]);
  assert.deepEqual(tracker.read(next,'other-seat').changes,[]);
});
