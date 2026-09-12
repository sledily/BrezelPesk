import { DECK, PHASE, PLAYER, SUIT, UNIT_TYPE } from "../src/constants.js";
import { dispatch, newMatch } from "../src/engine.js";
import { matchPlayers, phaseOrderFromButton } from "../src/model.js";
import { deckForSuit } from "../src/rules.js";

export function must(state, command) {
  const result = dispatch(state, command);
  if (!result.ok) {
    throw new Error(`${command.type} failed: ${result.error.code} — ${result.error.message}`);
  }
  return result.state;
}

export const LEGACY_RULES = { automatic_passes: false, harvest_order: "STANDARD_V1", ruleset_version: "1.2-digital-1.4" };

export function setUpMatch(seed = "test", rules = LEGACY_RULES) {
  let state = newMatch({ seed, matchId: `TEST-${seed}`, rules });
  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.BLACK, noble_id: "NC-K-S" });
  state = must(state, { type: "CHOOSE_SOVEREIGN", player: PLAYER.WHITE, noble_id: "NC-K-H" });
  return state;
}

export function setUpFourPlayerMatch(seed = "four-player") {
  let state = newMatch({ seed, matchId: `TEST-${seed}`, playerCount: 4, rules: LEGACY_RULES });
  const choices = [
    [PLAYER.GREEN, "NC-K-C-A"],
    [PLAYER.BLACK, "NC-K-D-A"],
    [PLAYER.RED, "NC-K-S-A"],
    [PLAYER.WHITE, "NC-K-H-A"],
  ];
  for (const [player, nobleId] of choices) {
    state = must(state, { type: "CHOOSE_SOVEREIGN", player, noble_id: nobleId });
  }
  return state;
}

export function giveResource(state, player, suit, faceValue, { counter = false, tapped = false } = {}) {
  const card = Object.values(state.resources_by_id).find(
    (candidate) => candidate.suit === suit
      && candidate.face_value === faceValue
      && state.decks[deckForSuit(suit)].includes(candidate.card_id),
  );
  if (!card) throw new Error(`No ${faceValue} ${suit} remains in deck`);
  const deck = deckForSuit(suit);
  state.decks[deck] = state.decks[deck].filter((id) => id !== card.card_id);
  card.location = `${player}_HAND`;
  card.has_counter = counter;
  card.tapped = tapped;
  state.players[player].resource_hand_ids.push(card.card_id);
  return card.card_id;
}

export function addUnit(state, player, type, square, { vassalId = null, unitId = null } = {}) {
  const id = unitId ?? `FIX-${player}-${square}`;
  state.units_by_id[id] = {
    unit_id: id,
    owner: player,
    piece_color: player,
    unit_type: type,
    square,
    vassal_noble_id: vassalId,
    defeated: false,
    irreplaceable: false,
    captured_from: null,
  };
  state.players[player].unit_ids.push(id);
  if (state.players[player].reserve[type] > 0) state.players[player].reserve[type] -= 1;
  if (vassalId) {
    const noble = state.nobles_by_id[vassalId];
    state.decks[DECK.NOBLE] = state.decks[DECK.NOBLE].filter((nobleId) => nobleId !== vassalId);
    state.players[player].court_noble_ids = state.players[player].court_noble_ids.filter((nobleId) => nobleId !== vassalId);
    noble.owner = player;
    noble.location = "ASSIGNED";
    noble.assigned_unit_id = id;
  }
  return id;
}

export function forcePhase(state, phase, actor = PLAYER.WHITE) {
  state.status = "ACTIVE";
  state.phase = phase;
  state.current_actor = actor;
  const baseOrder = phaseOrderFromButton(state);
  const actorIndex = baseOrder.indexOf(actor);
  state.phase_actor_order = actorIndex < 0
    ? matchPlayers(state).filter((player) => !state.players[player].eliminated)
    : [...baseOrder.slice(actorIndex), ...baseOrder.slice(0, actorIndex)];
  state.passed_players = [];
  state.harvest = null;
  state.active_ransom = null;
  state.pending_combat = null;
  state.phase_notice = null;
  return state;
}

export function dismissPhaseNotice(state) {
  if (!state.phase_notice) return state;
  return must(state, { type: "ACKNOWLEDGE_PHASE_NOTICE", player: state.current_actor });
}

export function givePool(state, player, suit, value) {
  state.players[player].seasonal_pools[suit] = value;
  return state;
}

export function harvestBothKings(state) {
  for (const player of [PLAYER.WHITE, PLAYER.BLACK]) {
    const unitId = state.harvest.remaining_unit_ids[0];
    state = must(state, { type: "DRAW_HARVEST", player, unit_id: unitId, deck: DECK.BLACK });
    state = must(state, { type: "KEEP_HARVEST_CARD", player, card_id: state.harvest.offer_ids[0] });
  }
  state = must(state, { type: "FINISH_POKER", player: PLAYER.WHITE });
  state = must(state, { type: "FINISH_POKER", player: PLAYER.BLACK });
  if (state.phase !== PHASE.BUILD) throw new Error("Harvest did not advance to Build");
  return state;
}

export { PHASE, PLAYER, SUIT, UNIT_TYPE };
