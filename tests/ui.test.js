import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { PHASE, PLAYER, SUIT, V2_RULES } from "../src/constants.js";
import { settleAutomaticPhases, dispatch, newMatch } from "../src/engine.js";
import { forcePhase, giveResource, setUpMatch, addUnit } from "./helpers.js";

// A lightweight DOM host runs the real standalone UI. These are interaction
// and rendered-content checks, not a replacement for a browser layout test.
function loadUI({motion=false}={}) {
  const timers=[];
  const html = readFileSync(new URL("../Dendarv_Play.html", import.meta.url), "utf8");
  const code = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const contents = new Map();
  const storage = new Map();
  class Element {
    constructor(id) { this.id = id; this.hidden = false; this.value = ""; this.scrollHeight = 0; this.clientHeight = 0; this.scrollTop = 0; this.listeners = {}; }
    set innerHTML(text) {
      contents.set(this.id, text);
      for (const match of text.matchAll(/id="([^"]+)"/g)) if (!elements.has(match[1])) elements.set(match[1], new Element(match[1]));
    }
    get innerHTML() { return contents.get(this.id) ?? ""; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute(name, value) { this[name] = value; }
    focus() { document.activeElement = this; }
    querySelectorAll() { return []; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element(match[1]));
  for (const id of ["handoff", "phase-notice", "online-strip", "online-lobby"]) elements.get(id).hidden = true;
  elements.get("online-create-count").value = "4";
  elements.get("online-create-seat").value = "WHITE";
  const app = new Element("app-shell");
  const document = { querySelector(selector) { return selector === ".app-shell" ? app : elements.get(selector.slice(1)) ?? null; }, querySelectorAll() { return []; }, addEventListener() {}, createElement() { return new Element("new"); } };
  const context = createContext({ document, console, structuredClone, URL, URLSearchParams, Blob,
    localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); } },
    location: { href: "http://example.invalid/", search: "", protocol: "http:" },
    window: { matchMedia:()=>({matches:!motion,addEventListener(){}}), setTimeout(fn,ms) {const timer={fn,ms,cancelled:false};timers.push(timer);return timer;}, clearTimeout(timer) {if(timer)timer.cancelled=true;}, setInterval() {}, clearInterval() {}, confirm() { return true; } },
    navigator: {}, crypto: { getRandomValues(array) { return array; } },
  });
  const expose = 'globalThis.ui = { combatPresenter, clearPresentation, applyOnlinePayload, render, renderActiveGames, renderOnlineLobby, renderOnlineChrome, run, selectHarvestCard, cancelResourceSelection, openStockpilePanel, saveStockpilePlan, undoLastAction, hideHandoff, showHandoff, inspectNoble, closeInspection, handleBoardClick, renderHarvestActions, renderVassalizeActions, renderPlayerSummary, maybeShowPhaseNotice, acknowledgeCurrentPhaseNotice, pendingAutomaticNotices, getState: () => state, setState: (next) => { state = next; selectedResourceIds = new Set(); render(); }, setViewer: (payload) => { onlinePayload = payload; render(); }, setOnline: (payload) => { onlinePayload = payload; onlineClient = {}; renderOnlineChrome(); } };';
  new Script(code.replace(/\}\)\(\);\s*$/, `${expose}\n})();`)).runInContext(context);
  return { ui: context.ui, elements, app, html, timers };
}

test("the standalone places Current Action above the corner table and constants below the board", () => {
  const { elements, html } = loadUI();
  const header = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  assert.doesNotMatch(header, /id="turn-card"/);
  assert.equal((elements.get("turn-card").innerHTML.match(/class="constant"/g) ?? []).length, 4);
  const positions = ["action-controls", "player-summary", "board", "turn-card", "board-hint", "history"].map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual(positions, [...positions].sort((a,b) => a - b));
  assert.match(elements.get("action-controls").innerHTML, /BOUDICA|CÆSAR|DAVID|CLEOPATRA/);
  assert.doesNotMatch(elements.get("action-controls").innerHTML, /Rank|rank-pips|physical-rank/);
  assert.equal(elements.has("court-controls"), false);
});

