import test from "node:test";
import assert from "node:assert/strict";
import { DECK, PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { newMatch, dispatch, settleAutomaticPhases, replayCommandLog, upgradeToV15 } from "../src/engine.js";
import { availablePokerHands, orderedHarvestUnits, validateInvariants } from "../src/rules.js";
import { formatChronicle } from "../src/notation.js";
import { projectForPlayer, projectSpectator } from "../src/projection.js";
import { realmComparisonHtml, harvestListHtml } from "../src/presentation.js";
import { RoomStore } from "../src/rooms.js";
import { addUnit, forcePhase, givePool, giveResource, must, setUpMatch } from "./helpers.js";

const modern = (seed = "v15") => setUpMatch(seed, { automatic_passes: true, harvest_order: "STANDARD_V15" });
function top(state, deck, ids) { state.decks[deck] = [...ids, ...state.decks[deck].filter((id) => !ids.includes(id))]; }
function putInCourt(state, player, id) {
  state.decks.NOBLE = state.decks.NOBLE.filter((card) => card !== id);
  state.players[player].court_noble_ids.push(id);
  Object.assign(state.nobles_by_id[id], { owner: player, location: `${player}_COURT`, assigned_unit_id: null });
}

for (const [player, expected] of [[PLAYER.WHITE, ["h6", "h2", "f7", "f3"]], [PLAYER.GREEN, ["f7", "h6", "f3", "h2"]], [PLAYER.BLACK, ["h2", "f3", "h6", "f7"]], [PLAYER.RED, ["h2", "h6", "f3", "f7"]]]) {
  test(`${player} uses its agreed coordinate keys after status and Level`, () => {
    const state = newMatch({ playerCount: 4 });
    for (const square of ["h2", "f7", "f3", "h6"]) addUnit(state, player, UNIT_TYPE.PAWN, square);
    addUnit(state, player, UNIT_TYPE.ROOK, "g5");
    const levy = addUnit(state, player, UNIT_TYPE.PAWN, "d3");
    state.units_by_id[levy].vassal_noble_id = "dummy-for-sort";
    state.units_by_id[`U-${player[0]}-001`].vassal_noble_id = "dummy-for-sort";
    assert.deepEqual(orderedHarvestUnits(state, player).map((unit) => unit.square).slice(0, 6), [...expected, "g5", "d3"]);
  });
}

test("each Harvest piece needs its own draw command, even if an old client asks to continue", () => {
  let state = newMatch({ seed: "manual-harvest" });
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "f3");
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "h2");
  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.BLACK, noble_id: "NC-K-S" });
  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.WHITE, noble_id: "NC-K-H" });
  const queue = [...state.harvest.ordered_unit_ids];
  const rejected = dispatch(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: queue[1], deck: DECK.RED });
  assert.equal(rejected.error.code, "HARVEST_ORDER_REQUIRED");
  assert.deepEqual(rejected.state, state);
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: queue[0], deck: DECK.BLACK, auto_harvest: true });
  assert.equal(state.players.WHITE.resource_hand_ids.length, 1);
  assert.deepEqual(state.harvest.remaining_unit_ids, queue.slice(1));
  assert.deepEqual(state.harvest.ordered_unit_ids, queue);
  assert.deepEqual(state.harvest.offer_ids, []);
  const html = harvestListHtml(state);
  assert.equal((html.match(/class="harvest-number"/g) ?? []).length, 3);
  assert.match(html, /✓ Harvested/);
  assert.doesNotMatch(html, /draw \d|keep \d|Rank/);
});

test("declining the Harvest failsafe does not draw for any piece", () => {
  let state = modern();
  state.units_by_id["U-W-001"].square = "a8";
  state.harvest.failsafe_pending = true;
  state = must(state, { type: "RESOLVE_HARVEST_FAILSAFE", player: PLAYER.WHITE, use: false, auto_harvest: true });
  assert.equal(state.players.WHITE.resource_hand_ids.length, 0);
  assert.deepEqual(state.harvest.offer_ids, []);
});

test("Poker appears only for legal face-value hands and preserves optional overlapping declarations", () => {
  let state = modern();
  state.harvest.stage = "POKER";
  const a = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 5, { counter: true });
  const b = giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 5);
  const c = giveResource(state, PLAYER.WHITE, SUIT.SPADES, 5);
  assert.equal(availablePokerHands(state).length, 4);
  assert.ok(availablePokerHands(state).some((hand) => hand.kind === "THREE_OF_A_KIND"));
  state = must(state, { type: "DECLARE_POKER", player: PLAYER.WHITE, card_ids: [a, b] });
  assert.equal(state.harvest.stage, "POKER");
  assert.ok(availablePokerHands(state).some((hand) => hand.card_ids.includes(c)));
  assert.ok(!availablePokerHands(state).some((hand) => hand.card_ids.length === 2 && hand.card_ids.includes(a) && hand.card_ids.includes(b)));
  state = must(state, { type: "DECLARE_POKER", player: PLAYER.WHITE, card_ids: [b, c] });
  assert.equal(state.phase, PHASE.BUILD, "resolved declarations automatically finish when none can add a bonus");
  assert.ok(state.automatic_notices.some((notice) => notice.section === "POKER"));
});

