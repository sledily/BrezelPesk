import { ACTIVE_SUIT_BY_PHASE, SEASON_BY_PHASE, SUIT_GLYPH, NOBLE_DISPLAY_CODE, PHASE } from './constants.js';
import { title, formatResource } from './format.js';
import { escapeMarkup, pieceIcon, nobleCardHtml } from './presentation.js';
import { combatFromEvent, combatHTML, COMBAT_BEATS, COMBAT_DURATION, KING_COMBAT_DURATION } from './event-presentation.js';

const PHASE_LESSONS = Object.freeze({
  HARVEST: 'Each Unit draws Resources. Keep one card; a matching Vassal or a Center square adds one Counter.',
  POKER: 'Your Harvest is complete. Declare exact, non-overlapping groups now, or Pass. Declared cards must be spent or returned this Year.',
  BUILD: 'Spend Clubs to place a Pawn beside a suitable friendly General.',
  UPGRADE: 'Spend Clubs to raise a Holding’s Level. Your physical reserve limits the available pieces.',
  RANSOM: 'Diamonds can release a Hostage. The price depends on the Noble’s rank and the current Diamond constant.',
  RECRUIT: 'Spend Diamonds to draw a Noble into your private, face-down Court.',
  MOBILIZE: 'Only Levies move. Spend Spades using your Unit count plus the moving Unit’s Level.',
  SIEGE: 'An adjacent enemy can be attacked. The Spade cost uses the defender’s Unit count plus its Level.',
  VASSALIZE: 'Spend Hearts to assign a Court Noble to a Holding. The Holding becomes a Levy.',
  EXECUTE: 'Spend Hearts to Execute a Hostage. The Noble returns to the shuffled Noble deck.',
  STOCKPILE: 'Keep your legal Stockpile. Unspent Resources can survive; tapped and mandatory-return cards cannot.',
});

export function phaseLabel(phase) { return phase === 'POKER' ? 'Poker Hands' : title(phase); }
export function phaseLesson(phase) { return PHASE_LESSONS[phase] ?? 'Follow Current Action for the next decision.'; }
export function phaseTransition(before, state) {
  if (!before || state.status !== 'ACTIVE') return null;
  const nextPhase = state.phase === PHASE.HARVEST && state.harvest?.stage === 'POKER' ? 'POKER' : state.phase;
  const oldPhase = before.phase === PHASE.HARVEST && before.harvestStage === 'POKER' ? 'POKER' : before.phase;
  if (before.status === state.status && before.year === state.year_number && oldPhase === nextPhase) return null;
  const season = SEASON_BY_PHASE[state.phase], oldSeason = SEASON_BY_PHASE[before.phase];
  const newYear = before.year !== state.year_number;
  const order = (state.phase_actor_order ?? []).map(title).join(' → ');
  return { phase: nextPhase, season, suit: ACTIVE_SUIT_BY_PHASE[state.phase], year: state.year_number,
    previous: before.status === 'SETUP' ? 'Sovereigns chosen' : `${phaseLabel(oldPhase)} complete`,
    heading: newYear ? `Year ${state.year_number} begins` : season !== oldSeason ? `${title(season)} begins` : `${phaseLabel(nextPhase)} begins`,
    actor: state.current_actor, lesson: phaseLesson(nextPhase),
    initiative: newYear ? `${title(state.button_holder)} holds the Button. ${order ? `Action order: ${order}.` : ''}` : '' };
}

// These ornaments are drawn in code, following the suits' leaf, thorn,
// geometric and vine borders. They never alter or sample a Court portrait.
export function suitFrieze(suit) {
  const glyph = SUIT_GLYPH[suit] ?? '✦';
  const shapes = suit === 'DIAMONDS'
    ? Array.from({length: 11}, (_, i) => `<path d="M${i*30+10} 4l9 10-9 10-9-10Z"/>`).join('')
    : Array.from({length: 11}, (_, i) => `<path d="M${i*30+3} 14q8-15 20-11q-2 11-20 11q8 15 20 11q-2-11-20-11"/>`).join('');
  return `<div class="suit-frieze ${String(suit ?? 'HARVEST').toLowerCase()}" aria-hidden="true"><svg viewBox="0 0 330 28" preserveAspectRatio="none"><path class="frieze-stem" d="M0 14Q70 4 150 14T330 14"/>${shapes}</svg><span>${glyph}</span><svg viewBox="0 0 330 28" preserveAspectRatio="none"><path class="frieze-stem" d="M0 14Q70 4 150 14T330 14"/>${shapes}</svg></div>`;
}

