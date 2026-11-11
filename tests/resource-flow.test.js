import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK, PHASE, PLAYER, SUIT, SUITS, UNIT_TYPE, V2_RULES } from '../src/constants.js';
import { dispatch, replayCommandLog, settleAutomaticPhases, turnBoundaryCrossed } from '../src/engine.js';
import { autoStockpileIds, availablePokerHands, orderedHarvestUnits, stockpileInstructions, stockpilePlan, validateInvariants } from '../src/rules.js';
import { formatChronicle } from '../src/notation.js';
import { projectForPlayer, projectSpectator } from '../src/projection.js';
import { RoomStore } from '../src/rooms.js';
import { addUnit, forcePhase, giveResource, must, setUpMatch } from './helpers.js';

function setup(seed = 'resources') { return setUpMatch(seed, V2_RULES); }
function plan(state, player, cards, extras = {}) {
  return { type: 'SET_STOCKPILE_INSTRUCTIONS', player, instructions: {
    ...stockpileInstructions(state, player), manual_plan: { year: state.year_number, card_ids: cards }, ...extras,
  } };
}
function freezeQueue(state) {
  state.harvest.ordered_unit_ids = orderedHarvestUnits(state, state.current_actor).map(u => u.unit_id);
  state.harvest.remaining_unit_ids = [...state.harvest.ordered_unit_ids];
}
function moveDeckToHand(state, deck, player, keep = 0) {
  for (const id of state.decks[deck].splice(keep)) {
    state.players[player].resource_hand_ids.push(id);
    state.resources_by_id[id].location = `${player}_HAND`;
  }
}

test('V2 personal Harvest opens Poker before the next player draws and publishes only at Pass', () => {
  let state = setup();
  giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 7);
  giveResource(state, PLAYER.WHITE, SUIT.DIAMONDS, 7);
  state = must(state, { type: 'DRAW_HARVEST', player: PLAYER.WHITE, unit_id: 'U-W-001', deck: DECK.BLACK });
  const before = state;
  const result = dispatch(state, { type: 'KEEP_HARVEST_CARD', player: PLAYER.WHITE, card_id: state.harvest.offer_ids[0] });
  assert.equal(result.ok, true);
  state = result.state;
  assert.equal(state.harvest.stage, 'POKER');
  assert.equal(state.current_actor, PLAYER.WHITE);
  assert.equal(state.players.BLACK.resource_hand_ids.length, 0);
  assert.equal(turnBoundaryCrossed(before, state, result.events), false);
  state = must(state, { type: 'FINISH_POKER', player: PLAYER.WHITE });
  assert.equal(state.harvest.stage, 'DRAW');
  assert.equal(state.current_actor, PLAYER.BLACK);
});

test('Harvest holds rejects, exhausts the old deck first and gives an actual short offer without duplicates', () => {
  let state = setup('short-harvest');
  const rook = addUnit(state, PLAYER.WHITE, UNIT_TYPE.ROOK, 'b2');
  freezeQueue(state);
  moveDeckToHand(state, DECK.BLACK, PLAYER.BLACK, 3);
  const original = [...state.decks.BLACK];
  state = must(state, { type: 'DRAW_HARVEST', player: PLAYER.WHITE, unit_id: rook });
  state = must(state, { type: 'KEEP_HARVEST_CARD', player: PLAYER.WHITE, card_id: original[0] });
  assert.deepEqual(state.decks.BLACK, [original[2]], 'reject stays outside a nonempty deck');
  assert.equal(state.harvest.rejects[0].card_id, original[1]);
  assert.equal(state.resources_by_id[original[1]].location, 'HARVEST_REJECT');
  assert.deepEqual(validateInvariants(state), []);
  state = must(state, { type: 'DRAW_HARVEST', player: PLAYER.WHITE, unit_id: 'U-W-001', deck: DECK.BLACK });
  assert.deepEqual(state.harvest.offer_ids, [original[2], original[1]]);
  assert.equal(new Set(state.harvest.offer_ids).size, 2);
  assert.equal(state.harvest.rejects.length, 0);
  assert.equal(state.event_log.filter(e => e.type === 'HarvestSupplyShortage').at(-1).payload.available, 2);
  state = must(state, { type: 'KEEP_HARVEST_CARD', player: PLAYER.WHITE, card_id: original[2] });
  assert.ok(state.decks.BLACK.includes(original[1]), 'remaining rejects return at personal Harvest end');
  assert.deepEqual(validateInvariants(state), []);
});