test("Poker availability respects the no-overlap rule and face values rather than Counters", () => {
  const state = modern();
  const a = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 4, { counter: true });
  giveResource(state, PLAYER.WHITE, SUIT.SPADES, 5);
  assert.deepEqual(availablePokerHands(state), []);
  giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 4);
  state.rules.poker_overlap_allowed = false;
  state.harvest.poker_used_ids = [a];
  assert.deepEqual(availablePokerHands(state), []);
});

test("unavailable whole seasons pass through every player and stop at a funded legal action", () => {
  const state = modern();
  giveResource(state, PLAYER.WHITE, SUIT.SPADES, 9);
  forcePhase(state, PHASE.BUILD);
  settleAutomaticPhases(state);
  assert.equal(state.phase, PHASE.MOBILIZE);
  assert.equal(state.current_actor, PLAYER.WHITE);
  assert.equal(state.phase_notice, null);
  assert.deepEqual(state.automatic_notices.filter((notice) => notice.player === PLAYER.WHITE).map((notice) => notice.section), [PHASE.BUILD, PHASE.UPGRADE, PHASE.RANSOM, PHASE.RECRUIT]);
  assert.deepEqual(state.automatic_notices.map((n) => n.sequence), [...state.automatic_notices].sort((a,b) => a.sequence - b.sequence).map((n) => n.sequence));
  assert.ok(state.event_log.some((event) => event.type === "SeasonCleaned" && event.payload.suit === SUIT.DIAMONDS));
});

test("an empty pool does not skip an action fundable by untapped cards", () => {
  const state = modern();
  giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 2);
  forcePhase(state, PHASE.BUILD);
  settleAutomaticPhases(state);
  assert.equal(state.current_actor, PLAYER.WHITE);
  assert.equal(state.phase, PHASE.BUILD);
  assert.equal(state.automatic_notices?.length ?? 0, 0);
});

test("Stockpile automatically retains all legal cards, preserves Counters, and advances the Year", () => {
  const state = modern();
  const kept = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8, { counter: true });
  giveResource(state, PLAYER.BLACK, SUIT.SPADES, 9);
  forcePhase(state, PHASE.STOCKPILE);
  const voluntary = dispatch(state, { type: "CHOOSE_STOCKPILE", player: PLAYER.WHITE, card_ids: [] });
  assert.equal(voluntary.error.code, "VOLUNTARY_DISCARD_DISABLED");
  settleAutomaticPhases(state);
  assert.equal(state.year_number, 2);
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.ok(state.resources_by_id[kept].has_counter);
  assert.ok(state.players.WHITE.resource_hand_ids.includes(kept));
  assert.match(formatChronicle(state), /Stockpile\nWhite: \(8C\*\)\nBlack: \(9S\)/);
});

test("Stockpile keeps the player's decision for overflow and mandatory-spend cards", () => {
  for (const mandatory of [false, true]) {
    const state = modern();
    const a = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 3);
    if (mandatory) state.resources_by_id[a].mandatory_spend_year = state.year_number;
    else { giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 5); giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8); }
    forcePhase(state, PHASE.STOCKPILE);
    settleAutomaticPhases(state);
    assert.equal(state.phase, PHASE.STOCKPILE);
    assert.equal(state.current_actor, PLAYER.WHITE);
    assert.equal(state.automatic_notices?.length ?? 0, 0);
  }
});

test("an unaffordable Ransom response advances to a captor who can choose", () => {
  const state = modern();
  forcePhase(state, PHASE.RANSOM, PLAYER.WHITE);
  const id = "NC-J-C";
  state.decks.NOBLE = state.decks.NOBLE.filter((candidate) => candidate !== id);
  Object.assign(state.nobles_by_id[id], { owner: PLAYER.WHITE, location: "BLACK_DUNGEON" });
  state.players.BLACK.dungeon_noble_id = id;
  state.active_ransom = { owner: PLAYER.WHITE, captor: PLAYER.BLACK, noble_id: id, stage: "OWNER" };
  giveResource(state, PLAYER.BLACK, SUIT.DIAMONDS, 9);
  settleAutomaticPhases(state);
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.equal(state.phase, PHASE.RANSOM);
  assert.equal(state.active_ransom.stage, "CAPTOR");
  assert.match(state.automatic_notices[0].reason, /unaffordable/);
});

test("auto-passing publishes an exhausted turn and ends its Undo history on the server", () => {
  const store = new RoomStore({ codeFactory: () => "AUTO15" });
  const white = store.create({ playerCount: 2, playerName: "White", seat: PLAYER.WHITE });
  const black = store.join(white.code, { playerName: "Black", seat: PLAYER.BLACK });
  store.start(white.code, white.token);
  const state = modern();
  forcePhase(state, PHASE.BUILD);
  givePool(state, PLAYER.WHITE, SUIT.CLOVERS, 2);
  store.get(white.code).committed_state = state;
  const view = store.command(white.code, white.token, { type: "BUILD_UNIT", square: "b2" });
  assert.equal(view.viewer.can_undo, false);
  assert.equal(view.viewer.waiting_for_pass, false);
  assert.equal(view.game.year_number, 2);
  assert.equal(view.game.current_actor, PLAYER.BLACK);
  assert.ok(Object.values(store.view(white.code, black.token).game.units_by_id).some((unit) => unit.square === "b2"));
  assert.ok(view.game.automatic_notices.length > 0);
});

