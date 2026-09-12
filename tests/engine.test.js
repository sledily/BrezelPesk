import test from "node:test";
import assert from "node:assert/strict";
import { DECK, PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { dispatch, newMatch, replayCommandLog } from "../src/engine.js";
import { projectForPlayer } from "../src/projection.js";
import { validateInvariants } from "../src/rules.js";
import {
  addUnit,
  dismissPhaseNotice,
  forcePhase,
  givePool,
  giveResource,
  harvestBothKings,
  must,
  setUpMatch,
} from "./helpers.js";

test("setup enforces Black-then-White Sovereign choice and starts Year 1", () => {
  let state = newMatch({ seed: "setup", matchId: "TEST-SETUP" });
  const illegal = dispatch(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.WHITE, noble_id: "NC-K-H" });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.error.code, "NOT_ACTIVE_PLAYER");
  assert.deepEqual(illegal.state, state, "illegal command must not mutate state");

  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.BLACK, noble_id: "NC-K-S" });
  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.WHITE, noble_id: "NC-K-H" });
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.year_number, 1);
  assert.equal(state.phase, PHASE.HARVEST);
  assert.equal(state.decks[DECK.NOBLE].length, 10);
  assert.equal(state.units_by_id["U-W-001"].vassal_noble_id, "NC-K-H");
  assert.deepEqual(validateInvariants(state), []);
});

test("Harvest resolves one Unit at a time and then opens Poker declarations", () => {
  let state = setUpMatch("harvest");
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.RED });
  assert.equal(state.harvest.offer_ids.length, 3);
  const keptId = state.harvest.offer_ids[1];
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.WHITE, card_id: keptId });
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.ok(state.players[PLAYER.WHITE].resource_hand_ids.includes(keptId));
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.BLACK, unit_id: "U-B-001", deck: DECK.BLACK });
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.BLACK, card_id: state.harvest.offer_ids[0] });
  assert.equal(state.harvest.stage, "POKER");
  assert.equal(state.current_actor, PLAYER.WHITE);
  state = must(state, { type: "FINISH_POKER", player: PLAYER.WHITE });
  state = must(state, { type: "FINISH_POKER", player: PLAYER.BLACK });
  assert.equal(state.phase, PHASE.BUILD);
});

test("the color-lock failsafe sacrifices normal Harvest for one Black card", () => {
  let state = setUpMatch("failsafe");
  state.units_by_id["U-W-001"].square = "a2";
  state.harvest.failsafe_pending = true;
  const before = state.decks[DECK.BLACK].length;
  state = must(state, { type: "RESOLVE_HARVEST_FAILSAFE", player: PLAYER.WHITE, use: true });
  assert.equal(state.players[PLAYER.WHITE].resource_hand_ids.length, 1);
  assert.equal(state.decks[DECK.BLACK].length, before - 1);
  assert.equal(state.current_actor, PLAYER.BLACK);
});

test("tapped Counter value enters a persistent seasonal pool and dynamic Build costs increase", () => {
  let state = setUpMatch("build");
  forcePhase(state, PHASE.BUILD, PLAYER.WHITE);
  const rookId = addUnit(state, PLAYER.WHITE, UNIT_TYPE.ROOK, "b2");
  assert.ok(rookId);
  const cardId = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 10, { counter: true });
  state = must(state, { type: "TAP_RESOURCES", player: PLAYER.WHITE, card_ids: [cardId] });
  assert.equal(state.players[PLAYER.WHITE].seasonal_pools[SUIT.CLOVERS], 11);
  state = must(state, { type: "BUILD_UNIT", player: PLAYER.WHITE, square: "b3" });
  assert.equal(state.players[PLAYER.WHITE].seasonal_pools[SUIT.CLOVERS], 7, "first Build cost is C=4");
  const result = dispatch(state, { type: "BUILD_UNIT", player: PLAYER.WHITE, square: "c3" });
  assert.equal(result.ok, true);
  state = result.state;
  assert.equal(state.players[PLAYER.WHITE].seasonal_pools[SUIT.CLOVERS], 1, "second Build cost rises to C=6");
  assert.deepEqual(state.event_log.filter((event) => event.type === "UnitBuilt").map((event) => event.payload.chronicle.text), ["Bld(4) b3", "Bld(6) c3"]);
});