test("Vassal controls render names and cost explanations without generic ranks", () => {
  const { ui, elements } = loadUI();
  const state = setUpMatch("ui-vassal", { automatic_passes: true, harvest_order: "STANDARD_V15" });
  forcePhase(state, PHASE.VASSALIZE);
  const id = "NC-J-C";
  state.decks.NOBLE = state.decks.NOBLE.filter((candidate) => candidate !== id);
  state.players.WHITE.court_noble_ids.push(id);
  Object.assign(state.nobles_by_id[id], { owner: PLAYER.WHITE, location: "WHITE_COURT" });
  ui.setState(state);
  assert.match(elements.get("action-controls").innerHTML, /Vz♧ · COLBERT/);
  assert.doesNotMatch(elements.get("action-controls").innerHTML, /Rank|rank-pips|physical-rank/);
});

test("automatic explanations wait for the next legal action and require one click each", async () => {
  const { ui, elements, app } = loadUI();
  const state = setUpMatch("ui-notices", { automatic_passes: true, harvest_order: "STANDARD_V15" });
  giveResource(state, PLAYER.WHITE, SUIT.SPADES, 9);
  forcePhase(state, PHASE.BUILD);
  settleAutomaticPhases(state);
  ui.setState(state);
  ui.hideHandoff();
  assert.equal(ui.getState().phase, PHASE.MOBILIZE);
  assert.equal(elements.get("phase-notice").hidden, false);
  assert.equal(app.inert, true);
  const count = ui.pendingAutomaticNotices().length;
  const before = ui.getState();
  assert.equal(await ui.run({ type: "PASS_PHASE", player: PLAYER.WHITE }), false, "an underlying action is blocked until notices are dismissed");
  assert.equal(ui.getState(), before);
  ui.acknowledgeCurrentPhaseNotice();
  assert.equal(ui.pendingAutomaticNotices().length, count - 1);
  assert.equal(elements.get("phase-notice").hidden, false);
  for (let i = 1; i < count; i++) ui.acknowledgeCurrentPhaseNotice();
  assert.equal(elements.get("phase-notice").hidden, true);
  assert.equal(app.inert, false);
  assert.equal(ui.getState(), before, "acknowledgements do not move the game or end another turn");
});

test("Court inspection is owner-only, stays face down at rest and clears on handover", () => {
  const { ui, elements } = loadUI();
  const state = forcePhase(setUpMatch('private-court-ui'), PHASE.BUILD);
  const id = 'NC-J-C';
  state.decks.NOBLE = state.decks.NOBLE.filter(n => n !== id);
  state.players.WHITE.court_noble_ids.push(id);
  Object.assign(state.nobles_by_id[id], {owner: PLAYER.WHITE, location: 'WHITE_COURT'});
  ui.setState(state);
  ui.hideHandoff();
  assert.doesNotMatch(elements.get('player-summary').innerHTML, /COLBERT/);
  ui.inspectNoble(id, true);
  assert.equal(elements.get('inspection-dialog').open, true);
  assert.match(elements.get('inspection-content').innerHTML, /COLBERT/);
  assert.match(elements.get('inspection-content').innerHTML, /class="noble-art"/);
  ui.showHandoff(PLAYER.BLACK);
  assert.equal(elements.get('inspection-dialog').open, false);
  assert.equal(elements.get('inspection-content').innerHTML, '');
  ui.inspectNoble(id, true);
  assert.equal(elements.get('inspection-content').innerHTML, '', 'handover blocks inspection');
  ui.hideHandoff();
  ui.setViewer({viewer:{role:'SPECTATOR', seat:null},room:{seats:{}}});
  ui.inspectNoble(id, true);
  assert.equal(elements.get('inspection-content').innerHTML, '', 'spectator cannot inspect even if passed an unfiltered state');
});

test('a fresh private draw shows artwork once, with no thumbnail at rest or replay on redraw', async () => {
  const {ui,elements} = loadUI();
  const state=forcePhase(setUpMatch('court-draw-art',V2_RULES),PHASE.RECRUIT);
  state.players.WHITE.seasonal_pools.DIAMONDS=10;
  ui.setState(state);ui.hideHandoff();
  const expected=state.decks.NOBLE[0];
  assert.equal(await ui.run({type:'RECRUIT_NOBLE',player:PLAYER.WHITE}),true);
  assert.ok(ui.getState().players.WHITE.court_noble_ids.includes(expected));
  assert.match(elements.get('inspection-content').innerHTML,/Noble drawn · Private Court/);
  assert.match(elements.get('inspection-content').innerHTML,/class="noble-art"/);
  assert.doesNotMatch(elements.get('player-summary').innerHTML,/class="noble-art"/);
  ui.closeInspection();ui.render();
  assert.equal(elements.get('inspection-dialog').open,false);
  assert.equal(elements.get('inspection-content').innerHTML,'');
});

