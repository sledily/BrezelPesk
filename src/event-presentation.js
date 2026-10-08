import { escapeMarkup, pieceIcon } from './presentation.js';
import { title } from './format.js';
import { NOBLE_DISPLAY_CODE, SUIT_GLYPH } from './constants.js';

// Approved D82 beats; timers affect local presentation only, never the game engine.
export const COMBAT_BEATS = Object.freeze([
  {at:0,stage:'opening'}, {at:1000,stage:'rolling'}, {at:3800,stage:'raw'},
  {at:5400,stage:'highest'}, {at:6800,stage:'bonus'}, {at:8200,stage:'impact'},
  {at:8700,stage:'result'},
]);
export const COMBAT_DURATION = 11100;
export const KING_COMBAT_DURATION = 11900;

function visibleSnapshot(state) {
  const cards={};
  for(const player of Object.values(state.players))for(const id of player.resource_hand_ids) {
    const card=state.resources_by_id[id];if(card && !card.hidden)cards[id]={tapped:card.tapped,counter:card.has_counter};
  }
  const units=Object.fromEntries(Object.entries(state.units_by_id).map(([id,u])=>[id,{...u}]));
  // Only assigned, public Nobles are needed. Never retain a private Court for motion.
  const nobles={};for(const unit of Object.values(units)) {
    const noble=state.nobles_by_id[unit.vassal_noble_id];if(noble && !noble.hidden)nobles[noble.noble_id]={...noble};
  }
  return {units,nobles,cards,sequence:state.event_log.reduce((n,e)=>Math.max(n,e.sequence),0),actor:state.current_actor,phase:state.phase,year:state.year_number,offer:state.harvest?.offer_ids?.length?JSON.stringify([state.harvest.unit_id,state.harvest.offer_ids]):null};
}
export function combatFromEvent(event,state,old=visibleSnapshot(state),next=visibleSnapshot(state),battleCount=1) {
  if(!event || event.payload.hidden)return null;
  const p=event.payload;
  const describe=(id,side)=>{
    const snapshot=p[`${side}_snapshot`],unit=snapshot?.unit ?? old.units[id] ?? next.units[id];
    const noble=snapshot?.noble ?? old.nobles[unit?.vassal_noble_id] ?? next.nobles[unit?.vassal_noble_id];
    return unit?{unit:{...unit},noble:noble?{...noble}:null,rolls:[...p[`${side}_rolls`]],
      high:p[`${side}_high`],bonus:p[`${side}_bonus`],total:p[`${side}_total`]}:null;
  };
  const attacker=describe(p.attacker_id,'attacker'),defender=describe(p.defender_id,'defender');
  if(!attacker || !defender)return null;
  const defeated=p.outcome==='TIE'?null:p.outcome==='ATTACKER_WIN'?defender:attacker;
  return {eventId:event.event_id,attacker,defender,outcome:p.outcome,cost:p.cost,
    kingFall:defeated?.unit.unit_type==='KING',victory:state.status==='COMPLETE'?state.winner:null,battleCount};
}
export class PresentationTracker {
  constructor(){this.reset();}
  reset(){this.scope=null;this.previous=null;this.seen=new Set();}
  read(state,scope) {
    const next=visibleSnapshot(state),old=this.previous;
    if(this.scope!==scope || !old){
      this.scope=scope;this.previous=next;this.seen=new Set(state.event_log.filter(e=>e.type==='CombatResolved').map(e=>JSON.stringify([e.event_id,e.payload])));
      const pending=state.pending_combat || state.pending_conquest || state.status==='COMPLETE' && ['KING_DEFEATED','LAST_KING_STANDING'].includes(state.victory_reason);
      const restored=pending?combatFromEvent(state.event_log.findLast(e=>e.type==='CombatResolved'),state):null;
      return {baseline:true,combat:null,restored,changes:[],events:[]};
    }
    const events=state.event_log.filter(e=>e.sequence>old.sequence);
    const freshBattle=e=>!this.seen.has(JSON.stringify([e.event_id,e.payload]));
    // Undo can rewind the log. Do not replay a previously seen dice outcome on retry.
    const battles=events.filter(e=>e.type==='CombatResolved' && freshBattle(e));
    for(const event of battles)this.seen.add(JSON.stringify([event.event_id,event.payload]));
    const combat=combatFromEvent(battles.at(-1),state,old,next,battles.length);
    const changes=[];
    for(const [id,unit] of Object.entries(next.units)) {
      const previous=old.units[id];
      if(unit.defeated || !unit.square)continue;
      if(!previous || previous.square!==unit.square || previous.unit_type!==unit.unit_type || previous.vassal_noble_id!==unit.vassal_noble_id)changes.push({kind:'unit',id,square:unit.square});
    }
    for(const [id,card] of Object.entries(next.cards)) {
      const previous=old.cards[id];
      if(!previous || previous.tapped!==card.tapped || previous.counter!==card.counter)changes.push({kind:'card',id});
    }
    this.previous=next;
    return {baseline:false,combat,changes,events,offerChanged:next.offer!==null && old.offer!==next.offer,actionChanged:old.actor!==next.actor || old.phase!==next.phase || old.year!==next.year};
  }
}