test("Upgrade preserves stable Unit identity and its Vassal", () => {
  let state = setUpMatch("upgrade");
  forcePhase(state, PHASE.UPGRADE, PLAYER.WHITE);
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.ROOK, "b2");
  const pawnId = addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "b3", { vassalId: "NC-J-C" });
  givePool(state, PLAYER.WHITE, SUIT.CLOVERS, 50);
  state = must(state, { type: "UPGRADE_UNIT", player: PLAYER.WHITE, unit_id: pawnId, to_type: UNIT_TYPE.BISHOP });
  assert.equal(state.units_by_id[pawnId].unit_type, UNIT_TYPE.BISHOP);
  assert.equal(state.units_by_id[pawnId].vassal_noble_id, "NC-J-C");
  assert.equal(state.nobles_by_id["NC-J-C"].assigned_unit_id, pawnId);
  assert.equal(state.event_log.find((event) => event.type === "UnitUpgraded").payload.chronicle.text, "Upg(12) Bb3");
});

test("Siege records all dice and ends immediately when a King is defeated", () => {
  let state = setUpMatch("king-combat");
  forcePhase(state, PHASE.SIEGE, PLAYER.WHITE);
  state.units_by_id["U-W-001"].square = "g7";
  state.units_by_id["U-B-001"].square = "h8";
  givePool(state, PLAYER.WHITE, SUIT.SPADES, 99);
  let attempts = 0;
  while (state.status !== "COMPLETE" && attempts < 30) {
    const result = dispatch(state, {
      type: "LAY_SIEGE",
      player: PLAYER.WHITE,
      attacker_id: "U-W-001",
      defender_id: "U-B-001",
    });
    assert.equal(result.ok, true, result.error?.message);
    state = result.state;
    attempts += 1;
  }
  assert.equal(state.status, "COMPLETE");
  assert.ok([PLAYER.WHITE, PLAYER.BLACK].includes(state.winner));
  const combat = [...state.event_log].reverse().find((event) => event.type === "CombatResolved");
  assert.equal(combat.payload.attacker_rolls.length, 3);
  assert.equal(combat.payload.defender_rolls.length, 3);
  assert.equal(state.pending_combat, null, "King defeat never opens a Quarter decision");
});

test("a full peaceful Year reaches Stockpile and rotates the button", () => {
  let state = harvestBothKings(setUpMatch("year"));
  for (const phase of [PHASE.BUILD, PHASE.UPGRADE, PHASE.RANSOM, PHASE.RECRUIT, PHASE.MOBILIZE, PHASE.SIEGE, PHASE.VASSALIZE, PHASE.EXECUTE]) {
    assert.equal(state.phase, phase);
    let guard = 0;
    while (state.phase === phase && guard < 3) {
      state = state.phase_notice
        ? dismissPhaseNotice(state)
        : must(state, { type: "PASS_PHASE", player: state.current_actor });
      guard += 1;
    }
  }
  assert.equal(state.phase, PHASE.STOCKPILE);
  state = must(state, { type: "CHOOSE_STOCKPILE", player: state.current_actor, card_ids: [] });
  state = must(state, { type: "CHOOSE_STOCKPILE", player: state.current_actor, card_ids: [] });
  assert.equal(state.year_number, 2);
  assert.equal(state.button_holder, PLAYER.BLACK);
  assert.equal(state.phase, PHASE.HARVEST);
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.deepEqual(replayCommandLog(state), state, "seeded command replay must reproduce the exact canonical state");
});

test("opponent Court identities are removed by the projection layer", () => {
  const state = setUpMatch("projection");
  const nobleId = state.decks[DECK.NOBLE].shift();
  state.players[PLAYER.BLACK].court_noble_ids.push(nobleId);
  state.nobles_by_id[nobleId].location = "BLACK_COURT";
  state.nobles_by_id[nobleId].owner = PLAYER.BLACK;
  const whiteView = projectForPlayer(state, PLAYER.WHITE);
  assert.equal(whiteView.players[PLAYER.BLACK].court_noble_ids[0].hidden, true);
  assert.equal(whiteView.nobles_by_id[nobleId], undefined);
});