test('one-card shortages keep automatically; an empty corner offer records the chosen deck and cannot draw fictitious cards', () => {
  let state = setup('one-card');
  moveDeckToHand(state, DECK.BLACK, PLAYER.BLACK, 1);
  const id = state.decks.BLACK[0];
  state = must(state, { type: 'DRAW_HARVEST', player: PLAYER.WHITE, unit_id: 'U-W-001', deck: DECK.BLACK });
  assert.deepEqual(state.players.WHITE.resource_hand_ids, [id]);
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.equal(state.automatic_notices?.some(n => n.section === 'POKER') ?? false, false);
  state = setup('empty');
  moveDeckToHand(state, DECK.BLACK, PLAYER.BLACK);
  state = must(state, { type: 'DRAW_HARVEST', player: PLAYER.WHITE, unit_id: 'U-W-001', deck: DECK.BLACK });
  assert.equal(state.players.WHITE.resource_hand_ids.length, 0);
  assert.match(formatChronicle(state), /White Harvest: \(\)@Black\nWhite Poker: \//);
  assert.deepEqual(validateInvariants(state), []);
});

test('Poker proposals omit all-countered groups, manual declarations remain legal and used physical cards cannot overlap', () => {
  let state = setup('poker');
  state.harvest.stage = 'POKER';
  const a = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 7, { counter: true });
  const b = giveResource(state, PLAYER.WHITE, SUIT.DIAMONDS, 7, { counter: true });
  const c = giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 7);
  const d = giveResource(state, PLAYER.WHITE, SUIT.SPADES, 7);
  assert.equal(availablePokerHands(state).some(h => h.card_ids.length === 2 && h.card_ids.includes(a) && h.card_ids.includes(b)), false);
  state = must(state, { type: 'DECLARE_POKER', player: PLAYER.WHITE, card_ids: [a, b] });
  assert.equal(state.resources_by_id[a].poker_used_year, 1);
  assert.equal(state.resources_by_id[a].mandatory_spend_year, 1);
  assert.equal(dispatch(state, { type: 'DECLARE_POKER', player: PLAYER.WHITE, card_ids: [a, c] }).ok, false);
  state = must(state, { type: 'DECLARE_POKER', player: PLAYER.WHITE, card_ids: [c, d] });
  assert.equal(availablePokerHands(state).length, 0);
  settleAutomaticPhases(state);
  assert.equal(state.harvest.stage, 'POKER', 'declaration requires explicit Pass even when exhausted');
});

test('Auto uses suit priorities and printed-value ties, with physical-card overrides and mandatory exclusions', () => {
  const state = setup('auto');
  const seven = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 7, { counter: true });
  const eight = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8);
  const nine = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 9);
  const h2 = giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 2);
  const h3 = giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 3);
  const settings = { ...stockpileInstructions(state, PLAYER.WHITE), mode: 'AUTO', suit_order: [SUIT.HEARTS, SUIT.CLOVERS, SUIT.DIAMONDS, SUIT.SPADES] };
  assert.deepEqual(new Set(autoStockpileIds(state, PLAYER.WHITE, settings)), new Set([nine, h3, h2]));
  settings.suit_order = [...SUITS];
  assert.deepEqual(new Set(autoStockpileIds(state, PLAYER.WHITE, settings)), new Set([nine, eight, h3]));
  settings.card_order = { CLOVERS: [seven] };
  state.resources_by_id[nine].mandatory_spend_year = 1;
  settings.suit_order = [SUIT.HEARTS, SUIT.CLOVERS, SUIT.DIAMONDS, SUIT.SPADES];
  assert.deepEqual(new Set(autoStockpileIds(state, PLAYER.WHITE, settings)), new Set([seven, h3, h2]));
});

test('Manual distinguishes missing from explicitly empty, permits voluntary discard and applies only at normal timing', () => {
  let state = setup('manual');
  const card = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8, { counter: true });
  forcePhase(state, PHASE.VASSALIZE);
  const rng = state.rng_state;
  state = must(state, plan(state, PLAYER.WHITE, []));
  assert.ok(state.players.WHITE.resource_hand_ids.includes(card));
  assert.equal(state.rng_state, rng);
  assert.equal(state.phase, PHASE.VASSALIZE);
  forcePhase(state, PHASE.STOCKPILE);
  settleAutomaticPhases(state);
  assert.equal(state.current_actor, PLAYER.BLACK, 'White exact empty plan resolves without another Pass');
  assert.equal(state.phase, PHASE.STOCKPILE, 'Black has no submission, not an empty submission');
  assert.equal(state.resources_by_id[card].has_counter, false);
  assert.ok(state.decks.BLACK.includes(card));
  state = must(state, plan(state, PLAYER.BLACK, []));
  assert.equal(state.year_number, 2);
});