export function combatConsequence(state,combat) {
  if(state.status==='COMPLETE')return `${title(state.winner)} wins. The terminal board and full game record remain available.`;
  if(state.pending_conquest)return 'The King has fallen. Resource spoils and other-Unit cleanup have resolved. The victor now chooses Card or Holding.';
  if(state.pending_combat)return `${title(state.pending_combat.victor)} must choose Quarter or No Quarter. The final comparison remains here during the decision.`;
  if(combat.outcome==='TIE')return 'Tie. Both Units stay in place; the attacker has paid the Siege cost.';
  const defeated=combat.outcome==='ATTACKER_WIN'?combat.defender:combat.attacker;
  const noble=defeated.noble?.noble_id;
  const pieceFate=defeated.unit.irreplaceable?'The captured piece is removed permanently.':'The defeated piece returns to its reserve.';
  if(noble && Object.values(state.players).some(p=>p.dungeon_noble_id===noble))return `The defeated Noble is in the victor’s Dungeon. ${pieceFate}`;
  if(noble && state.nobles_by_id[noble]?.location==='NOBLE_DECK')return `The defeated Noble was returned to the Noble deck. ${pieceFate}`;
  if(!noble)return pieceFate;
  return combat.kingFall?'King defeat resolved. Review the Chronicle for the full consequences.':`${pieceFate} The Chronicle records the Noble’s disposition.`;
}

