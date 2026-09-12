import test from "node:test";
import assert from "node:assert/strict";
import { DECK, PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { dispatch, legalCommandSummary, newMatch as currentMatch, replayCommandLog } from "../src/engine.js";
import { actionCostDescription, harvestCardDetails } from "../src/format.js";
import { formatChronicle } from "../src/notation.js";
import { deserializeMatch, serializeMatch } from "../src/persistence.js";
import { projectForPlayer, projectSpectator } from "../src/projection.js";
import { actionCost, deriveConstants, orderedHarvestUnits, usesStandardHarvestOrder } from "../src/rules.js";
import { RoomStore } from "../src/rooms.js";
import { LEGACY_RULES, addUnit, forcePhase, givePool, must, setUpMatch } from "./helpers.js";

// Retain coverage of v1.4 saves and their original command replay.
const newMatch = (options = {}) => currentMatch({ ...options, rules: { ...LEGACY_RULES, ...options.rules } });

function finishSetup(state) {
  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.BLACK, noble_id: "NC-K-S" });
  return must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.WHITE, noble_id: "NC-K-H" });
}

function putOnTop(state, deck, ids) {
  state.decks[deck] = [...ids, ...state.decks[deck].filter((id) => !ids.includes(id))];
}

test("Harvest uses status, Level and the two different coordinate tie-breaks", () => {
  const state = newMatch();
  for (const square of ["c1", "h2", "c8", "h6"]) addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, square);
  const bishop = addUnit(state, PLAYER.WHITE, UNIT_TYPE.BISHOP, "g5");
  const levy = addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "g3");
  state.units_by_id[levy].vassal_noble_id = "NC-J-C";
  state.units_by_id["U-W-001"].vassal_noble_id = "NC-K-H";
  assert.deepEqual(orderedHarvestUnits(state, PLAYER.WHITE).map((u) => u.square), ["h6", "h2", "c8", "c1", "g5", "g3", "a1"]);
  for (const square of ["c5", "g2", "a2"]) addUnit(state, PLAYER.BLACK, UNIT_TYPE.PAWN, square);
  assert.deepEqual(orderedHarvestUnits(state, PLAYER.BLACK).map((u) => u.square), ["a2", "g2", "c5", "h8"]);
  state.rules.player_count = 4;
  assert.equal(usesStandardHarvestOrder(state), false, "the source does not define the four-player order");
  assert.equal(orderedHarvestUnits(state, PLAYER.WHITE)[0].unit_id, "U-W-001");
  state.rules.player_count = 2;
  delete state.rules.harvest_order;
  assert.equal(usesStandardHarvestOrder(state), false, "old saved games keep their established order");
  assert.equal(state.units_by_id[bishop].unit_type, UNIT_TYPE.BISHOP);
});

test("the fixed Harvest queue is frozen, saved and enforced by the server engine", () => {
  let state = newMatch({ seed: "fixed-harvest" });
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "b2");
  state = finishSetup(state);
  const queue = [...state.harvest.remaining_unit_ids];
  assert.deepEqual(queue, ["FIX-WHITE-b2", "U-W-001"]);
  assert.deepEqual(legalCommandSummary(state).map((c) => c.unit_id), ["FIX-WHITE-b2"]);
  const invalid = dispatch(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.BLACK });
  assert.equal(invalid.error.code, "HARVEST_ORDER_REQUIRED");
  assert.deepEqual(invalid.state, state);
  assert.deepEqual(deserializeMatch(serializeMatch(state)).harvest.remaining_unit_ids, queue);
});