test("complete Harvest offers are public while unrevealed Court identities stay private", () => {
  let state = modern();
  top(state, DECK.RED, ["RC-H-09", "RC-D-03", "RC-H-04"]);
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.RED });
  assert.deepEqual(projectSpectator(state).harvest.offer_ids, state.harvest.offer_ids);
  assert.ok(projectForPlayer(state, PLAYER.BLACK).resources_by_id["RC-D-03"]);
  state = must(state, { type: "KEEP_HARVEST_CARD", player: PLAYER.WHITE, card_id: "RC-H-09" });
  putInCourt(state, PLAYER.WHITE, "NC-J-C");
  const other = projectForPlayer(state, PLAYER.BLACK);
  assert.match(formatChronicle(other), /White: \(9H\*\) 3D 4H\*/);
  assert.equal(other.nobles_by_id["NC-J-C"], undefined);
  assert.equal(other.players.WHITE.court_noble_ids.length, 1);
});

test("the shared realm panel shows pieces, Vassals and Dungeons without leaking another Court", () => {
  const state = modern();
  addUnit(state, PLAYER.WHITE, UNIT_TYPE.PAWN, "b2");
  putInCourt(state, PLAYER.WHITE, "NC-J-C");
  const publicHtml = realmComparisonHtml(state, PLAYER.BLACK);
  assert.match(publicHtml, /aria-label="Pawn"/);
  assert.match(publicHtml, /CLEOPATRA/);
  assert.match(publicHtml, /1 hidden card/);
  assert.doesNotMatch(publicHtml, /COLBERT|NC-J-C/);
  assert.match(realmComparisonHtml(state, PLAYER.WHITE), /COLBERT/);
  assert.doesNotMatch(publicHtml, /Rank|rank-pips|physical-rank/);
});

test("v1.4 offers migrate without redrawing and migrated command histories replay exactly", () => {
  let state = setUpMatch("migrate-15");
  state = must(state, { type: "DRAW_HARVEST", player: PLAYER.WHITE, unit_id: "U-W-001", deck: DECK.BLACK });
  const offer = [...state.harvest.offer_ids];
  state = upgradeToV15(state);
  assert.deepEqual(state.harvest.offer_ids, offer);
  assert.deepEqual(replayCommandLog(state), state);
  assert.match(formatChronicle(state), /Ka1\*RxH/);
  assert.doesNotMatch(formatChronicle(state), /Ka1\*KH/);
});

for (const playerCount of [2,4]) test(`${playerCount}-player automatic Years replay deterministically`, () => {
  let state = newMatch({ playerCount, seed: `whole-year-${playerCount}`, matchId: `V15-${playerCount}` });
  for (let step = 0; step < 100 && state.year_number < 3; step++) {
    const player = state.current_actor;
    let command;
    if (state.status === "SETUP") command = { type: "CHOOSE_SOVEREIGN", noble_id: state.sovereign_pool_ids[0] };
    else if (state.harvest?.stage === "DRAW") {
      if (state.harvest.failsafe_pending) command = { type: "RESOLVE_HARVEST_FAILSAFE", use: false };
      else if (state.harvest.offer_ids.length) command = { type: "KEEP_HARVEST_CARD", card_id: state.harvest.offer_ids[0] };
      else command = { type: "DRAW_HARVEST", unit_id: state.harvest.remaining_unit_ids[0], deck: DECK.BLACK };
    } else if (state.harvest?.stage === "POKER") command = { type: "FINISH_POKER" };
    else if (state.phase === PHASE.STOCKPILE) command = { type: "CHOOSE_STOCKPILE", card_ids: [] };
    else if (state.phase === PHASE.RANSOM) command = { type: "RESPOND_RANSOM", pay: false };
    else command = { type: "PASS_PHASE" };
    state = must(state, { ...command, player });
  }
  assert.equal(state.year_number, 3);
  assert.deepEqual(validateInvariants(state), []);
  assert.deepEqual(replayCommandLog(state), state);
  assert.match(formatChronicle(state), /\nStockpile\n/);
});

test("dispersing a defeated Court exposes counts without disclosing unrevealed identities", () => {
  const state = modern();
  state.event_log.push({ type: "DefeatedCourtDispersed", visibility: "PUBLIC", actor: PLAYER.WHITE,
    payload: { defeated_player: PLAYER.WHITE, noble_ids: ["NC-J-C", "NC-Q-D"] } });
  const other = projectForPlayer(state, PLAYER.BLACK).event_log.at(-1);
  assert.deepEqual(other.payload, { defeated_player: PLAYER.WHITE, returned_count: 2 });
  assert.deepEqual(projectForPlayer(state, PLAYER.WHITE).event_log.at(-1).payload.noble_ids, ["NC-J-C", "NC-Q-D"]);
});
