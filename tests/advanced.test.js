import test from "node:test";
import assert from "node:assert/strict";
import { DECK, PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { dispatch } from "../src/engine.js";
import { deserializeMatch, serializeMatch } from "../src/persistence.js";
import { deriveConstants, validateInvariants } from "../src/rules.js";
import {
  addUnit,
  forcePhase,
  givePool,
  giveResource,
  must,
  setUpMatch,
} from "./helpers.js";

function putNobleInCourt(state, player, nobleId) {
  state.decks[DECK.NOBLE] = state.decks[DECK.NOBLE].filter((id) => id !== nobleId);
  const noble = state.nobles_by_id[nobleId];
  noble.location = `${player}_COURT`;
  noble.owner = player;
  noble.assigned_unit_id = null;
  state.players[player].court_noble_ids.push(nobleId);
}

function putNobleInDungeon(state, captor, owner, nobleId) {
  state.decks[DECK.NOBLE] = state.decks[DECK.NOBLE].filter((id) => id !== nobleId);
  const noble = state.nobles_by_id[nobleId];
  noble.location = `${captor}_DUNGEON`;
  noble.owner = owner;
  noble.assigned_unit_id = null;
  state.players[captor].dungeon_noble_id = nobleId;
}

test("Ransom gives the original owner first purchase and rounded proceeds to the captor", () => {
  let state = setUpMatch("ransom-owner");
  putNobleInDungeon(state, PLAYER.BLACK, PLAYER.WHITE, "NC-Q-C");
  forcePhase(state, PHASE.RANSOM, PLAYER.WHITE);
  state.active_ransom = { noble_id: "NC-Q-C", owner: PLAYER.WHITE, captor: PLAYER.BLACK, stage: "OWNER" };
  state.ransom_queue = [];
  const cost = deriveConstants(state).D * 2;
  givePool(state, PLAYER.WHITE, SUIT.DIAMONDS, cost);
  state = must(state, { type: "RESPOND_RANSOM", player: PLAYER.WHITE, pay: true });
  assert.ok(state.players[PLAYER.WHITE].court_noble_ids.includes("NC-Q-C"));
  assert.equal(state.players[PLAYER.BLACK].dungeon_noble_id, null);
  assert.equal(state.players[PLAYER.BLACK].seasonal_pools[SUIT.DIAMONDS], Math.ceil(cost / 2));
  assert.equal(state.phase, PHASE.RECRUIT);
  const entry = state.event_log.find((event) => event.type === "HostageRansomed").payload.chronicle;
  assert.equal(entry.text, "Ran(6) DxC");
  assert.equal(entry.player, PLAYER.WHITE);
});

test("the captor may buy a declined Hostage and ownership transfers", () => {
  let state = setUpMatch("ransom-captor");
  putNobleInDungeon(state, PLAYER.BLACK, PLAYER.WHITE, "NC-J-C");
  forcePhase(state, PHASE.RANSOM, PLAYER.WHITE);
  state.active_ransom = { noble_id: "NC-J-C", owner: PLAYER.WHITE, captor: PLAYER.BLACK, stage: "OWNER" };
  state.ransom_queue = [];
  state = must(state, { type: "RESPOND_RANSOM", player: PLAYER.WHITE, pay: false });
  const cost = deriveConstants(state).D;
  givePool(state, PLAYER.BLACK, SUIT.DIAMONDS, cost);
  state = must(state, { type: "RESPOND_RANSOM", player: PLAYER.BLACK, pay: true });
  assert.ok(state.players[PLAYER.BLACK].court_noble_ids.includes("NC-J-C"));
  assert.equal(state.nobles_by_id["NC-J-C"].owner, PLAYER.BLACK);
  assert.equal(state.players[PLAYER.BLACK].seasonal_pools[SUIT.DIAMONDS], 0, "a captor receives no proceeds for buying their own Hostage");
  const entry = state.event_log.find((event) => event.type === "HostageRansomed").payload.chronicle;
  assert.equal(entry.text, "Ran(3) VzC");
  assert.equal(entry.player, PLAYER.BLACK);
});

test("Vassalization raises H and paid Execution lowers both H and D", () => {
  let state = setUpMatch("hearts");
  const pawnId = addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "b2");
  putNobleInCourt(state, PLAYER.WHITE, "NC-J-C");
  forcePhase(state, PHASE.VASSALIZE, PLAYER.WHITE);
  const beforeH = deriveConstants(state).H;
  givePool(state, PLAYER.WHITE, SUIT.HEARTS, 10);
  state = must(state, { type: "VASSALIZE_NOBLE", player: PLAYER.WHITE, noble_id: "NC-J-C", unit_id: pawnId });
  assert.equal(deriveConstants(state).H, beforeH + 1);
  assert.equal(state.units_by_id[pawnId].vassal_noble_id, "NC-J-C");
  assert.equal(state.event_log.find((event) => event.type === "NobleVassalized").payload.chronicle.text, "Vas(2) Pb2*VzC");

  putNobleInDungeon(state, PLAYER.WHITE, PLAYER.BLACK, "NC-J-D");
  forcePhase(state, PHASE.EXECUTE, PLAYER.WHITE);
  const beforeD = deriveConstants(state).D;
  const beforeExecutionH = deriveConstants(state).H;
  givePool(state, PLAYER.WHITE, SUIT.HEARTS, 20);
  state = must(state, { type: "EXECUTE_HOSTAGE", player: PLAYER.WHITE });
  assert.equal(deriveConstants(state).D, beforeD - 1);
  assert.equal(deriveConstants(state).H, beforeExecutionH - 1);
  assert.equal(state.players[PLAYER.WHITE].dungeon_noble_id, null);
  assert.equal(state.event_log.find((event) => event.type === "HostageExecuted").payload.chronicle.text, "Exe(5) VzD");
});