export function phaseTransitionHTML(cue) {
  return `${suitFrieze(cue.suit)}<div class="phase-arrival"><span class="phase-seal" aria-hidden="true">${SUIT_GLYPH[cue.suit] ?? '✦'}</span><div><p class="eyebrow">${escapeMarkup(cue.previous)} · Year ${cue.year}</p><h2>${escapeMarkup(cue.heading)}</h2><p>${phaseLabel(cue.phase)} · ${title(cue.actor)} to act</p></div></div><p class="phase-lesson">${escapeMarkup(cue.lesson)}${cue.initiative ? ` <strong>${escapeMarkup(cue.initiative)}</strong>` : ''}</p>`;
}

const TURN_ENDS = new Set(['ActorPassed', 'PokerDeclarationsFinished', 'SovereignChosen', 'HostageRansomed', 'RansomDeclined']);
export function lastPersonalTurn(state, viewer) {
  let boundary = null;
  for (let i = 0; i < state.event_log.length; i++) {
    const e = state.event_log[i], p = e.payload;
    if (!p || p.hidden || p.automatic && e.type !== 'PokerDeclarationsFinished') continue;
    const who = p.player ?? p.buyer;
    const preceding = state.event_log[i-1];
    // Old saves lack the automatic flag. Never let a skipped opportunity
    // erase actions a person has not seen while away.
    if (e.type !== 'PokerDeclarationsFinished' && preceding?.type === 'PhaseAutomaticallyPassed' && preceding.payload.player === viewer) continue;
    if (who === viewer && (TURN_ENDS.has(e.type) || e.type === 'ResourceStockpileCommitted' && p.automatic === false)) boundary = e;
  }
  return boundary;
}

function unitAtEvent(state, event, id, owner) {
  const current = state.units_by_id[id];
  if (!current) return null;
  const unit = { ...current, owner: owner ?? current.owner };
  // Later upgrades must not make an earlier Pawn move look like a Queen move.
  for (let i = state.event_log.length-1; i >= 0; i--) {
    const e = state.event_log[i]; if (e.sequence <= event.sequence) break;
    if (!e.payload.hidden && e.type === 'UnitUpgraded' && e.payload.unit_id === id) unit.unit_type = e.payload.from_type;
  }
  return unit;
}
function nobleLabel(state, id) {
  const noble = state.nobles_by_id[id];
  return noble && !noble.hidden ? `${NOBLE_DISPLAY_CODE[noble.face]}${SUIT_GLYPH[noble.suit]}` : 'the Noble';
}
function cardModels(state, ids, counters = null) {
  return (ids ?? []).map(id => {
    const card = state.resources_by_id[id];
    if (!card || card.hidden) return null;
    return { card_id: id, suit: card.suit, face_value: card.face_value, has_counter: counters ?? false };
  }).filter(Boolean);
}
const INTERNAL = new Set(['MatchCreated', 'UsabilityRevisionApplied', 'StockpileInstructionsSaved', 'PhaseUnavailableAcknowledged', 'ButtonPassed', 'ConquestResolved']);

