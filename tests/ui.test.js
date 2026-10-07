import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { PHASE, PLAYER, SUIT, V2_RULES } from "../src/constants.js";
import { settleAutomaticPhases, dispatch } from "../src/engine.js";
import { forcePhase, giveResource, setUpMatch } from "./helpers.js";

// A lightweight DOM host runs the real standalone UI. These are interaction
// and rendered-content checks, not a replacement for a browser layout test.
function loadUI() {
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
    window: { setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {}, confirm() { return true; } },
    navigator: {}, crypto: { getRandomValues(array) { return array; } },
  });
  const expose = 'globalThis.ui = { render, renderActiveGames, renderOnlineLobby, run, selectHarvestCard, cancelResourceSelection, openStockpilePanel, saveStockpilePlan, undoLastAction, hideHandoff, showHandoff, inspectNoble, closeInspection, handleBoardClick, renderHarvestActions, renderVassalizeActions, renderPlayerSummary, maybeShowPhaseNotice, acknowledgeCurrentPhaseNotice, pendingAutomaticNotices, getState: () => state, setState: (next) => { state = next; selectedResourceIds = new Set(); render(); }, setViewer: (payload) => { onlinePayload = payload; render(); } };';
  new Script(code.replace(/\}\)\(\);\s*$/, `${expose}\n})();`)).runInContext(context);
  return { ui: context.ui, elements, app, html };
}

test("the standalone places Current Action above the corner table and constants below the board", () => {
  const { elements, html } = loadUI();
  const header = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  assert.doesNotMatch(header, /id="turn-card"/);
  assert.equal((elements.get("turn-card").innerHTML.match(/class="constant"/g) ?? []).length, 4);
  const positions = ["action-controls", "player-summary", "board", "turn-card", "board-hint", "history"].map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual(positions, [...positions].sort((a,b) => a - b));
  assert.match(elements.get("action-controls").innerHTML, /Boudica|Caesar|David|Cleopatra/);
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
  assert.match(elements.get("action-controls").innerHTML, /Vz♧ · Colbert/);
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
  assert.doesNotMatch(elements.get('player-summary').innerHTML, /Colbert/);
  ui.inspectNoble(id, true);
  assert.equal(elements.get('inspection-dialog').open, true);
  assert.match(elements.get('inspection-content').innerHTML, /Colbert/);
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
