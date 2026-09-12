import test from "node:test";
import assert from "node:assert/strict";
import { UNIT_TYPE } from "../src/constants.js";
import { nextRandom, shuffleWithState } from "../src/rng.js";
import {
  isBlackSquare,
  isCenter,
  legalMovementDestinations,
  legalMovementPaths,
  parseSquare,
  pokerKindForCards,
  validateInvariants,
} from "../src/rules.js";
import { addUnit, setUpMatch } from "./helpers.js";

test("board coordinates use the authoritative a1 dark convention", () => {
  assert.deepEqual(parseSquare("a1"), { x: 0, y: 0 });
  assert.equal(isBlackSquare("a1"), true);
  assert.equal(isBlackSquare("h8"), true);
  assert.equal(isBlackSquare("a2"), false);
  assert.equal(isCenter("d4"), true);
  assert.equal(isCenter("c4"), false);
});

test("seeded randomness and shuffling are reproducible", () => {
  assert.deepEqual(nextRandom(123), nextRandom(123));
  assert.deepEqual(shuffleWithState([1, 2, 3, 4, 5], 987), shuffleWithState([1, 2, 3, 4, 5], 987));
  assert.notDeepEqual(shuffleWithState([1, 2, 3, 4, 5], 987).items, [1, 2, 3, 4, 5]);
});

test("movement models Dendarv movement rather than ordinary chess", () => {
  const state = setUpMatch("movement");
  const rookId = addUnit(state, "WHITE", UNIT_TYPE.ROOK, "d4", { vassalId: "NC-J-C" });
  addUnit(state, "BLACK", UNIT_TYPE.PAWN, "d5");
  const rookDestinations = legalMovementDestinations(state, rookId);
  assert.ok(rookDestinations.includes("f4"));
  assert.ok(rookDestinations.includes("e3"), "Rook may turn after its first orthogonal step");
  assert.ok(!rookDestinations.includes("d6"), "non-Knight may not pass through occupied d5");

  const knightId = addUnit(state, "WHITE", UNIT_TYPE.KNIGHT, "b2", { vassalId: "NC-J-D" });
  addUnit(state, "BLACK", UNIT_TYPE.PAWN, "c3");
  const knightPaths = legalMovementPaths(state, knightId);
  assert.ok(
    knightPaths.some((path) => path.join("-") === "b2-c3-d2"),
    "Knight may jump its abstract intermediate square",
  );
});

test("Poker qualification uses face values only", () => {
  const state = setUpMatch("poker");
  const ids = Object.values(state.resources_by_id).filter((card) => card.face_value === 7).slice(0, 3).map((card) => card.card_id);
  state.resources_by_id[ids[0]].has_counter = true;
  assert.equal(pokerKindForCards(state, ids.slice(0, 2)), "PAIR");
  assert.equal(pokerKindForCards(state, ids), "THREE_OF_A_KIND");
});

test("fresh setup satisfies core invariants", () => {
  assert.deepEqual(validateInvariants(setUpMatch("invariants")), []);
});
