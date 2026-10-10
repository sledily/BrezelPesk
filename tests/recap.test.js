import test from 'node:test';
import assert from 'node:assert/strict';
import {recordEvent} from '../src/model.js';
import {projectForPlayer,projectSpectator} from '../src/projection.js';
import {reconnectRecap,lastPersonalTurn,phaseTransition,recapStepHTML,RecapPresenter} from '../src/recap.js';
import {setUpMatch,forcePhase,PHASE} from './helpers.js';
import {V2_RULES} from '../src/constants.js';
import {newMatch,dispatch} from '../src/engine.js';

function history(playerCount=2) {
  let s;
  if(playerCount===2)s=setUpMatch('recap-history',V2_RULES);
  else {s=newMatch({seed:'recap-four',playerCount,rules:V2_RULES});while(s.status==='SETUP'){const result=dispatch(s,{type:'CHOOSE_SOVEREIGN',player:s.current_actor,noble_id:s.sovereign_pool_ids[0]});assert.equal(result.ok,true,JSON.stringify(result.error));s=result.state;}}
  forcePhase(s,PHASE.MOBILIZE);
  s.event_log=[];s.event_sequence=0;
  recordEvent(s,'ActorPassed',{player:'WHITE',phase:PHASE.MOBILIZE,automatic:false});s.current_actor='BLACK';
  recordEvent(s,'ResourceCardsTapped',{player:'BLACK',card_ids:[],suit:'SPADES',value:9});
  recordEvent(s,'UnitMobilized',{player:'BLACK',unit_id:'U-B-001',origin:'h8',destination:'f6',cost:4});
  recordEvent(s,'UnitMobilized',{player:'BLACK',unit_id:'U-B-001',origin:'f6',destination:'e5',cost:4});
  recordEvent(s,'ActorPassed',{player:'BLACK',phase:PHASE.MOBILIZE,automatic:false});return s;
}
function clock() {
  let at=0,id=0;const jobs=new Map();
  return {now:()=>at,setTimer:(fn,ms)=>{jobs.set(++id,{fn,at:at+ms});return id;},clearTimer:id=>jobs.delete(id),pending:()=>jobs.size,
    advance:ms=>{const end=at+ms;while(true){const due=[...jobs.entries()].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;at=due[1].at;jobs.delete(due[0]);due[1].fn();}at=end;}};
}
function addBattle(s,id) {
  const attacker={unit_id:id+'-A',owner:'BLACK',unit_type:'QUEEN',square:'d4',vassal_noble_id:'NC-J-D'},defender={unit_id:id+'-D',owner:'WHITE',unit_type:'BISHOP',square:'e5',vassal_noble_id:'NC-K-S'};
  return recordEvent(s,'CombatResolved',{attacker_id:attacker.unit_id,defender_id:defender.unit_id,
    attacker_snapshot:{unit:attacker,noble:{face:'JACK',suit:'DIAMONDS',rank:1,noble_id:'NC-J-D'}},defender_snapshot:{unit:defender,noble:{face:'KING',suit:'SPADES',rank:3,noble_id:'NC-K-S'}},
    attacker_rolls:[6,3,2],defender_rolls:[4,1],attacker_high:6,defender_high:4,attacker_bonus:1,defender_bonus:3,attacker_total:7,defender_total:7,cost:4,outcome:'TIE'});
}

