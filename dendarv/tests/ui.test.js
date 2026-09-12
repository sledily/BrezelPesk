import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { PHASE, PLAYER, SUIT } from "../src/constants.js";
import { settleAutomaticPhases } from "../src/engine.js";
import { forcePhase, giveResource, setUpMatch } from "./helpers.js";

// A lightweight DOM host runs the real standalone UI. These are interaction
// and rendered-content checks, not a replacement for a browser layout test.
function loadUI() {
  const html = readFileSync(new URL("../../Dendarv_Play.html", import.meta.url), "utf8");
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
    focus() { document.activeElement = this; }
    querySelectorAll() { return []; }
    showModal() { this.open = true; }
    close() { this.open = false; }
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
  const expose = 'globalThis.ui = { render, run, hideHandoff, renderHarvestActions, renderVassalizeActions, renderPlayerSummary, maybeShowPhaseNotice, acknowledgeCurrentPhaseNotice, pendingAutomaticNotices, getState: () => state, setState: (next) => { state = next; selectedResourceIds = new Set(); render(); } };';
  new Script(code.replace(/\}\)\(\);\s*$/, `${expose}\n})();`)).runInContext(context);
  return { ui: context.ui, elements, app, html };
}

test("the standalone starts with constants in the header and the requested section order", () => {
  const { elements, html } = loadUI();
  const header = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)[1];
  assert.match(header, /id="turn-card"/);
  assert.equal((elements.get("turn-card").innerHTML.match(/class="constant"/g) ?? []).length, 4);
  const positions = ["board", "board-hint", "action-controls", "resource-controls", "player-summary", "history"].map((id) => html.indexOf(`id="${id}"`));
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
  assert.match(elements.get("action-controls").innerHTML, /Vz♧ · Margaret of Parma/);
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