test("automatic Harvest resolves single-card offers and stops at each meaningful choice", () => {
  let state = newMatch({ seed: "auto-harvest" });
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "h2");
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "e4");
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.BISHOP, "c4");
  state = finishSetup(state);
  const before = structuredClone(state);
  const command = { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "FIX-WHITE-h2", deck: DECK.BLACK, auto_harvest: true };
  state = must(state, command);
  assert.equal(state.players.WHITE.resource_hand_ids.length, 2);
  assert.equal(state.harvest.unit_id, "FIX-WHITE-c4");
  assert.equal(state.harvest.offer_ids.length, 2, "the Bishop's card choice is never made automatically");
  assert.deepEqual(must(before, command), state, "Undo and repetition reproduce the same automatic draws");
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.WHITE, card_id: state.harvest.offer_ids[0], auto_harvest: true });
  assert.equal(state.harvest.offer_ids.length, 0);
  assert.deepEqual(state.harvest.remaining_unit_ids, ["U-W-001"], "the King waits for a corner-deck choice");
  assert.equal(state.current_actor, PLAYER.WHITE);
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.RED, auto_harvest: true });
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.WHITE, card_id: state.harvest.offer_ids[0], auto_harvest: true });
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.equal(state.harvest.offer_ids.length, 0, "automation does not begin the opponent's turn");
});

test("the chronicle freezes selected and rejected Counters and uses 1 for an Ace", () => {
  let state = setUpMatch("immutable-chronicle");
  putOnTop(state, DECK.BLACK, ["RC-C-01", "RC-S-04", "RC-C-09"]);
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.BLACK });
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.WHITE, card_id: "RC-C-01" });
  putOnTop(state, DECK.BLACK, ["RC-S-09", "RC-C-08", "RC-S-06"]);
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.BLACK, unit_id: "U-B-001", deck: DECK.BLACK });
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.BLACK, card_id: "RC-S-09" });
  const log = formatChronicle(state);
  assert.match(log, /Turn 0\nWhite: Ka1\*RxH\nBlack: Kh8\*RxS\nButton: White/);
  assert.match(log, /Harvest\nWhite: \(1C\) 4S 9C\nBlack: \(9S\*\) 8C 6S\*/);
  const spectator = formatChronicle(projectSpectator(state));
  assert.match(spectator, /White: \(1C\) 4S 9C/);
  assert.match(spectator, /Black: \(9S\*\) 8C 6S\*/);
  state.units_by_id["U-B-001"].square = "e5";
  state.units_by_id["U-W-001"].square = "d4";
  for (const card of Object.values(state.resources_by_id)) card.has_counter = false;
  assert.equal(formatChronicle(state), log, "current squares and Counter flags cannot rewrite history");
});

test("Harvest previews explain one Counter even when both bonuses apply", () => {
  const state = setUpMatch();
  const unit = { ...state.units_by_id["U-W-001"], square: "d4" };
  const details = harvestCardDetails(state.resources_by_id["RC-H-09"], unit, state);
  assert.equal(details.effective_value, 10);
  assert.equal(details.card.has_counter, true);
  assert.match(details.explanation, /one Counter maximum/);
  assert.equal(state.resources_by_id["RC-H-09"].has_counter, false, "a preview does not grant a Counter");
});

test("Recruit costs stay visible while private identities remain redacted until a committed result", () => {
  let state = setUpMatch("private-notation");
  forcePhase(state, PHASE.RECRUIT);
  givePool(state, PLAYER.WHITE, SUIT.DIAMONDS, 20);
  state = must(state, { type: "RECRUIT_NOBLE", player: PLAYER.WHITE });
  const event = state.event_log.findLast((e) => e.type === "NobleRecruited");
  const opponent = projectForPlayer(state, PLAYER.BLACK);
  const hidden = opponent.event_log.find((e) => e.event_id === event.event_id);
  assert.equal(hidden.payload.chronicle.text, "Rec(4) [XX]");
  assert.equal(hidden.payload.noble_id, undefined);
  assert.equal(opponent.nobles_by_id[event.payload.noble_id], undefined);
  assert.equal(deriveConstants(opponent, PLAYER.BLACK).D, 3);
  assert.equal(actionCost(opponent, "RECRUIT"), 6);
  assert.equal(actionCostDescription(opponent, "RECRUIT"), "2 × 3 Nobles outside the deck = 6 ◇");
  state.status = "COMPLETE";
  assert.equal(projectForPlayer(state, PLAYER.BLACK, { revealComplete: false }).nobles_by_id[event.payload.noble_id], undefined);
  assert.ok(projectSpectator(state).nobles_by_id[event.payload.noble_id]);
  assert.equal(projectSpectator(state).event_log.find((e) => e.event_id === event.event_id).payload.chronicle.text, event.payload.chronicle.text);
});