export function describePublishedAction(event, state) {
  if (!event.payload || INTERNAL.has(event.type)) return null;
  const p = event.payload, actor = p.player ?? p.buyer ?? p.victor ?? p.captor ?? event.actor;
  const who = title(actor), suit = ACTIVE_SUIT_BY_PHASE[event.phase];
  const base = { eventId: event.event_id, sequence: event.sequence, year: event.year, phase: event.phase,
    actor, suit, kind: 'notice', heading: '', text: '', cards: [], duration: 2600 };
  // Give the explanation time to be read after the illustration arrives.
  // Saved combat keeps its separately approved timing.
  const finish = (heading, text, extra = {}) => ({ ...base, heading, text,
    duration: Math.max(3600,Math.min(10000,1000+`${heading} ${text}`.split(/\s+/).length*185)), ...extra });
  if (p.hidden) {
    // Only the projection's public Chronicle wording is allowed here. Do not
    // look up an unrevealed identity from the current state's dictionaries.
    const publicText = p.chronicle?.text;
    if (!publicText) return null;
    return finish(event.type === 'NobleRecruited' ? `${who} recruited a Noble` : `${who} acted`,
      `${publicText} The unrevealed Court identity remains private.`, { kind: 'private' });
  }
  const unit = unitAtEvent(state, event, p.unit_id, actor);
  const piece = unit ? title(unit.unit_type) : 'Unit';
  const pay = Number.isFinite(p.cost) ? ` Paid ${p.cost} ${SUIT_GLYPH[suit] ?? ''} from the pool.` : '';
  switch (event.type) {
    case 'PhaseStarted': {
      const phase = p.phase ?? event.phase;
      return finish(`${title(SEASON_BY_PHASE[phase])} · ${phaseLabel(phase)}`, phaseLesson(phase),
        { kind: 'phase', suit: ACTIVE_SUIT_BY_PHASE[phase], order: (p.actor_order ?? []).map(title).join(' → ') });
    }
    case 'YearStarted': return finish(`Year ${p.year} begins`, `${title(p.button_holder)} holds the Button. Initiative follows this Year’s recorded action order.`, {kind:'phase'});
    case 'SetupCompleted': return finish('The Sovereigns are chosen', 'Year 1 begins with personal Harvest, followed immediately by each player’s Poker window.', {kind:'phase'});
    case 'PokerDeclarationsStarted': return finish(`${who} enters Poker`, phaseLesson('POKER'), {kind:'phase'});
    case 'ActorPassed': return p.automatic ? null : finish(`${who} passed ${phaseLabel(p.phase ?? event.phase)}`, 'Their accepted actions are published. The next eligible player or phase follows.', {kind:'pass'});
    case 'PhaseAutomaticallyPassed': return finish(`${who} · ${phaseLabel(p.section ?? event.phase)} passed`, p.reason, {kind:'pass'});
    case 'PhaseUnavailable': return finish(`${phaseLabel(event.phase)} unavailable`, p.reason, {kind:'pass'});
    case 'PokerDeclarationsFinished': return finish(`${who} finished Poker`, 'The one immediate declaration window has closed for this player.', {kind:'pass'});
    case 'HarvestActorCompleted': return null; // The following Poker entry explains this same boundary.
    case 'HarvestCardsDrawn': return finish(`${who} drew for the ${piece}`, `${p.card_ids.length} card${p.card_ids.length===1?'':'s'} from the ${title(p.deck)} deck. Keep one actual card.`, {kind:'draw',cards:cardModels(state,p.card_ids),unit});
    case 'HarvestCardKept': return finish(`${who} kept a Harvest card`,
      `One card joins the Resource hand. ${p.returned_card_ids.length ? `${p.returned_card_ids.length} rejected card${p.returned_card_ids.length===1?'':'s'} wait face down.` : 'The single-card offer was kept automatically.'}${p.counter_sources.length ? ` One Counter adds 1: ${p.counter_sources.map(s=>s==='CENTER'?'Center square':'matching Vassal suit').join(' and ')}; bonuses do not stack.` : ''}`,
      {kind:'harvest',cards:cardModels(state,[p.kept_card_id],p.counter_sources.length>0),rejects:p.returned_card_ids.length,unit});
    case 'HarvestFailsafeUsed': return finish(`${who} took the Harvest failsafe`, 'The full normal Harvest was exchanged for one Black Resource Card.', {kind:'harvest',cards:cardModels(state,[p.card_id])});
    case 'HarvestFailsafeDeclined': return finish(`${who} chose normal Harvest`, 'The offered Black-card exchange was declined. Each Unit Harvests normally.');
    case 'HarvestSupplyShortage': return finish('The deck could not fill the offer', p.message ?? 'Only physically available cards can be drawn.');
    case 'HarvestRejectsReturned': case 'HarvestRejectsRecycled': return finish('Harvest rejects returned', 'The face-down rejected cards returned to their recorded deck and were shuffled.', {kind:'cleanup'});
    case 'PokerHandDeclared': return finish(`${who} declared ${title(p.kind)}`, 'These exact physical cards gain a Counter. They cannot overlap another declaration and must be spent or returned this Year.', {kind:'poker',cards:cardModels(state,p.card_ids,true)});
    case 'ResourceCardsTapped': return finish(`${who} tapped Resources`, `${p.value} ${SUIT_GLYPH[p.suit]} moves into the seasonal pool. The physical cards remain tapped until season cleanup.`, {kind:'payment',suit:p.suit,value:p.value,cards:cardModels(state,p.card_ids)});
    case 'UnitBuilt': return finish(`${who} built a Pawn`, `A new Pawn entered ${p.square}.${pay}`, {kind:'build',unit:{owner:actor,unit_type:'PAWN'},destination:p.square});
    case 'UnitUpgraded': return finish(`${who} upgraded ${title(p.from_type)} → ${title(p.to_type)}`, `The Holding’s Level changes; physical reserve limits still apply.${pay}`, {kind:'upgrade',unit:{owner:actor,unit_type:p.to_type},oldUnit:{owner:actor,unit_type:p.from_type}});
    case 'UnitMobilized': return finish(`${who} moved the ${piece}`, `${p.origin} → ${p.destination}.${pay}`, {kind:'move',unit,origin:p.origin,destination:p.destination});
    case 'SovereignChosen': case 'NobleVassalized': case 'NobleRecruited': {
      const noble = state.nobles_by_id[p.noble_id];
      const heading = event.type==='NobleRecruited' ? `${who} drew a Court Noble` : event.type==='SovereignChosen' ? `${who} chose a Sovereign` : `${who} assigned ${nobleLabel(state,p.noble_id)}`;
      const text = event.type==='NobleVassalized' ? `The ${piece} becomes a Levy: it can now move and attack, and its General’s rank adds a Combat bonus.${pay}` : event.type==='SovereignChosen' ? 'The Sovereign remains assigned to the King, adding its rank in Combat and a Counter to a matching Harvest card.' : `The drawn Noble stays face down in its owner’s Court.${pay}`;
      return finish(heading,text,{kind:'noble',unit,noble:noble&&!noble.hidden?{face:noble.face,suit:noble.suit,rank:noble.rank,noble_id:noble.noble_id}:null});
    }
    case 'CombatResolved': {
      const following=state.event_log.filter(e=>e.sequence>event.sequence);
      const stop=following.findIndex(e=>e.type==='CombatResolved');
      const ending=following.slice(0,stop<0?following.length:stop).find(e=>e.type==='MatchCompleted'&&[p.attacker_id,p.defender_id].includes(e.payload.defeated_king_id));
      const model=combatFromEvent(event,{...state,status:ending?'COMPLETE':'ACTIVE',winner:ending?.payload.winner});
      if(!model) return finish('A battle resolved','The saved Chronicle records the comparison and result.');
      return finish('Recorded battle', 'Replay of the saved dice; no new roll is made.', {kind:'combat',combat:model,duration:model.kingFall?KING_COMBAT_DURATION:COMBAT_DURATION});
    }
    case 'UnitDefeated': return finish(`${title(p.defeated_owner)} lost a Unit`, p.attacker_occupied_square ? `${title(p.victor)} won. The attacker advances to ${p.attacker_occupied_square}; the defeated piece leaves the board.` : `${title(p.victor)} won. The defeated piece leaves the board. The following recorded consequences show the Noble’s fate and any Conquest choice.`, {kind:'casualty',unit:unitAtEvent(state,event,p.unit_id,p.defeated_owner)});
    case 'QuarterDecisionRequested': return finish(`${title(p.victor)} was offered Quarter`, 'The battle is already resolved. The victor chooses whether the defeated General becomes a Hostage.');
    case 'NobleCaptured': return finish(`${title(p.captor)} granted Quarter`, `${nobleLabel(state,p.noble_id)} entered the Dungeon as a Hostage.`);
    case 'NobleKilledInBattle': return finish('No Hostage retained', `${nobleLabel(state,p.noble_id)} returned to the Noble deck: ${p.reason==='DUNGEON_FULL'?'the Dungeon was already full':'No Quarter was chosen'}.`, {kind:'cleanup'});
    case 'RansomOffered': return finish(`${title(p.owner)} received a Ransom offer`, `The Hostage costs ${p.cost} ◇ to release. The original owner has first choice.`, {suit:'DIAMONDS'});
    case 'RansomDeclined': return finish(`${who} declined Ransom`, 'The offer advances to its next recorded choice.', {suit:'DIAMONDS'});
    case 'HostageRansomed': return finish(`${title(p.buyer)} paid Ransom`, `${nobleLabel(state,p.noble_id)} returned to the buyer’s Court. Paid ${p.cost} ◇; ${p.proceeds} goes to the captor.`, {suit:'DIAMONDS',kind:'private'});
    case 'HostageExecuted': return finish(`${who} Executed a Hostage`, `Paid ${p.cost} ♡. The Noble returned to the shuffled Noble deck.`, {kind:'cleanup'});
    case 'SeasonCleaned': return finish(`${title(p.suit)} season closes`, `${p.returned_card_ids.length} tapped card${p.returned_card_ids.length===1?'':'s'} returned to the ${title(p.deck)} deck. The ${SUIT_GLYPH[p.suit]} pools reset to zero.`, {kind:'cleanup',suit:p.suit,count:p.returned_card_ids.length});
    case 'ResourceStockpileCommitted': return finish(`${who} kept a Stockpile`, `${p.kept_card_ids.length} cards retained; ${p.discarded_card_ids.length} returned. The actual saved selection is preserved.`, {kind:'stockpile',cards:cardModels(state,p.kept_card_ids),count:p.discarded_card_ids.length});
    case 'DefeatedCourtClaimed': return finish(`${title(p.victor)} received Court spoils`, `${p.captured_count} face-down Nobles claimed; ${p.returned_count} returned. Unrevealed identities remain private.`, {kind:'private'});
    case 'DefeatedCourtDispersed': return finish(`${title(p.defeated_player)}’s remaining Court returned`, `${p.returned_count ?? p.noble_ids?.length ?? 0} face-down Nobles returned to the shuffled Noble deck.`, {kind:'private',privateLabel:'Returned Court'});
    case 'DefeatedResourcesClaimed': return finish(`${title(p.victor)} received Resource spoils`, `${p.card_ids.length} untapped Resources transferred from ${title(p.defeated_player)}.`, {kind:'harvest',cards:cardModels(state,p.card_ids)});
    case 'HostageReleasedOnDefeat': return finish('A Hostage was released', 'The defeated player’s Hostage returned to its surviving original owner’s Court.', {kind:'private'});
    case 'HostageKilledOnDefeat': return finish('A Hostage returned to the deck', 'The Hostage’s original owner had already been defeated. The Noble returned to the shuffled Noble deck.', {kind:'cleanup'});
    case 'DefeatedPlayersHostagesKilled': return finish(`${title(p.defeated_player)}’s Hostages returned`, `${p.noble_ids.length} Hostage${p.noble_ids.length===1?'':'s'} belonging to the defeated player returned from other Dungeons to the shuffled Noble deck.`, {kind:'cleanup'});
    case 'DefeatedVassalsKilled': return finish(`${title(p.defeated_player)}’s Vassals returned`, `${p.noble_ids.length} assigned Noble${p.noble_ids.length===1?'':'s'} returned to the shuffled Noble deck as the remaining Units were removed.`, {kind:'cleanup'});
    case 'DefeatedSovereignReturned': return finish('The fallen Sovereign returned', 'The victor chose the Holding. The fallen Sovereign returned to the shuffled Noble deck.', {kind:'cleanup'});
    case 'CapturedQueenDestroyed': return finish('A captured Queen was lost', 'The irreplaceable Queen left the board permanently.', {kind:'casualty',unit:unitAtEvent(state,event,p.unit_id)});
    case 'PlayerEliminated': return finish(`${title(p.defeated_player)} was defeated`, 'Their King is gone. The recorded spoils and remaining-Unit cleanup resolve before the Conquest choice.', {kind:'casualty'});
    case 'ConquestChoiceRequested': return finish(`${title(p.victor)} received the Conquest choice`, 'Choose the fallen Sovereign Card or the captured Queen Holding.');
    case 'ConquestCardTaken': return finish(`${title(p.victor)} chose the Card`, 'The fallen Sovereign entered the victor’s Court; the defeated pieces were removed.', {kind:'private'});
    case 'ConquestHoldingTaken': return finish(`${title(p.victor)} chose the Holding`, 'The captured Queen is controlled by the victor. Its original piece colour remains visible.', {kind:'build',unit:{owner:p.victor,piece_color:p.defeated_player,unit_type:'QUEEN'},destination:p.square});
    case 'PlayerResigned': return finish(`${who} resigned`, 'The resignation is permanent. Any required surviving-player spoils ballot follows.');
    case 'ResignationVoteCast': return finish(`${who} voted`, p.choice==='NONE'?'No spoils. This public vote may be changed before resolution.':`Spoils to ${title(p.choice)}. This public vote may be changed before resolution.`);
    case 'ResignationResolved': return finish('Resignation resolved', p.beneficiary?`${title(p.beneficiary)} receives the agreed spoils.`:'No spoils were awarded.');
    case 'ResignedNoblesReturned': return finish(`${who}’s Nobles returned`, `${p.returned_count ?? p.noble_ids?.length ?? 0} Nobles returned to the shuffled Noble deck after resignation. Unrevealed Court identities remain private.`, {kind:'private',privateLabel:'Returned Nobles'});
    case 'MatchCompleted': return finish(`${title(p.winner)} wins`, 'The game ended immediately. The terminal board and game record remain available.', {kind:'victory'});
    default: return p.chronicle?.text ? finish(`${who} · ${phaseLabel(event.phase)}`,p.chronicle.text) : null;
  }
}