test('capacity loss invalidates an exact Manual plan while Auto recomputes; one-Year override preserves standing Auto', () => {
  let state = setup('capacity');
  const rook = addUnit(state, PLAYER.WHITE, UNIT_TYPE.ROOK, 'b2');
  const cards = [giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 7), giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8),
    giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 7), giveResource(state, PLAYER.WHITE, SUIT.HEARTS, 8)];
  state = must(state, plan(state, PLAYER.WHITE, cards));
  state.units_by_id[rook].defeated = true;
  state.units_by_id[rook].square = null;
  forcePhase(state, PHASE.STOCKPILE);
  settleAutomaticPhases(state);
  assert.equal(state.current_actor, PLAYER.WHITE);
  assert.match(stockpilePlan(state, PLAYER.WHITE).error, /bonus/);
  assert.deepEqual(state.players.WHITE.resource_hand_ids, cards);
  state = must(state, plan(state, PLAYER.WHITE, [], { mode: 'AUTO', manual_year: 1 }));
  assert.equal(state.current_actor, PLAYER.BLACK);
  assert.equal(state.players.WHITE.resource_hand_ids.length, 0);
  state = must(state, plan(state, PLAYER.BLACK, []));
  assert.equal(stockpilePlan(state, PLAYER.WHITE).mode, 'AUTO');
});

test('private saved instructions never appear in opponent or spectator projections', () => {
  let state = setup('privacy');
  const card = giveResource(state, PLAYER.WHITE, SUIT.CLOVERS, 8);
  state = must(state, plan(state, PLAYER.WHITE, [card]));
  assert.deepEqual(projectForPlayer(state, PLAYER.WHITE).players.WHITE.stockpile_instructions.manual_plan.card_ids, [card]);
  for (const view of [projectForPlayer(state, PLAYER.BLACK), projectSpectator(state)]) {
    assert.equal(view.players.WHITE.stockpile_instructions, undefined);
    assert.deepEqual(view.event_log.at(-1).payload, { hidden: true });
  }
});

test('online planning while waiting neither publishes an active draft nor gets lost on Undo', () => {
  const store = new RoomStore();
  const host = store.create({ playerCount: 2, playerName: 'White', seed: 'waiting-plan' });
  const black = store.join(host.code, { playerName: 'Black', seat: PLAYER.BLACK });
  store.start(host.code, host.token);
  store.command(host.code, black.token, { type: 'CHOOSE_SOVEREIGN', noble_id: 'NC-K-S' });
  store.command(host.code, host.token, { type: 'CHOOSE_SOVEREIGN', noble_id: 'NC-K-H' });
  const room = store.get(host.code);
  forcePhase(room.committed_state, PHASE.BUILD);
  const whiteCard = giveResource(room.committed_state, PLAYER.WHITE, SUIT.CLOVERS, 8);
  const blackCard = giveResource(room.committed_state, PLAYER.BLACK, SUIT.HEARTS, 7);
  store.command(host.code, host.token, { type: 'TAP_RESOURCES', card_ids: [whiteCard] });
  store.command(host.code, black.token, plan(room.committed_state, PLAYER.BLACK, [blackCard]));
  assert.equal(store.view(host.code, black.token).game.resources_by_id[whiteCard].tapped, false);
  assert.equal(store.view(host.code, host.token).game.players.BLACK.stockpile_instructions, undefined);
  store.undo(host.code, host.token);
  assert.deepEqual(store.get(host.code).draft_state.players.BLACK.stockpile_instructions.manual_plan.card_ids, [blackCard]);
  assert.equal(store.get(host.code).draft_state.resources_by_id[whiteCard].tapped, false);
  assert.deepEqual(validateInvariants(store.get(host.code).draft_state), []);
});

test('V2 personal Harvest/Poker record order and saved preference commands replay exactly', () => {
  let state = setup('replay-flow');
  state = must(state, plan(state, PLAYER.BLACK, []));
  for (let n = 0; n < 12 && state.phase === PHASE.HARVEST; n++) {
    const player = state.current_actor;
    if (state.harvest.stage === 'POKER') state = must(state, { type: 'FINISH_POKER', player });
    else if (state.harvest.failsafe_pending) state = must(state, { type: 'RESOLVE_HARVEST_FAILSAFE', player, use: false });
    else if (state.harvest.offer_ids.length) state = must(state, { type: 'KEEP_HARVEST_CARD', player, card_id: state.harvest.offer_ids[0] });
    else state = must(state, { type: 'DRAW_HARVEST', player, unit_id: state.harvest.remaining_unit_ids[0], deck: DECK.BLACK });
  }
  assert.deepEqual(replayCommandLog(state), state);
  const record = formatChronicle(state);
  const positions = ['White Harvest:', 'White Poker:', 'Black Harvest:', 'Black Poker:'].map(label => record.indexOf(label));
  assert.ok(positions.every(n => n >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});
