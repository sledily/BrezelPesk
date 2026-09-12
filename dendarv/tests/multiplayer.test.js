import test from "node:test";
import assert from "node:assert/strict";
import { DECK, PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { dispatch, newMatch, replayCommandLog } from "../src/engine.js";
import { phaseOrderFromButton } from "../src/model.js";
import { deriveConstants, liveUnits, validateInvariants } from "../src/rules.js";
import {
  addUnit,
  forcePhase,
  givePool,
  giveResource,
  must,
  setUpFourPlayerMatch,
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

test("four-player setup uses doubled decks, corner Kings, and Green-Black-Red-White Sovereign order", () => {
  let state = newMatch({ seed: "four-setup", playerCount: 4, matchId: "TEST-FOUR-SETUP" });
  assert.equal(Object.keys(state.resources_by_id).length, 80);
  assert.equal(Object.keys(state.nobles_by_id).length, 24);
  assert.equal(state.decks[DECK.BLACK].length, 40);
  assert.equal(state.decks[DECK.RED].length, 40);
  assert.equal(state.current_actor, PLAYER.GREEN);
  assert.equal(state.units_by_id["U-W-001"].square, "a1");
  assert.equal(state.units_by_id["U-G-001"].square, "h1");
  assert.equal(state.units_by_id["U-B-001"].square, "h8");
  assert.equal(state.units_by_id["U-R-001"].square, "a8");

  for (const [player, nobleId] of [
    [PLAYER.GREEN, "NC-K-C-A"],
    [PLAYER.BLACK, "NC-K-D-A"],
    [PLAYER.RED, "NC-K-S-A"],
    [PLAYER.WHITE, "NC-K-H-A"],
  ]) {
    state = must(state, { type: "CHOOSE_SOVEREIGN", player, noble_id: nobleId });
  }

  assert.equal(state.status, "ACTIVE");
  assert.equal(state.decks[DECK.NOBLE].length, 20);
  assert.equal(deriveConstants(state).D, 4);
  assert.equal(deriveConstants(state).H, 4);
  assert.deepEqual(state.phase_actor_order, [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]);
  assert.deepEqual(validateInvariants(state), []);
});

test("four-player Button order alternates direction and passes clockwise", () => {
  let state = forcePhase(setUpFourPlayerMatch("four-order"), PHASE.STOCKPILE, PLAYER.WHITE);
  assert.deepEqual(state.phase_actor_order, [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]);
  for (const player of [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    assert.equal(state.current_actor, player);
    state = must(state, { type: "CHOOSE_STOCKPILE", player, card_ids: [] });
  }
  assert.equal(state.year_number, 2);
  assert.equal(state.button_holder, PLAYER.RED);
  assert.deepEqual(state.phase_actor_order, [PLAYER.RED, PLAYER.WHITE, PLAYER.GREEN, PLAYER.BLACK]);
  assert.equal(state.current_actor, PLAYER.RED);
});

test("all four players complete Harvest and Poker before Build begins", () => {
  let state = setUpFourPlayerMatch("four-harvest");
  for (const player of [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    assert.equal(state.current_actor, player);
    if (state.harvest.failsafe_pending) {
      state = must(state, { type: "RESOLVE_HARVEST_FAILSAFE", player, use: false });
    }
    const unitId = state.harvest.remaining_unit_ids[0];
    state = must(state, { type: "DRAW_HARVEST", player, unit_id: unitId, deck: DECK.BLACK });
    state = must(state, { type: "KEEP_HARVEST_CARD", player, card_id: state.harvest.offer_ids[0] });
  }
  assert.equal(state.harvest.stage, "POKER");
  for (const player of [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    assert.equal(state.current_actor, player);
    state = must(state, { type: "FINISH_POKER", player });
  }
  assert.equal(state.phase, PHASE.BUILD);
  assert.equal(state.current_actor, PLAYER.WHITE);
});

test("a peaceful four-player Year rotates the Button and replays exactly", () => {
  let state = setUpFourPlayerMatch("four-year");
  for (const player of [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    if (state.harvest.failsafe_pending) {
      state = must(state, { type: "RESOLVE_HARVEST_FAILSAFE", player, use: false });
    }
    const unitId = state.harvest.remaining_unit_ids[0];
    state = must(state, { type: "DRAW_HARVEST", player, unit_id: unitId, deck: DECK.BLACK });
    state = must(state, { type: "KEEP_HARVEST_CARD", player, card_id: state.harvest.offer_ids[0] });
  }
  for (const player of [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    state = must(state, { type: "FINISH_POKER", player });
  }
  let guard = 0;
  while (state.phase !== PHASE.STOCKPILE && guard < 80) {
    state = state.phase_notice
      ? must(state, { type: "ACKNOWLEDGE_PHASE_NOTICE", player: state.current_actor })
      : must(state, { type: "PASS_PHASE", player: state.current_actor });
    guard += 1;
  }
  assert.equal(state.phase, PHASE.STOCKPILE);
  for (const player of [PLAYER.WHITE, PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    assert.equal(state.current_actor, player);
    state = must(state, { type: "CHOOSE_STOCKPILE", player, card_ids: [] });
  }
  assert.equal(state.year_number, 2);
  assert.equal(state.button_holder, PLAYER.RED);
  assert.deepEqual(replayCommandLog(state), state);
});

function conquestFixture(seed, desiredOutcome = "ATTACKER_WIN") {
  const state = forcePhase(setUpFourPlayerMatch(seed), PHASE.SIEGE, PLAYER.WHITE);
  state.units_by_id["U-G-001"].square = "h1";
  if (desiredOutcome === "ATTACKER_WIN") {
    addUnit(state, PLAYER.WHITE, UNIT_TYPE.QUEEN, "g1", { vassalId: "NC-K-C-B", unitId: "WHITE-ATTACKER" });
  } else {
    state.units_by_id["U-W-001"].square = "g1";
  }
  givePool(state, PLAYER.WHITE, SUIT.SPADES, 99);
  return state;
}

function findKingDefeat(desiredOutcome, decorate = null) {
  for (let index = 0; index < 160; index += 1) {
    let state = conquestFixture(`conquest-${desiredOutcome}-${index}`, desiredOutcome);
    if (decorate) decorate(state);
    const attackerId = desiredOutcome === "ATTACKER_WIN" ? "WHITE-ATTACKER" : "U-W-001";
    const result = dispatch(state, {
      type: "LAY_SIEGE",
      player: PLAYER.WHITE,
      attacker_id: attackerId,
      defender_id: "U-G-001",
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    const combat = result.events.find((event) => event.type === "CombatResolved");
    if (combat.payload.outcome === desiredOutcome) return result.state;
  }
  throw new Error(`No deterministic ${desiredOutcome} seed found`);
}

test("defeat transfers Court and untapped Resources, resolves Hostages, and destroys Units and Vassals", () => {
  let untappedId;
  let tappedId;
  let state = findKingDefeat("ATTACKER_WIN", (candidate) => {
    putNobleInCourt(candidate, PLAYER.GREEN, "NC-J-D-A");
    putNobleInCourt(candidate, PLAYER.GREEN, "NC-Q-H-A");
    putNobleInCourt(candidate, PLAYER.GREEN, "NC-J-S-B");
    addUnit(candidate, PLAYER.GREEN, UNIT_TYPE.PAWN, "g2", { vassalId: "NC-Q-C-A", unitId: "GREEN-PAWN" });
    addUnit(candidate, PLAYER.GREEN, UNIT_TYPE.QUEEN, "f2", { unitId: "GREEN-QUEEN" });
    putNobleInDungeon(candidate, PLAYER.GREEN, PLAYER.RED, "NC-J-H-B");
    putNobleInDungeon(candidate, PLAYER.BLACK, PLAYER.GREEN, "NC-Q-D-B");
    untappedId = giveResource(candidate, PLAYER.GREEN, SUIT.CLOVERS, 10);
    tappedId = giveResource(candidate, PLAYER.GREEN, SUIT.DIAMONDS, 9, { tapped: true });
  });

  assert.equal(state.players[PLAYER.GREEN].eliminated, true);
  assert.equal(state.pending_conquest.victor, PLAYER.WHITE);
  assert.equal(state.players[PLAYER.WHITE].court_noble_ids.length, 2, "half of three Court cards is rounded up");
  assert.ok(state.players[PLAYER.WHITE].resource_hand_ids.includes(untappedId));
  assert.ok(state.players[PLAYER.GREEN].resource_hand_ids.includes(tappedId));
  assert.ok(state.players[PLAYER.RED].court_noble_ids.includes("NC-J-H-B"));
  assert.equal(state.players[PLAYER.BLACK].dungeon_noble_id, null);
  assert.ok(state.decks[DECK.NOBLE].includes("NC-Q-D-B"));
  assert.ok(state.decks[DECK.NOBLE].includes("NC-Q-C-A"));
  assert.equal(liveUnits(state, PLAYER.GREEN).length, 0);

  state = must(state, { type: "CHOOSE_CONQUEST", player: PLAYER.WHITE, choice: "HOLDING" });
  const capturedQueen = state.units_by_id["GREEN-QUEEN"];
  assert.equal(capturedQueen.owner, PLAYER.WHITE);
  assert.equal(capturedQueen.piece_color, PLAYER.GREEN);
  assert.equal(capturedQueen.square, "h1");
  assert.equal(capturedQueen.irreplaceable, true);
  assert.equal(state.units_by_id["WHITE-ATTACKER"].square, "g1", "attacker does not displace the captured capital");
  assert.ok(state.decks[DECK.NOBLE].includes("NC-K-C-A"));
  assert.equal(state.players[PLAYER.GREEN].advises_player, PLAYER.WHITE);
  assert.equal(state.players[PLAYER.GREEN].advice_until_unit_id, "GREEN-QUEEN");
  assert.ok(!state.phase_actor_order.includes(PLAYER.GREEN));
  assert.deepEqual(validateInvariants(state), []);
});

test("taking the Sovereign advances a victorious attacker and places the Card in Court", () => {
  let state = findKingDefeat("ATTACKER_WIN", (candidate) => {
    addUnit(candidate, PLAYER.GREEN, UNIT_TYPE.QUEEN, "f2", { unitId: "GREEN-QUEEN" });
  });
  state = must(state, { type: "CHOOSE_CONQUEST", player: PLAYER.WHITE, choice: "CARD" });
  assert.equal(state.units_by_id["WHITE-ATTACKER"].square, "h1");
  assert.ok(state.players[PLAYER.WHITE].court_noble_ids.includes("NC-K-C-A"));
  assert.equal(state.nobles_by_id["NC-K-C-A"].owner, PLAYER.WHITE);
  assert.equal(state.units_by_id["GREEN-QUEEN"].defeated, true);
  assert.equal(state.players[PLAYER.GREEN].advises_player, PLAYER.WHITE);
  assert.equal(state.players[PLAYER.GREEN].advice_until_unit_id, null);
});

test("when an attacking King falls, the captured Queen occupies its vacated origin and play continues with the next survivor", () => {
  let state = findKingDefeat("DEFENDER_WIN");
  assert.equal(state.pending_conquest.defeated_player, PLAYER.WHITE);
  assert.equal(state.pending_conquest.victor, PLAYER.GREEN);
  assert.equal(state.button_holder, PLAYER.WHITE, "an eliminated Button remains in place for the current Year");
  state = must(state, { type: "CHOOSE_CONQUEST", player: PLAYER.GREEN, choice: "HOLDING" });
  const capturedQueen = liveUnits(state, PLAYER.GREEN).find((unit) => unit.captured_from === PLAYER.WHITE);
  assert.equal(capturedQueen.square, "g1");
  assert.equal(state.units_by_id["U-G-001"].square, "h1");
  assert.equal(state.current_actor, PLAYER.RED);
  assert.deepEqual(phaseOrderFromButton(state), [PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]);

  state = forcePhase(state, PHASE.STOCKPILE, PLAYER.RED);
  for (const player of [PLAYER.RED, PLAYER.BLACK, PLAYER.GREEN]) {
    state = must(state, { type: "CHOOSE_STOCKPILE", player, card_ids: [] });
  }
  assert.equal(state.button_holder, PLAYER.RED, "the Button passes clockwise from the eliminated White seat");
  assert.equal(state.year_number, 2);
});

test("a captured Queen is permanently removed and its defeated player stops advising when it falls", () => {
  let state = findKingDefeat("ATTACKER_WIN", (candidate) => {
    addUnit(candidate, PLAYER.GREEN, UNIT_TYPE.QUEEN, "f2", { unitId: "GREEN-QUEEN" });
  });
  state = must(state, { type: "CHOOSE_CONQUEST", player: PLAYER.WHITE, choice: "HOLDING" });
  const whiteQueenReserve = state.players[PLAYER.WHITE].reserve[UNIT_TYPE.QUEEN];
  let resolved = null;
  for (let index = 1; index < 180; index += 1) {
    const candidate = forcePhase(structuredClone(state), PHASE.SIEGE, PLAYER.BLACK);
    candidate.rng_state = index;
    addUnit(candidate, PLAYER.BLACK, UNIT_TYPE.QUEEN, "g2", { vassalId: "NC-K-D-B", unitId: "BLACK-ATTACKER" });
    givePool(candidate, PLAYER.BLACK, SUIT.SPADES, 99);
    const result = dispatch(candidate, {
      type: "LAY_SIEGE",
      player: PLAYER.BLACK,
      attacker_id: "BLACK-ATTACKER",
      defender_id: "GREEN-QUEEN",
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    const combat = result.events.find((event) => event.type === "CombatResolved");
    if (combat.payload.outcome === "ATTACKER_WIN") {
      resolved = result.state;
      break;
    }
  }
  assert.ok(resolved, "a deterministic attacker victory was found");
  assert.equal(resolved.units_by_id["GREEN-QUEEN"].defeated, true);
  assert.equal(resolved.players[PLAYER.WHITE].reserve[UNIT_TYPE.QUEEN], whiteQueenReserve);
  assert.equal(resolved.players[PLAYER.GREEN].advises_player, null);
  assert.equal(resolved.players[PLAYER.GREEN].advice_until_unit_id, null);
});

test("the match completes only after conquest leaves a single surviving King", () => {
  let state = findKingDefeat("ATTACKER_WIN", (candidate) => {
    for (const player of [PLAYER.BLACK, PLAYER.RED]) {
      const king = liveUnits(candidate, player).find((unit) => unit.unit_type === UNIT_TYPE.KING);
      king.defeated = true;
      king.square = null;
      candidate.players[player].unit_ids = candidate.players[player].unit_ids.filter((id) => id !== king.unit_id);
      candidate.players[player].eliminated = true;
    }
    candidate.phase_actor_order = [PLAYER.WHITE, PLAYER.GREEN];
  });
  assert.equal(state.status, "ACTIVE");
  state = must(state, { type: "CHOOSE_CONQUEST", player: PLAYER.WHITE, choice: "CARD" });
  assert.equal(state.status, "COMPLETE");
  assert.equal(state.winner, PLAYER.WHITE);
  assert.equal(state.victory_reason, "LAST_KING_STANDING");
  assert.equal(liveUnits(state).filter((unit) => unit.unit_type === UNIT_TYPE.KING).length, 1);
  assert.deepEqual(validateInvariants(state), []);
});