function combatFixture(seed, { dungeonFull = false } = {}) {
  const state = setUpMatch(seed);
  forcePhase(state, PHASE.SIEGE, PLAYER.WHITE);
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.ROOK, "d4", { vassalId: "NC-K-C", unitId: "ATTACKER" });
  addUnit(state, PLAYER.BLACK, UNIT_TYPE.PAWN, "d5", { vassalId: "NC-Q-C", unitId: "DEFENDER" });
  if (dungeonFull) putNobleInDungeon(state, PLAYER.WHITE, PLAYER.BLACK, "NC-J-D");
  givePool(state, PLAYER.WHITE, SUIT.SPADES, 99);
  return state;
}

function findAttackerWin(options = {}) {
  for (let index = 0; index < 80; index += 1) {
    const state = combatFixture(`quarter-${index}`, options);
    const result = dispatch(state, { type: "LAY_SIEGE", player: PLAYER.WHITE, attacker_id: "ATTACKER", defender_id: "DEFENDER" });
    if (!result.ok) throw new Error(result.error.message);
    const combat = result.events.find((event) => event.type === "CombatResolved");
    if (combat.payload.outcome === "ATTACKER_WIN") return result.state;
  }
  throw new Error("No deterministic attacker-win seed found");
}

test("Quarter captures the defeated Vassal and No Quarter returns it to the deck", () => {
  let quarterState = findAttackerWin();
  assert.equal(quarterState.pending_combat.noble_id, "NC-Q-C");
  quarterState = must(quarterState, { type: "CHOOSE_QUARTER", player: PLAYER.WHITE, quarter: true });
  assert.equal(quarterState.players[PLAYER.WHITE].dungeon_noble_id, "NC-Q-C");
  assert.equal(quarterState.nobles_by_id["NC-Q-C"].owner, PLAYER.BLACK);

  let noQuarterState = findAttackerWin();
  noQuarterState = must(noQuarterState, { type: "CHOOSE_QUARTER", player: PLAYER.WHITE, quarter: false });
  assert.ok(noQuarterState.decks[DECK.NOBLE].includes("NC-Q-C"));
  assert.equal(noQuarterState.nobles_by_id["NC-Q-C"].owner, null);
});

test("a full Dungeon forces immediate battlefield execution", () => {
  const state = findAttackerWin({ dungeonFull: true });
  assert.equal(state.pending_combat, null);
  assert.equal(state.players[PLAYER.WHITE].dungeon_noble_id, "NC-J-D");
  assert.ok(state.decks[DECK.NOBLE].includes("NC-Q-C"));
  assert.ok(state.event_log.some((event) => event.type === "NobleKilledInBattle" && event.payload.reason === "DUNGEON_FULL"));
});

test("Stockpile applies one bonus slot to one suit rather than as generic capacity", () => {
  let state = setUpMatch("stockpile");
  forcePhase(state, PHASE.STOCKPILE, PLAYER.WHITE);
  const c1 = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 1);
  const c2 = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 2);
  const s1 = giveResource(state, PLAYER.WHITE, SUIT.SPADES, 1);
  const s2 = giveResource(state, PLAYER.WHITE, SUIT.SPADES, 2);
  const invalid = dispatch(state, { type: "CHOOSE_STOCKPILE", player: PLAYER.WHITE, card_ids: [c1, c2, s1, s2] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_STOCKPILE");
  state = must(state, { type: "CHOOSE_STOCKPILE", player: PLAYER.WHITE, card_ids: [c1, c2, s1] });
  assert.deepEqual(new Set(state.players[PLAYER.WHITE].resource_hand_ids), new Set([c1, c2, s1]));
});

test("save/load preserves an unresolved private Harvest offer exactly", () => {
  let state = setUpMatch("save-choice");
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.BLACK });
  const restored = deserializeMatch(serializeMatch(state));
  assert.deepEqual(restored, state);
  assert.equal(restored.harvest.offer_ids.length, 3);
  assert.deepEqual(validateInvariants(restored), []);
});