test('playing a Vassal shows the full artwork while public tabletop labels remain icons', async () => {
  const {ui,elements} = loadUI();
  const state=forcePhase(setUpMatch('court-play-art',V2_RULES),PHASE.VASSALIZE);
  const id='NC-J-C', unit=addUnit(state,PLAYER.WHITE,'PAWN','b2');
  state.decks.NOBLE=state.decks.NOBLE.filter(n=>n!==id);
  state.players.WHITE.court_noble_ids.push(id);
  Object.assign(state.nobles_by_id[id],{owner:PLAYER.WHITE,location:'WHITE_COURT'});
  state.players.WHITE.seasonal_pools.HEARTS=10;
  ui.setState(state);ui.hideHandoff();
  assert.equal(await ui.run({type:'VASSALIZE_NOBLE',player:PLAYER.WHITE,noble_id:id,unit_id:unit}),true);
  assert.match(elements.get('inspection-content').innerHTML,/Noble played/);
  assert.match(elements.get('inspection-content').innerHTML,/class="noble-art"/);
  assert.doesNotMatch(elements.get('board').innerHTML,/class="noble-art"/);
  assert.doesNotMatch(elements.get('player-summary').innerHTML,/class="noble-art"/);
  ui.closeInspection();ui.render();
  assert.equal(elements.get('inspection-dialog').open,false);
});

test('a played Sovereign remains visible until dismissed before the next local handover', async () => {
  const {ui,elements} = loadUI();
  ui.setState(newMatch({seed:'sovereign-art-handover',playerCount:2,rules:V2_RULES}));
  ui.hideHandoff();
  assert.equal(await ui.run({type:'CHOOSE_SOVEREIGN',player:PLAYER.BLACK,noble_id:'NC-K-S'}),true);
  assert.equal(elements.get('inspection-dialog').open,true);
  assert.match(elements.get('inspection-content').innerHTML,/Noble played/);
  assert.match(elements.get('inspection-content').innerHTML,/class="noble-art"/);
  assert.equal(elements.get('handoff').hidden,true,'the reveal is not immediately covered');
  const saved=JSON.stringify(ui.getState());
  assert.equal(await ui.run({type:'CHOOSE_SOVEREIGN',player:PLAYER.WHITE,noble_id:'NC-K-H'}),false);
  assert.equal(JSON.stringify(ui.getState()),saved,'incoming player must acknowledge the handover');
  ui.closeInspection();
  assert.equal(elements.get('inspection-content').innerHTML,'');
  assert.equal(elements.get('handoff').hidden,false);
  assert.equal(elements.get('handoff-title').textContent,'White to act');
});

test("an unfunded Build preview survives tapping, and only Commit changes the board", async () => {
  const { ui, elements } = loadUI();
  const state = forcePhase(setUpMatch('preview-build'), PHASE.BUILD);
  const card = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8);
  ui.setState(state);
  ui.hideHandoff();
  ui.handleBoardClick('b2');
  assert.match(elements.get('action-controls').innerHTML, /Build a Pawn at b2/);
  assert.match(elements.get('action-controls').innerHTML, /id="commit-board-action"[^>]*disabled/);
  assert.equal(Object.values(ui.getState().units_by_id).some(u => u.square === 'b2'), false);
  await ui.run({type:'TAP_RESOURCES',player:PLAYER.WHITE,card_ids:[card]});
  assert.doesNotMatch(elements.get('action-controls').innerHTML, /id="commit-board-action"[^>]*disabled/);
  await elements.get('commit-board-action').onclick();
  assert.equal(Object.values(ui.getState().units_by_id).some(u => u.square === 'b2'), true);
  assert.equal(ui.getState().players.WHITE.seasonal_pools.CLOVERS, 6);
});