const pipPositions={1:[5],2:[1,9],3:[1,5,9],4:[1,3,7,9],5:[1,3,5,7,9],6:[1,3,4,6,7,9]};
function dieFace(value) {
  return `<span class="die-pips" aria-hidden="true">${Array.from({length:9},(_,i)=>`<i class="${pipPositions[value]?.includes(i+1)?'pip':'blank'}"></i>`).join('')}</span>`;
}
export function combatHTML(combat,stage,consequence='') {
  const stages=['opening','rolling','raw','highest','bonus','impact','result','complete'],index=stages.indexOf(stage);
  const raw=index>=2,highest=index>=3,bonus=index>=4,result=index>=5;
  const loser=combat.outcome==='TIE'?null:combat.outcome==='ATTACKER_WIN'?'defender':'attacker';
  const sideHTML=(side,role)=>{
    const u=side.unit,color=['WHITE','BLACK','RED','GREEN'].includes(u.owner)?u.owner.toLowerCase():'white';
    const kept=side.rolls.indexOf(side.high),fall=role===loser && combat.kingFall && result;
    return `<div class="combat-side ${color} ${role===loser && result?'combat-defeated':''}"><div class="combat-unit ${fall?'king-fallen':''}">${pieceIcon(u)}<div><strong>${title(u.owner)} · ${title(u.unit_type)}</strong><small>${role==='attacker'?'Attacker':'Defender'}${u.square?` · ${escapeMarkup(u.square)}`:''}</small>${side.noble?`<span class="combat-general">${NOBLE_DISPLAY_CODE[side.noble.face]}${SUIT_GLYPH[side.noble.suit]}</span>`:''}</div></div>
      <div class="combat-dice" aria-label="${title(u.owner)} dice">${side.rolls.map((value,i)=>`<span class="combat-die ${highest && i===kept?'retained':highest?'discarded':''}" style="--die-index:${i}" aria-label="${!raw?'Rolling':highest && i===kept && bonus?`Highest die ${side.high} plus ${side.bonus} equals ${side.total}`:`Die ${i+1}: ${value}`}">${bonus && i===kept?`<strong>${side.total}</strong>`:dieFace(raw?value:5)}</span>`).join('')}</div>
      <p class="combat-arithmetic" ${bonus?'':'hidden'}>Highest ${side.high} + <span class="combat-rank">${side.bonus?`${side.bonus} ${['','Vz','Dx','Rx'][side.bonus]} bonus`:'0 · no General'}</span> = <strong>${side.total}</strong></p></div>`;
  };
  const winner=combat.outcome==='TIE'?null:combat.outcome==='ATTACKER_WIN'?combat.attacker.unit.owner:combat.defender.unit.owner;
  const heading=!result?'Siege':combat.victory?`${title(combat.victory)} wins`:combat.outcome==='TIE'?'A stand-off':`${title(winner)} wins the battle`;
  const beat={opening:'The Levies face one another.',rolling:'Both players roll together.',raw:'Raw dice. Only the highest die counts.',highest:'Highest dice retained.',bonus:'Add each assigned General’s rank.',impact:combat.kingFall?'The King falls.':'The comparison resolves.',result:'Take a moment to absorb the result.',complete:consequence}[stage];
  return `<header><p class="eyebrow">${combat.kingFall?'Fall of a King':'Siege'} · ${combat.cost} ♤ paid${combat.battleCount>1?` · Latest of ${combat.battleCount} published battles`:''}</p><h2>${heading}</h2></header><div class="combat-contest">${sideHTML(combat.attacker,'attacker')}<span class="combat-versus" aria-hidden="true">${result?combat.attacker.total===combat.defender.total?'=':combat.attacker.total>combat.defender.total?'›':'‹':'×'}</span>${sideHTML(combat.defender,'defender')}</div><p class="combat-narration" role="status" aria-live="polite">${escapeMarkup(beat)}</p>${stage==='complete'?'<button id="dismiss-combat" class="button tiny quiet">Return to board</button>':'<button id="skip-combat" class="button tiny quiet">Show result now</button>'}`;
}

export class CombatPresenter {
  constructor({render,onComplete=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){this.render=render;this.onComplete=onComplete;this.setTimer=setTimer;this.clearTimer=clearTimer;this.timers=[];this.busy=false;this.model=null;this.stage=null;this.generation=0;}
  clear(){for(const timer of this.timers)this.clearTimer(timer);this.timers=[];this.busy=false;this.model=null;this.stage=null;this.generation++;}
  show(model,{reducedMotion=false}={}) {
    this.clear();this.model=model;this.busy=true;const generation=this.generation;
    const finish=()=>{if(generation!==this.generation)return;for(const t of this.timers)this.clearTimer(t);this.timers=[];this.busy=false;this.stage='complete';this.render(model,'complete');this.onComplete(model);};
    this.finish=finish;
    if(reducedMotion){finish();return;}
    this.stage='opening';this.render(model,'opening');
    for(const beat of COMBAT_BEATS.slice(1))this.timers.push(this.setTimer(()=>{if(generation===this.generation){this.stage=beat.stage;this.render(model,beat.stage);}},beat.at));
    this.timers.push(this.setTimer(finish,model.kingFall?KING_COMBAT_DURATION:COMBAT_DURATION));
  }
  skip(){if(this.busy)this.finish();}
}