test('reconnect retains EVERY intervening action chronologically, without a browser-local cursor',()=>{
  const s=history(),view=projectForPlayer(s,'WHITE'),before=JSON.stringify(s),recap=reconnectRecap(view,'WHITE');
  assert.deepEqual(recap.steps.map(x=>x.kind),['payment','move','move','pass']);
  assert.deepEqual(recap.steps.filter(x=>x.kind==='move').map(x=>[x.origin,x.destination]),[['h8','f6'],['f6','e5']]);
  assert.deepEqual(reconnectRecap(structuredClone(view),'WHITE'),recap);
  assert.equal(reconnectRecap(projectForPlayer(s,'BLACK'),'BLACK').steps.length,0);
  assert.equal(JSON.stringify(s),before);
});
test('automatic opportunities and queued Auto Stockpile never erase the returning player’s missed history',()=>{
  const s=history(),last=lastPersonalTurn(s,'WHITE');
  recordEvent(s,'PhaseAutomaticallyPassed',{player:'WHITE',section:'SIEGE',reason:'No adjacent target.'});
  recordEvent(s,'ActorPassed',{player:'WHITE',phase:'SIEGE',automatic:true});
  recordEvent(s,'ResourceStockpileCommitted',{player:'WHITE',kept_card_ids:[],discarded_card_ids:[],automatic:true});
  assert.equal(lastPersonalTurn(s,'WHITE').event_id,last.event_id);
  assert.equal(reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps.filter(x=>x.kind==='move').length,2);
  recordEvent(s,'ResourceStockpileCommitted',{player:'WHITE',kept_card_ids:[],discarded_card_ids:[],automatic:false});
  assert.equal(reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps.length,0);
});
test('legacy skipped opportunities preserve the anchor and personal Harvest completion is a turn boundary',()=>{
  const s=history(),anchor=lastPersonalTurn(s,'WHITE');
  recordEvent(s,'PhaseAutomaticallyPassed',{player:'WHITE',section:'UPGRADE',reason:'No Upgrade.'});recordEvent(s,'ActorPassed',{player:'WHITE',phase:'UPGRADE'});
  assert.equal(lastPersonalTurn(s,'WHITE').event_id,anchor.event_id);
  const completion=recordEvent(s,'PokerDeclarationsFinished',{player:'WHITE',automatic:true});assert.equal(lastPersonalTurn(s,'WHITE').event_id,completion.event_id);
});
test('all intervening battles use their recorded rolls, totals and original combatants',()=>{
  const s=history();addBattle(s,'one');addBattle(s,'two');const before=JSON.stringify(s);
  const battles=reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps.filter(x=>x.kind==='combat');assert.equal(battles.length,2);
  for(const step of battles){assert.deepEqual(step.combat.attacker.rolls,[6,3,2]);assert.equal(step.combat.attacker.total,7);assert.equal(step.combat.defender.total,7);assert.equal(step.combat.victory,null);assert.match(recapStepHTML(step,{combatStage:'bonus'}),/Highest 6/);}
  assert.equal(JSON.stringify(s),before);
});
test('later resignation does not turn an earlier battle into a final victory',()=>{
  const s=history();addBattle(s,'ordinary');recordEvent(s,'MatchCompleted',{winner:'WHITE',reason:'RESIGNATION',resigned_player:'BLACK'});s.status='COMPLETE';s.winner='WHITE';
  const steps=reconnectRecap(projectForPlayer(s,'WHITE',{revealComplete:false}),'WHITE').steps;
  assert.equal(steps.find(x=>x.kind==='combat').combat.victory,null);assert.equal(steps.at(-1).heading,'White wins');
});
test('hidden recruitment is explained without exposing Court identities, seeds, RNG or private plans',()=>{
  const s=history();recordEvent(s,'NobleRecruited',{player:'BLACK',noble_id:'NC-Q-H',cost:8},'BLACK');recordEvent(s,'StockpileInstructionsSaved',{player:'BLACK',instructions:{secret:'DO_NOT_EXPOSE'}},'BLACK');
  const serialized=JSON.stringify(reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE'));
  assert.match(serialized,/Black recruited a Noble/);assert.match(serialized,/remains private/);assert.doesNotMatch(serialized,/NC-Q-H|INNOCENT|DO_NOT_EXPOSE|rng_state|seed|noble_order/);
  assert.equal(reconnectRecap(projectSpectator(s),null).steps.length,0);
});
test('four-player Court spoils show counts without another player’s captured identities',()=>{
  const s=history(4);recordEvent(s,'DefeatedCourtClaimed',{defeated_player:'GREEN',victor:'BLACK',captured_ids:['NC-Q-H'],captured_count:1,returned_count:1});
  const recap=reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE');assert.match(recap.steps.at(-1).text,/1 face-down Nobles claimed/);assert.doesNotMatch(JSON.stringify(recap),/NC-Q-H/);
});
test('defeat and resignation cleanup are retained in order while private Noble returns expose only counts',()=>{
  const s=history(4);
  recordEvent(s,'DefeatedCourtDispersed',{defeated_player:'GREEN',noble_ids:['NC-Q-H-A']});
  recordEvent(s,'DefeatedPlayersHostagesKilled',{defeated_player:'GREEN',noble_ids:['NC-K-S-A']});
  recordEvent(s,'DefeatedVassalsKilled',{defeated_player:'GREEN',noble_ids:['NC-J-D-A']});
  recordEvent(s,'ResignedNoblesReturned',{player:'RED',noble_ids:['NC-Q-H-B','NC-J-D-B']});
  const steps=reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps.slice(-4);
  assert.deepEqual(steps.map(x=>x.heading),['Green’s remaining Court returned','Green’s Hostages returned','Green’s Vassals returned','Red’s Nobles returned']);
  assert.match(steps[0].text,/1 face-down Nobles/);assert.match(steps[3].text,/2 Nobles/);
  assert.doesNotMatch(JSON.stringify(steps),/NC-Q-H-A|NC-Q-H-B|NC-J-D-B/);
});
test('phase, season, Year and personal Poker transitions teach the actual destination',()=>{
  const s=history(),previous={status:'ACTIVE',phase:'MOBILIZE',year:s.year_number,harvestStage:null};s.phase='SIEGE';assert.equal(phaseTransition(previous,s).heading,'Siege begins');
  s.phase='VASSALIZE';assert.equal(phaseTransition(previous,s).heading,'Fall begins');s.phase='HARVEST';s.harvest={stage:'POKER'};
  const poker=phaseTransition({...previous,phase:'HARVEST',harvestStage:'DRAW'},s);assert.equal(poker.phase,'POKER');assert.match(poker.lesson,/non-overlapping/);
  s.year_number++;const year=phaseTransition(previous,s);assert.match(year.heading,/Year/);assert.match(year.initiative,/Button/);
  assert.equal(phaseTransition({status:s.status,phase:s.phase,year:s.year_number,harvestStage:'POKER'},s),null);
});
test('an earlier move retains its earlier piece type after a subsequent Upgrade',()=>{
  const s=history();s.units_by_id['U-B-001'].unit_type='QUEEN';recordEvent(s,'UnitUpgraded',{player:'BLACK',unit_id:'U-B-001',from_type:'KING',to_type:'QUEEN',cost:12});
  assert.equal(reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps.find(x=>x.kind==='move').unit.unit_type,'KING');
});
test('pause, backwards navigation, skip and late timers cannot change a saved game',()=>{
  const s=history(),before=JSON.stringify(s),steps=reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps,c=clock();let finished=0;
  const p=new RecapPresenter({...c,render:()=>{},onComplete:()=>finished++});p.show(steps);c.advance(1000);p.pause();assert.equal(c.pending(),0);c.advance(20000);assert.equal(p.index,0);
  p.resume();c.advance(steps[0].duration-1000);assert.equal(p.index,1);p.back();assert.equal(p.index,0);p.finish();assert.equal(c.pending(),0);assert.equal(finished,1);c.advance(20000);assert.equal(finished,1);assert.equal(JSON.stringify(s),before);
});
test('reduced motion keeps every explanation statically without an artificial wait',()=>{
  const s=history();addBattle(s,'static');const c=clock(),renders=[];const p=new RecapPresenter({...c,render:(step,position)=>renders.push(position)});
  p.show(reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE').steps,{reducedMotion:true});assert.equal(c.pending(),0);assert.equal(renders.at(-1).combatStage,'complete');while(p.busy)p.next();assert.equal(renders.length,5);
});
test('newly published actions join a playing recap exactly once',()=>{
  const s=history(),recap=reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE'),c=clock();let painted=0;
  const p=new RecapPresenter({...c,render:()=>painted++});p.show(recap.steps);p.append(recap.steps);assert.equal(painted,1);
  recordEvent(s,'ActorPassed',{player:'GREEN',phase:'SIEGE',automatic:false});const extra=reconnectRecap(projectForPlayer(s,'WHITE'),'WHITE',{afterSequence:recap.through});p.append(extra.steps);p.append(extra.steps);assert.equal(p.steps.length,5);assert.equal(p.index,0);
});