test("a cancelled movement preview leaves state intact", () => {
  const { ui, elements } = loadUI();
  const state = forcePhase(setUpMatch('cancel-move'), PHASE.MOBILIZE);
  state.players.WHITE.seasonal_pools.SPADES = 8;
  ui.setState(state);
  ui.hideHandoff();
  ui.handleBoardClick('a1');
  ui.handleBoardClick('c2');
  assert.match(elements.get('action-controls').innerHTML, /Move to c2/);
  assert.equal(ui.getState().units_by_id['U-W-001'].square, 'a1');
  elements.get('cancel-board-action').onclick();
  assert.doesNotMatch(elements.get('action-controls').innerHTML, /Commit action/);
  assert.equal(ui.getState().units_by_id['U-W-001'].square, 'a1');
  assert.equal(ui.getState().players.WHITE.seasonal_pools.SPADES, 8);
});


test("Harvest selection can be cancelled without keeping or redrawing, and revealed cards cannot be undone", async () => {
  const { ui, elements } = loadUI();
  let state = setUpMatch('ui-resource-cancel', V2_RULES);
  state = dispatch(state, {type:'DRAW_HARVEST', player:PLAYER.WHITE, unit_id:'U-W-001', deck:'BLACK'}).state;
  ui.setState(state);
  ui.hideHandoff();
  const before = JSON.stringify(ui.getState());
  ui.selectHarvestCard(state.harvest.offer_ids[0], {detail:1});
  assert.equal(elements.get('keep-harvest-selection').disabled, false);
  ui.cancelResourceSelection();
  assert.match(elements.get('harvest-table').innerHTML, /id="keep-harvest-selection"[^>]*disabled/);
  assert.equal(JSON.stringify(ui.getState()), before);
  await ui.undoLastAction();
  assert.equal(JSON.stringify(ui.getState()), before);
});

test("a local Stockpile plan closes at handover and does not reveal the incoming player's instructions", async () => {
  const { ui, elements } = loadUI();
  const state = forcePhase(setUpMatch('ui-plan-handover', V2_RULES), PHASE.BUILD);
  giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8);
  ui.setState(state);
  ui.hideHandoff();
  ui.openStockpilePanel();
  assert.match(elements.get('player-summary').innerHTML, /Private Stockpile instructions/);
  await ui.saveStockpilePlan();
  assert.equal(ui.getState().players.WHITE.stockpile_instructions.manual_plan.card_ids.length, 0);
  ui.showHandoff(PLAYER.BLACK);
  assert.doesNotMatch(elements.get('player-summary').innerHTML, /Private Stockpile instructions|Saved exact plan/);
});


test('Active Games escapes names, separates terminal records and distinguishes missing control from a missing game', () => {
  const {ui,elements}=loadUI();
  ui.renderActiveGames([
    {code:'ABC234',name:'<img src=x onerror=alert(1)>',status:'ACTIVE',year:4,phase:'SIEGE',players:[{seat:'WHITE',name:'<script>bad</script>'}],needs_recovery:true},
    {code:'DEF567',name:'Finished table',status:'COMPLETE',year:8,phase:'SIEGE',players:[]}
  ]);
  const html=elements.get('active-games-list').innerHTML;
  assert.doesNotMatch(html,/<img|<script>/);
  assert.match(html,/&lt;img/);
  assert.match(html,/Recover seat/);
  assert.match(html,/Open public view/);
  assert.match(html,/Finished games · read-only access/);
  assert.match(html,/View record/);
});

 test('lobby UI hides Random colours and exposes only role-appropriate controls',()=>{
  const {ui,elements}=loadUI();
  const host={participant_id:'host',name:'Host',is_host:true};
  const guest={participant_id:'guest',name:'Guest',is_host:false};
  const room={code:'ABC234',name:'Test room',status:'LOBBY',player_count:2,seating_mode:'RANDOM',participants:[host],seats:{},host_seat:null};
  ui.setViewer({room,viewer:{role:'PLAYER',is_host:true,can_start:false}});
  ui.renderOnlineLobby();
  assert.equal(elements.get('start-online-match').hidden,true);
  assert.equal(elements.get('lobby-cancel-room').hidden,false);
  assert.equal(elements.get('lobby-leave-seat').hidden,true);
  assert.doesNotMatch(elements.get('online-seat-list').innerHTML,/WHITE|BLACK|data-seat-for/);
  room.seating_mode='HOST';room.host_seat='WHITE';room.seats={WHITE:host,BLACK:guest};room.participants.push(guest);
  ui.setViewer({room,viewer:{role:'PLAYER',is_host:true,can_start:true}});ui.renderOnlineLobby();
  assert.equal(elements.get('start-online-match').hidden,false);
  assert.match(elements.get('online-seat-list').innerHTML,/data-assign-participant="guest"/);
  assert.doesNotMatch(elements.get('online-seat-list').innerHTML,/data-remove-participant="host"/);
  ui.setViewer({room,viewer:{role:'PLAYER',is_host:false,can_start:false}});ui.renderOnlineLobby();
  assert.equal(elements.get('lobby-leave-seat').hidden,false);
  assert.equal(elements.get('lobby-cancel-room').hidden,true);
 });