export function reconnectRecap(state, viewer, {afterSequence = null} = {}) {
  if (!viewer || !state.players[viewer]) return {steps:[],boundary:null,through:0};
  const boundary = lastPersonalTurn(state,viewer);
  // A player who has never acted has no last turn to recap. The live
  // presentation handles setup and their first decision normally.
  if (afterSequence === null && !boundary) return {steps:[],boundary:null,through:0};
  const floor = afterSequence ?? boundary.sequence;
  const events = state.event_log.filter(e=>e.sequence>floor);
  return { boundary, through: Math.max(floor,...events.map(e=>e.sequence)),
    steps:events.map(e=>describePublishedAction(e,state)).filter(Boolean) };
}

function storyCards(step) {
  return `<div class="story-cards">${step.cards.map((card,i)=>`<span class="story-card ${['DIAMONDS','HEARTS'].includes(card.suit)?'red-card':''}" style="--story-index:${i}"><strong>${formatResource({...card,has_counter:false})}</strong>${card.has_counter?'<i class="card-counter" aria-label="One Counter adds one"></i>':''}</span>`).join('')}${step.rejects?`<span class="story-rejects"><i class="story-back">◇</i><small>${step.rejects} face down</small></span>`:''}</div>`;
}
export function recapStepHTML(step,{combatStage='complete'}={}) {
  if(step.kind==='combat')return `<div class="recap-combat combat-${combatStage}${step.combat.victory?' ceremonial-victory':''}">${combatHTML(step.combat,combatStage,'This is the recorded outcome. Continue the recap to see its actual consequences.').replace(/<button[\s\S]*?<\/button>/g,'')}</div>`;
  const pieces=step.unit?pieceIcon(step.unit):'';
  let visual=step.cards.length?storyCards(step):`<div class="story-emblem" aria-hidden="true">${SUIT_GLYPH[step.suit]??(step.kind==='victory'?'♔':'✦')}</div>`;
  if(step.kind==='move')visual=`<div class="story-travel"><span>${step.origin}</span><div class="travel-line"><i class="story-traveller">${pieces}</i><b>→</b></div><span>${step.destination}</span></div>`;
  if(['build','upgrade','casualty'].includes(step.kind))visual=`<div class="story-pieces">${step.oldUnit?`${pieceIcon(step.oldUnit)}<b>→</b>`:''}<span class="story-piece">${pieces}</span>${step.destination?`<strong>${step.destination}</strong>`:''}</div>`;
  if(step.kind==='noble' && step.noble)visual=`<div class="story-noble">${nobleCardHtml(step.noble,{illustrated:true})}</div>`;
  if(step.kind==='private')visual=`<div class="story-private"><i class="story-back">◇</i><span>${escapeMarkup(step.privateLabel??'Face-down Court')}</span></div>`;
  if(step.kind==='payment')visual+=`<div class="story-pool">+${step.value} ${SUIT_GLYPH[step.suit]} <small>seasonal pool</small></div>`;
  return `${suitFrieze(step.suit)}<h2>${escapeMarkup(step.heading)}</h2><div class="story-visual story-${step.kind}" aria-hidden="true">${visual}</div><p class="story-explanation">${escapeMarkup(step.text)}</p>${step.order?`<p class="story-order">${escapeMarkup(step.order)}</p>`:''}`;
}

