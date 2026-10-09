import test from "node:test";
import assert from "node:assert/strict";
import { PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { dispatch, phaseAvailability } from "../src/engine.js";
import { formatNoble } from "../src/format.js";
import { recommendedStockpileIds, sortResourceCards } from "../src/rules.js";
import {
  addUnit,
  forcePhase,
  giveResource,
  must,
  setUpMatch,
} from "./helpers.js";

test("Resource displays sort by suit and descending effective value", () => {
  const state = setUpMatch("resource-order");
  const hearts = giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 10);
  const cloverLow = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 4, { counter: true });
  const cloverHigh = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8);
  const diamonds = giveResource(state, PLAYER.WHITE, SUIT.DIAMONDS, 7);
  const spades = giveResource(state, PLAYER.WHITE, SUIT.SPADES, 9);
  const sorted = sortResourceCards([hearts, cloverLow, diamonds, spades, cloverHigh]
    .map((id) => state.resources_by_id[id]));
  assert.deepEqual(sorted.map((card) => card.card_id), [cloverHigh, cloverLow, diamonds, spades, hearts]);
});

test("recommended Stockpile fills King, Rook, and Queen bonus slots with the strongest legal cards", () => {
  const state = forcePhase(setUpMatch("stockpile-recommendation"), PHASE.STOCKPILE, PLAYER.WHITE);
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.ROOK, "b2");
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.QUEEN, "c3");
  const cards = {
    c10: giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 10),
    c6: giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 6),
    d9: giveResource(state, PLAYER.WHITE, SUIT.DIAMONDS, 9),
    d5: giveResource(state, PLAYER.WHITE, SUIT.DIAMONDS, 5),
    s8: giveResource(state, PLAYER.WHITE, SUIT.SPADES, 8),
    s4: giveResource(state, PLAYER.WHITE, SUIT.SPADES, 4),
    h7: giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 7),
    h3: giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 3),
  };
  const illegalHighHeart = giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 10);
  state.resources_by_id[illegalHighHeart].mandatory_spend_year = state.year_number;
  const recommendation = recommendedStockpileIds(state, PLAYER.WHITE);
  assert.deepEqual(new Set(recommendation), new Set([
    cards.c10, cards.c6,
    cards.d9, cards.d5,
    cards.s8, cards.s4,
    cards.h7,
  ]));
  assert.ok(!recommendation.includes(illegalHighHeart));
});

test("phase preflight counts untapped cards and rejects purposeless cycling", () => {
  let state = forcePhase(setUpMatch("phase-preflight"), PHASE.BUILD, PLAYER.WHITE);
  giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 2);
  assert.equal(phaseAvailability(state, PLAYER.WHITE).available, true, "an untapped card can make Build affordable");

  state = forcePhase(state, PHASE.SIEGE, PLAYER.WHITE);
  const spade = giveResource(state, PLAYER.WHITE, SUIT.SPADES, 10);
  assert.equal(phaseAvailability(state, PLAYER.WHITE).available, false, "no adjacent target means no substantive Siege");
  const result = dispatch(state, { type: "TAP_RESOURCES", player: PLAYER.WHITE, card_ids: [spade] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PURPOSELESS_TAPPING");
});

test("unavailable player phases and prisonerless Ransom wait for acknowledgement", () => {
  let state = forcePhase(setUpMatch("phase-notices"), PHASE.UPGRADE, PLAYER.WHITE);
  state = must(state, { type: "PASS_PHASE", player: PLAYER.WHITE });
  assert.equal(state.phase_notice.player, PLAYER.BLACK);
  assert.equal(state.phase_notice.phase, PHASE.UPGRADE);
  const blocked = dispatch(state, { type: "PASS_PHASE", player: PLAYER.BLACK });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "PHASE_NOTICE_PENDING");

  state = must(state, { type: "ACKNOWLEDGE_PHASE_NOTICE", player: PLAYER.BLACK });
  assert.equal(state.phase, PHASE.RANSOM);
  assert.equal(state.phase_notice.scope, "GLOBAL");
  assert.equal(state.phase_notice.code, "NO_PRISONERS");

  state = must(state, { type: "ACKNOWLEDGE_PHASE_NOTICE", player: state.current_actor });
  assert.equal(state.phase, PHASE.RECRUIT);
});

test("Execution is globally skipped when both Dungeons are empty", () => {
  let state = forcePhase(setUpMatch("execution-notice"), PHASE.VASSALIZE, PLAYER.WHITE);
  state = must(state, { type: "PASS_PHASE", player: PLAYER.WHITE });
  state = must(state, { type: "ACKNOWLEDGE_PHASE_NOTICE", player: PLAYER.BLACK });
  assert.equal(state.phase, PHASE.EXECUTE);
  assert.equal(state.phase_notice.scope, "GLOBAL");
  assert.equal(state.phase_notice.code, "NO_PRISONERS");
});

test("Noble presentation uses the custom rank code and identity", () => {
  const state = setUpMatch("noble-display");
  const boudica = state.nobles_by_id["NC-K-C"];
  assert.equal(formatNoble(boudica), "Rx♧ · BOUDICA");
  assert.equal(boudica.name, "BOUDICA");
});