test('resignation UI shows public votes, distinguishes missing votes, and makes terminal play read-only',()=>{
 const {ui,elements}=loadUI();
 const state=setUpMatch('ballot-ui');
 state.pending_resignation={player:'RED',survivors:['WHITE','GREEN','BLACK'],votes:{WHITE:'NONE',BLACK:'WHITE'},deadline:'2026-10-09T06:00:00.000Z'};
 const room={code:'ABC234',status:'ACTIVE',seats:{WHITE:{name:'Host'},BLACK:{name:'Guest'}}};
 const viewer={role:'PLAYER',seat:'WHITE',is_host:true,is_your_turn:false};
 ui.setViewer({room,viewer});ui.setState(state);
 assert.match(elements.get('action-controls').innerHTML,/White: No spoils/);
 assert.match(elements.get('action-controls').innerHTML,/Green: Not yet voted/);
 assert.match(elements.get('action-controls').innerHTML,/data-resignation-vote="NONE"/);
 ui.setViewer({room,viewer:{role:'SPECTATOR'}});
 assert.doesNotMatch(elements.get('action-controls').innerHTML,/data-resignation-vote/);
 room.status='ABANDONED';
 ui.setViewer({room,viewer});
 assert.match(elements.get('action-controls').innerHTML,/without a winner/);
 assert.doesNotMatch(elements.get('action-controls').innerHTML,/data-resignation-vote|Pass and publish/);
 const terminal_record={status:'ABANDONED',ended_at:'2026-10-08T06:00:00.000Z',state};
 ui.setOnline({room,viewer,terminal_record});
 assert.equal(elements.get('terminal-record').hidden,false);
 assert.match(elements.get('terminal-record-json').textContent,/pending_resignation/);
 ui.setOnline({room,viewer:{role:'SPECTATOR'},terminal_record:null});
 assert.equal(elements.get('terminal-record').hidden,true);
});


test('combat UI preserves the saved pre-impact combatants, permits skipping and leaves the saved outcome unchanged',async()=>{
  const {ui,elements}=loadUI({motion:true});ui.hideHandoff();
  let before;
  for(let n=0;n<100;n++) {
    const s=forcePhase(setUpMatch('motion-'+n),PHASE.SIEGE);s.players.WHITE.seasonal_pools.SPADES=20;
    s.units_by_id['U-W-001'].square='d4';s.units_by_id['U-B-001'].square='e5';
    const out=dispatch(s,{type:'LAY_SIEGE',player:'WHITE',attacker_id:'U-W-001',defender_id:'U-B-001'});
    if(out.state.winner==='WHITE'){before=s;break;}
  }
  assert.ok(before);ui.setState(before);
  assert.equal(await ui.run({type:'LAY_SIEGE',player:'WHITE',attacker_id:'U-W-001',defender_id:'U-B-001'}),true);
  const saved=JSON.stringify(ui.getState());
  assert.equal(ui.combatPresenter.busy,true);assert.equal(elements.get('action-controls').inert,true);
  assert.match(elements.get('board').innerHTML,/e5, Black-controlled Black King/,'pre-impact snapshot stays on the presentation board');
  assert.equal(await ui.run({type:'PASS_PHASE',player:'WHITE'}),false);
  elements.get('skip-combat').listeners.click();
  assert.equal(ui.combatPresenter.busy,false);assert.equal(elements.get('action-controls').inert,false);
  assert.match(elements.get('combat-presentation').innerHTML,/White wins/);
  assert.match(elements.get('current-action-summary').textContent,/White wins · Review the board/);
  assert.doesNotMatch(elements.get('board').innerHTML,/e5, Black-controlled Black King/);
  assert.equal(JSON.stringify(ui.getState()),saved,'skip does not redraw, advance or change the game');
  ui.clearPresentation();assert.equal(elements.get('combat-presentation').innerHTML,'');
});