// Presentation only. No engine, network, RNG, storage or gameplay callback is
// called by a timer or by pause/back/skip. The supplied steps are immutable.
export class RecapPresenter {
  constructor({render,onComplete=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}) {
    Object.assign(this,{render,onComplete,setTimer,clearTimer,now});this.timers=[];this.generation=0;this.busy=false;this.steps=[];
  }
  cancelTimers(){for(const t of this.timers)this.clearTimer(t);this.timers=[];this.generation++;}
  clear(){this.cancelTimers();this.busy=false;this.steps=[];this.index=0;}
  show(steps,{reducedMotion=false}={}){this.clear();if(!steps.length)return false;this.steps=steps;this.index=0;this.busy=true;this.reducedMotion=reducedMotion;this.paused=reducedMotion;this.begin();return true;}
  begin(){this.cancelTimers();this.elapsed=0;this.started=this.now();this.paint();this.schedule();}
  stage(){if(this.reducedMotion)return 'complete';return COMBAT_BEATS.findLast(b=>b.at<=this.elapsed)?.stage??'opening';}
  paint(){this.render(this.steps[this.index],{index:this.index,count:this.steps.length,paused:this.paused,reducedMotion:this.reducedMotion,combatStage:this.stage()});}
  schedule(){
    if(!this.busy||this.paused)return;
    const step=this.steps[this.index],generation=this.generation;
    this.started=this.now();
    if(step.kind==='combat')for(const beat of COMBAT_BEATS.filter(b=>b.at>this.elapsed))this.timers.push(this.setTimer(()=>{if(generation===this.generation){this.elapsed=beat.at;this.started=this.now();this.paint();}},beat.at-this.elapsed));
    this.timers.push(this.setTimer(()=>{if(generation===this.generation)this.next();},Math.max(0,step.duration-this.elapsed)));
  }
  pause(){if(!this.busy||this.paused)return;this.elapsed+=this.now()-this.started;this.cancelTimers();this.paused=true;this.paint();}
  resume(){if(!this.busy||!this.paused)return;this.paused=false;this.paint();this.schedule();}
  toggle(){if(this.paused)this.resume();else this.pause();}
  next(){if(!this.busy)return;if(++this.index>=this.steps.length){this.finish();return;}this.begin();}
  back(){if(!this.busy)return;this.index=Math.max(0,this.index-1);this.begin();}
  finish(){if(!this.busy)return;this.clear();this.onComplete();}
  reduce(){if(!this.busy)return;this.pause();this.reducedMotion=true;this.paint();}
  append(steps){if(!this.busy)return;const seen=new Set(this.steps.map(s=>s.eventId));const extra=steps.filter(s=>!seen.has(s.eventId));if(!extra.length)return;this.steps=[...this.steps,...extra];this.paint();}
}