test("a full Year records empty phases and Stockpiles, rotates player lines and replays exactly", () => {
  let state = setUpMatch("v14-full-year");
  while (state.year_number === 1) {
    let command;
    if (state.phase_notice) command = { type: "ACKNOWLEDGE_PHASE_NOTICE" };
    else if (state.harvest?.stage === "DRAW") {
      if (state.harvest.offer_ids.length) command = { type: "KEEP_HARVEST_CARD", card_id: state.harvest.offer_ids[0], auto_harvest: true };
      else command = { type: "DRAW_HARVEST", unit_id: state.harvest.remaining_unit_ids[0], deck: DECK.BLACK, auto_harvest: true };
    } else if (state.harvest?.stage === "POKER") command = { type: "FINISH_POKER" };
    else if (state.phase === PHASE.STOCKPILE) command = { type: "CHOOSE_STOCKPILE", card_ids: [] };
    else command = { type: "PASS_PHASE" };
    state = must(state, { ...command, player: state.current_actor });
  }
  assert.deepEqual(replayCommandLog(state), state);
  const log = formatChronicle(state);
  assert.match(log, /Build\nWhite: \/\nBlack: \//);
  assert.match(log, /Ransom\nWhite: \/\nBlack: \//);
  assert.match(log, /Stockpile\nWhite: \(\)\nBlack: \(\)/);
  assert.ok(log.endsWith("Year 2\nHarvest\n"), "unfinished turns must not be recorded as passes");
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.BLACK, unit_id: "U-B-001", deck: DECK.BLACK });
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.BLACK, card_id: state.harvest.offer_ids[0] });
  assert.match(formatChronicle(state), /Year 2\nHarvest\nBlack: /);
  assert.doesNotMatch(log, /Tap|Resource Cards Tapped|♧|◇|♤|♡/);
});

test("a completed online draft still requires Pass and does not reveal the opponent's Court", () => {
  const store = new RoomStore({ codeFactory: () => "V14ABC" });
  const host = store.create({ playerCount: 2, playerName: "White", seat: PLAYER.WHITE, seed: "finish" });
  const black = store.join(host.code, { playerName: "Black", seat: PLAYER.BLACK });
  store.start(host.code, host.token);
  const room = store.get(host.code);
  let state = setUpMatch("private-finish");
  forcePhase(state, PHASE.RECRUIT, PLAYER.BLACK);
  givePool(state, PLAYER.BLACK, SUIT.DIAMONDS, 20);
  state = must(state, { type: "RECRUIT_NOBLE", player: PLAYER.BLACK });
  const secret = state.players.BLACK.court_noble_ids[0];
  forcePhase(state, PHASE.SIEGE, PLAYER.WHITE);
  state.units_by_id["U-W-001"].square = "d4";
  state.units_by_id["U-B-001"].square = "e5";
  givePool(state, PLAYER.WHITE, SUIT.SPADES, 1000);
  room.committed_state = state;
  let draft;
  for (let i = 0; i < 20; i++) {
    draft = store.command(host.code, host.token, { type: "LAY_SIEGE", attacker_id: "U-W-001", defender_id: "U-B-001" });
    if (draft.game.status === "COMPLETE") break;
  }
  assert.equal(draft.game.status, "COMPLETE");
  assert.equal(draft.viewer.waiting_for_pass, true);
  assert.equal(draft.game.chronicle_complete, false);
  assert.equal(draft.game.nobles_by_id[secret], undefined);
  assert.equal(store.view(host.code, black.token).game.status, "ACTIVE");
  const committed = store.pass(host.code, host.token);
  assert.equal(committed.room.status, "COMPLETE");
  assert.equal(committed.game.chronicle_complete, true);
  assert.ok(committed.game.nobles_by_id[secret]);
  const log = formatChronicle(committed.game);
  assert.match(log, /Kd4[xyz]Ke5\(4\)/);
  assert.match(log, /Result: (White|Black) wins in Year 1/);
  assert.doesNotMatch(log, /\nStockpile\n/);
});