test('reduced-motion combat displays the final comparison immediately and reconnect restores it without a replay',async()=>{
  const {ui,elements}=loadUI();ui.hideHandoff();
  const s=forcePhase(setUpMatch('motion-0'),PHASE.SIEGE);s.players.WHITE.seasonal_pools.SPADES=20;
  s.units_by_id['U-W-001'].square='d4';s.units_by_id['U-B-001'].square='e5';ui.setState(s);
  await ui.run({type:'LAY_SIEGE',player:'WHITE',attacker_id:'U-W-001',defender_id:'U-B-001'});
  assert.equal(ui.combatPresenter.busy,false);assert.equal(elements.get('action-controls').inert,false);
  assert.match(elements.get('combat-presentation').className,/resolved/);
  ui.clearPresentation();ui.render();
  assert.equal(ui.combatPresenter.busy,false);assert.match(elements.get('combat-presentation').className,/resolved/);
});

test('the final affordable ordinary action makes Pass prominent while keeping Undo',async()=>{
  const {ui,elements}=loadUI();ui.hideHandoff();
  const s=forcePhase(setUpMatch('last-build',V2_RULES),PHASE.BUILD);
  s.players.WHITE.seasonal_pools.CLOVERS=2;s.automatic_notices=[];ui.setState(s);
  assert.equal(await ui.run({type:'BUILD_UNIT',player:'WHITE',square:'b1'}),true);
  assert.match(elements.get('action-controls').innerHTML,/id="pass-phase" class="button primary pass-ready full"/);
  assert.equal(elements.get('undo-action').disabled,false);
  assert.equal(ui.getState().current_actor,'WHITE');
});


test('shared-device Quarter handover follows combat presentation and cannot change the saved battle',async()=>{
  const {ui,elements}=loadUI({motion:true});ui.hideHandoff();let before,pawn;
  for(let n=0;n<100;n++) {
    const s=forcePhase(setUpMatch('quarter-motion-'+n),PHASE.SIEGE);s.players.WHITE.seasonal_pools.SPADES=20;
    s.units_by_id['U-B-001'].square='e5';const id=addUnit(s,'WHITE','PAWN','d4',{vassalId:'NC-J-D'});
    const out=dispatch(s,{type:'LAY_SIEGE',player:'WHITE',attacker_id:id,defender_id:'U-B-001'});
    if(out.state.pending_combat?.victor==='BLACK'){before=s;pawn=id;break;}
  }
  assert.ok(before);ui.setState(before);
  assert.equal(await ui.run({type:'LAY_SIEGE',player:'WHITE',attacker_id:pawn,defender_id:'U-B-001'}),true);
  const saved=JSON.stringify(ui.getState());assert.equal(elements.get('handoff').hidden,true);
  assert.equal(ui.getState().pending_combat.victor,'BLACK');
  ui.combatPresenter.skip();assert.equal(elements.get('handoff').hidden,false);
  assert.equal(elements.get('handoff-title').textContent,'Black to act');assert.equal(JSON.stringify(ui.getState()),saved);
  assert.match(elements.get('current-action-summary').textContent,/Black · Choose Quarter/);
  assert.equal(await ui.run({type:'CHOOSE_QUARTER',player:'BLACK',quarter:true}),false,'Ready is still required for private handover');
  ui.hideHandoff();assert.equal(await ui.run({type:'CHOOSE_QUARTER',player:'BLACK',quarter:true}),true);
  assert.equal(ui.getState().pending_combat,null);assert.equal(ui.getState().players.BLACK.dungeon_noble_id,'NC-J-D');
  assert.match(elements.get('combat-presentation').innerHTML,/Noble is in the victor’s Dungeon/);
});
