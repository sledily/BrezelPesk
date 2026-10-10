import {
  ACTIVE_SUIT_BY_PHASE,
  DECK,
  NOBLE_FACE,
  PHASE,
  PHASE_ORDER,
  PLAYER,
  SUIT,
  SUITS,
  UNIT_TYPE,
} from "./constants.js";
import {
  createInitialState,
  deepClone,
  matchPlayers,
  newUnitId,
  nextSurvivingClockwise,
  phaseOrderFromButton,
  playerLocation,
  recordEvent,
  survivingPlayers,
} from "./model.js";
import { rollDice, shuffleWithState } from "./rng.js";
import {
  actionCost,
  areAdjacent,
  availableHoldingUnits,
  availablePokerHands,
  canAfford,
  currentSuit,
  deckForSquare,
  deckForSuit,
  deckSize,
  deriveConstants,
  drawCountOf,
  effectiveCardValue,
  hasBlackSquareUnit,
  hasUpgradeSupport,
  isCenter,
  isCorner,
  isLevy,
  legalMovementDestinations,
  legalSiegeTargets,
  liveUnits,
  orderedHarvestUnits,
  phaseAllowsTap,
  pokerKindForCards,
  pokerSelectionError,
  stockpileInstructions,
  stockpilePlan,
  sovereignCandidates,
  unitAt,
  validBuildTargets,
  validateInvariants,
  validateStockpile,
  validUpgradeTypes,
  usesStandardHarvestOrder,
} from "./rules.js";

export class RuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuleError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new RuleError(code, message, details);
}

function requireCondition(condition, code, message, details = {}) {
  if (!condition) fail(code, message, details);
}

function requireActor(state, player) {
  requireCondition(state.current_actor === player, "NOT_ACTIVE_PLAYER", `It is ${state.current_actor}'s decision`);
}

function requirePhase(state, phase) {
  requireCondition(state.phase === phase, "WRONG_PHASE", `This action is only legal during ${phase}`);
}

export function availableResourceValue(state, player, suit = ACTIVE_SUIT_BY_PHASE[state.phase]) {
  if (!suit) return 0;
  const handValue = state.players[player].resource_hand_ids
    .map((id) => state.resources_by_id[id])
    .filter((card) => card.suit === suit && !card.tapped)
    .reduce((sum, card) => sum + effectiveCardValue(card), 0);
  return state.players[player].seasonal_pools[suit] + handValue;
}

function phaseActionCandidates(state, player = state.current_actor) {
  switch (state.phase) {
    case PHASE.BUILD:
      if (state.players[player].reserve[UNIT_TYPE.PAWN] <= 0) return [];
      return validBuildTargets(state, player).map((square) => ({
        action: "BUILD",
        square,
        cost: actionCost(state, "BUILD", { actor: player }),
      }));
    case PHASE.UPGRADE:
      return liveUnits(state, player).flatMap((unit) => validUpgradeTypes(unit)
        .filter((toType) => state.players[player].reserve[toType] > 0)
        .filter((toType) => hasUpgradeSupport(state, unit, toType))
        .map((toType) => ({
          action: "UPGRADE",
          unit_id: unit.unit_id,
          to_type: toType,
          cost: actionCost(state, "UPGRADE", { actor: player, unit_id: unit.unit_id, to_type: toType }),
        })));
    case PHASE.RECRUIT:
      return deckSize(state, DECK.NOBLE) ? [{
        action: "RECRUIT",
        cost: actionCost(state, "RECRUIT", { actor: player }),
      }] : [];
    case PHASE.MOBILIZE:
      return liveUnits(state, player).filter(isLevy).flatMap((unit) => {
        const destinations = legalMovementDestinations(state, unit.unit_id);
        return destinations.length ? [{
          action: "MOBILIZE",
          unit_id: unit.unit_id,
          destinations,
          cost: actionCost(state, "MOBILIZE", { actor: player, unit_id: unit.unit_id }),
        }] : [];
      });
    case PHASE.SIEGE:
      return liveUnits(state, player).filter(isLevy).flatMap((unit) => (
        legalSiegeTargets(state, unit.unit_id).map((defenderId) => ({
          action: "SIEGE",
          attacker_id: unit.unit_id,
          defender_id: defenderId,
          cost: actionCost(state, "SIEGE", { actor: player, defender_id: defenderId }),
        }))
      ));
    case PHASE.VASSALIZE:
      return state.players[player].court_noble_ids.flatMap((nobleId) => (
        availableHoldingUnits(state, player).map((unit) => ({
          action: "VASSALIZE",
          noble_id: nobleId,
          unit_id: unit.unit_id,
          cost: actionCost(state, "VASSALIZE", { actor: player, noble_id: nobleId }),
        }))
      ));
    case PHASE.EXECUTE: {
      const nobleId = state.players[player].dungeon_noble_id;
      return nobleId ? [{
        action: "EXECUTE",
        noble_id: nobleId,
        cost: actionCost(state, "EXECUTE", { actor: player, noble_id: nobleId }),
      }] : [];
    }
    default: return [];
  }
}

function structuralUnavailabilityReason(state, player) {
  switch (state.phase) {
    case PHASE.BUILD:
      return state.players[player].reserve[UNIT_TYPE.PAWN] <= 0
        ? "No Pawn remains in reserve."
        : "No supported empty square is available for a new Holding.";
    case PHASE.UPGRADE:
      return "No Unit has a supported Upgrade with a matching reserve piece.";
    case PHASE.RECRUIT:
      return "The Noble Deck is empty.";
    case PHASE.MOBILIZE:
      return liveUnits(state, player).some(isLevy)
        ? "No Levy has a legal destination."
        : "The player controls no Levies.";
    case PHASE.SIEGE:
      return liveUnits(state, player).some(isLevy)
        ? "No Levy has an adjacent legal Siege target."
        : "The player controls no Levies.";
    case PHASE.VASSALIZE:
      if (!state.players[player].court_noble_ids.length) return "The player's Court is empty.";
      if (!availableHoldingUnits(state, player).length) return "The player has no unassigned Holding.";
      return "No legal Vassalization is available.";
    case PHASE.EXECUTE:
      return "The player's Dungeon is empty.";
    default:
      return "No legal action is available.";
  }
}

export function phaseAvailability(state, player = state.current_actor) {
  const candidates = phaseActionCandidates(state, player);
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase] ?? null;
  const available = availableResourceValue(state, player, suit);
  const affordable = candidates.filter((candidate) => candidate.cost <= available);
  if (affordable.length) {
    return { available: true, candidates, affordable, suit, resource_value: available, reason: null };
  }
  const reason = candidates.length
    ? `No legal action is affordable with the player's ${available} available ${suit.toLowerCase()}.`
    : structuralUnavailabilityReason(state, player);
  return { available: false, candidates, affordable, suit, resource_value: available, reason };
}

function setPhaseNotice(state, notice) {
  state.phase_notice = {
    scope: notice.player ? "PLAYER" : "GLOBAL",
    phase: state.phase,
    player: notice.player ?? null,
    reason: notice.reason,
    code: notice.code,
  };
  recordEvent(state, "PhaseUnavailable", state.phase_notice);
}

function refreshPhaseNotice(state) {
  if (state.rules.automatic_passes) return;
  if (state.status !== "ACTIVE" || state.phase_notice || state.pending_combat || state.pending_conquest || state.pending_resignation) return;
  if ([PHASE.HARVEST, PHASE.RANSOM, PHASE.STOCKPILE].includes(state.phase)) return;
  if (state.phase === PHASE.EXECUTE && survivingPlayers(state).every((player) => !state.players[player].dungeon_noble_id)) {
    setPhaseNotice(state, { code: "NO_PRISONERS", reason: "There are no prisoners in any surviving player's Dungeon." });
    return;
  }
  const availability = phaseAvailability(state, state.current_actor);
  if (!availability.available) {
    setPhaseNotice(state, {
      player: state.current_actor,
      code: "NO_LEGAL_ACTIONS",
      reason: availability.reason,
    });
  }
}

function spendPool(state, player, suit, cost) {
  const available = state.players[player].seasonal_pools[suit];
  requireCondition(available >= cost, "INSUFFICIENT_SEASONAL_POOL", `Requires ${cost} ${suit}; ${available} available`, {
    required: cost,
    available,
    suit,
  });
  state.players[player].seasonal_pools[suit] -= cost;
}

function shuffleDeck(state, deckName) {
  const shuffled = shuffleWithState(state.decks[deckName], state.rng_state);
  state.decks[deckName] = shuffled.items;
  state.rng_state = shuffled.state;
  return shuffled.items;
}

function setPhaseActors(state) {
  state.phase_actor_order = phaseOrderFromButton(state);
  state.current_actor = state.phase_actor_order[0];
  state.passed_players = [];
}

function nextActorInOrder(state, player, excluded = new Set()) {
  const order = state.phase_actor_order;
  const start = order.indexOf(player);
  for (let offset = 1; offset <= order.length; offset += 1) {
    const candidate = order[(Math.max(start, 0) + offset) % order.length];
    if (!candidate || state.players[candidate]?.eliminated || excluded.has(candidate)) continue;
    return candidate;
  }
  return null;
}

function initializeHarvestActor(state, player) {
  state.current_actor = player;
  state.harvest.stage = "DRAW";
  state.harvest.rejects = [];
  state.harvest.poker_used_ids = [];
  state.harvest.standard_order = usesStandardHarvestOrder(state);
  state.harvest.ordered_unit_ids = orderedHarvestUnits(state, player).map((unit) => unit.unit_id);
  state.harvest.remaining_unit_ids = [...state.harvest.ordered_unit_ids];
  state.harvest.offer_ids = [];
  state.harvest.unit_id = null;
  state.harvest.deck = null;
  state.harvest.failsafe_pending = state.rules.harvest_failsafe_enabled && !hasBlackSquareUnit(state, player);
}

function startHarvest(state) {
  state.phase = PHASE.HARVEST;
  state.phase_notice = null;
  setPhaseActors(state);
  state.harvest = {
    stage: "DRAW",
    completed_draw_players: [],
    completed_poker_players: [],
    remaining_unit_ids: [],
    offer_ids: [],
    unit_id: null,
    deck: null,
    failsafe_pending: false,
    poker_used_ids: [],
  };
  initializeHarvestActor(state, state.phase_actor_order[0]);
  recordEvent(state, "PhaseStarted", { phase: PHASE.HARVEST, actor_order: state.phase_actor_order });
}

function completeHarvestDrawForActor(state) {
  const player = state.current_actor;
  if (state.rules.resource_flow_v2) {
    returnHarvestRejects(state);
    state.harvest.completed_draw_players.push(player);
    recordEvent(state, "HarvestActorCompleted", { player });
    state.harvest.stage = "POKER";
    recordEvent(state, "PokerDeclarationsStarted", { player, actor_order: [player] });
    return;
  }
  state.harvest.completed_draw_players.push(player);
  recordEvent(state, "HarvestActorCompleted", { player });
  if (state.harvest.completed_draw_players.length < state.phase_actor_order.length) {
    initializeHarvestActor(state, nextActorInOrder(state, player, new Set(state.harvest.completed_draw_players)));
    return;
  }
  state.harvest.stage = "POKER";
  state.harvest.poker_used_ids = [];
  state.current_actor = state.phase_actor_order[0];
  recordEvent(state, "PokerDeclarationsStarted", { actor_order: state.phase_actor_order });
}

function returnHarvestRejects(state, onlyDeck = null) {
  const returning = (state.harvest.rejects ?? []).filter(item => !onlyDeck || item.deck === onlyDeck);
  const ids = new Set(returning.map(item => item.card_id));
  for (const { card_id, deck } of returning) {
    state.resources_by_id[card_id].location = `${deck}_DECK`;
    state.decks[deck].push(card_id);
  }
  state.harvest.rejects = (state.harvest.rejects ?? []).filter(item => !ids.has(item.card_id));
  for (const deck of new Set(returning.map(item => item.deck))) shuffleDeck(state, deck);
  if (ids.size) recordEvent(state, onlyDeck ? "HarvestRejectsRecycled" : "HarvestRejectsReturned", {
    player: state.current_actor, card_ids: [...ids], deck: onlyDeck,
  });
}

function finishEmptyHarvest(state, unit) {
  state.harvest.remaining_unit_ids = state.harvest.remaining_unit_ids.filter(id => id !== unit.unit_id);
  state.harvest.unit_id = null;
  state.harvest.deck = null;
  if (!state.harvest.remaining_unit_ids.length) completeHarvestDrawForActor(state);
}

function cleanupSeason(state, suit) {
  const returned = [];
  const deckName = deckForSuit(suit);
  for (const player of matchPlayers(state)) {
    const hand = state.players[player].resource_hand_ids;
    const keep = [];
    for (const cardId of hand) {
      const card = state.resources_by_id[cardId];
      if (card.suit === suit && card.tapped) {
        card.tapped = false;
        card.has_counter = false;
        card.mandatory_spend_year = null;
        card.poker_used_year = null;
        card.counter_sources = [];
        card.location = `${deckName}_DECK`;
        state.decks[deckName].push(cardId);
        returned.push(cardId);
      } else {
        keep.push(cardId);
      }
    }
    state.players[player].resource_hand_ids = keep;
    state.players[player].seasonal_pools[suit] = 0;
  }
  if (returned.length) shuffleDeck(state, deckName);
  recordEvent(state, "SeasonCleaned", { suit, returned_card_ids: returned, deck: deckName });
}

function startRansom(state) {
  state.ransom_queue = state.phase_actor_order.filter((captor) => state.players[captor].dungeon_noble_id);
  state.active_ransom = null;
  if (!state.ransom_queue.length) {
    if (state.rules.automatic_passes) return;
    setPhaseNotice(state, { code: "NO_PRISONERS", reason: "There are no prisoners in any Dungeon." });
    return;
  }
  nextRansomOffer(state);
}

function nextRansomOffer(state) {
  const captor = state.ransom_queue.shift();
  if (!captor) {
    state.active_ransom = null;
    startPhase(state, PHASE.RECRUIT);
    return;
  }
  const nobleId = state.players[captor].dungeon_noble_id;
  const noble = state.nobles_by_id[nobleId];
  const owner = noble.owner;
  state.active_ransom = { noble_id: nobleId, owner, captor, stage: "OWNER" };
  state.current_actor = owner;
  recordEvent(state, "RansomOffered", {
    noble_id: nobleId,
    owner,
    captor,
    cost: actionCost(state, "RANSOM", { actor: owner, noble_id: nobleId }),
  });
}

function startPhase(state, phase) {
  state.phase = phase;
  state.phase_notice = null;
  setPhaseActors(state);
  recordEvent(state, "PhaseStarted", { phase, actor_order: state.phase_actor_order });
  if (phase === PHASE.RANSOM) {
    startRansom(state);
    return;
  }
  if (phase === PHASE.STOCKPILE) state.stockpile_committed = {};
  refreshPhaseNotice(state);
}

function advancePhase(state) {
  const phase = state.phase;
  if (phase === PHASE.UPGRADE) cleanupSeason(state, SUIT.CLOVERS);
  if (phase === PHASE.RECRUIT) cleanupSeason(state, SUIT.DIAMONDS);
  if (phase === PHASE.SIEGE) cleanupSeason(state, SUIT.SPADES);
  if (phase === PHASE.EXECUTE) cleanupSeason(state, SUIT.HEARTS);
  const next = PHASE_ORDER[PHASE_ORDER.indexOf(phase) + 1];
  requireCondition(Boolean(next), "INVALID_PHASE_TRANSITION", `No phase follows ${phase}`);
  startPhase(state, next);
}

function chooseSovereign(state, command) {
  requireCondition(state.status === "SETUP", "WRONG_MATCH_STATUS", "Sovereigns are selected only during setup");
  const player = command.player;
  requireActor(state, player);
  const setupOrder = state.setup_order ?? [PLAYER.BLACK, PLAYER.WHITE];
  requireCondition(setupOrder[state.setup_index ?? 0] === player, "WRONG_SETUP_STEP", "The other Sovereign must be selected first");
  const noble = state.nobles_by_id[command.noble_id];
  requireCondition(noble?.face === NOBLE_FACE.KING && state.sovereign_pool_ids.includes(noble.noble_id), "INVALID_SOVEREIGN", "Select an available Rx Noble");
  const king = liveUnits(state, player).find((unit) => unit.unit_type === UNIT_TYPE.KING);
  king.vassal_noble_id = noble.noble_id;
  noble.location = "ASSIGNED";
  noble.owner = player;
  noble.assigned_unit_id = king.unit_id;
  state.sovereign_pool_ids = state.sovereign_pool_ids.filter((id) => id !== noble.noble_id);
  recordEvent(state, "SovereignChosen", { player, noble_id: noble.noble_id, unit_id: king.unit_id });

  state.setup_index = (state.setup_index ?? 0) + 1;
  if (state.setup_index < setupOrder.length) {
    state.current_actor = setupOrder[state.setup_index];
    state.setup_step = `${state.current_actor}_SOVEREIGN`;
    return;
  }

  for (const id of state.sovereign_pool_ids) {
    const unselected = state.nobles_by_id[id];
    unselected.location = "NOBLE_DECK";
    state.decks[DECK.NOBLE].push(id);
  }
  state.sovereign_pool_ids = [];
  shuffleDeck(state, DECK.NOBLE);
  state.status = "ACTIVE";
  state.setup_step = null;
  state.setup_index = null;
  state.year_number = 1;
  state.button_holder = PLAYER.WHITE;
  recordEvent(state, "SetupCompleted", { year: 1, button_holder: PLAYER.WHITE });
  startHarvest(state);
}

function resolveHarvestFailsafe(state, command) {
  requirePhase(state, PHASE.HARVEST);
  requireCondition(state.harvest?.stage === "DRAW" && state.harvest.failsafe_pending, "NO_FAILSAFE_DECISION", "No Harvest failsafe decision is pending");
  requireActor(state, command.player);
  if (!command.use) {
    state.harvest.failsafe_pending = false;
    recordEvent(state, "HarvestFailsafeDeclined", { player: command.player });
    return;
  }
  requireCondition(state.decks[DECK.BLACK].length >= 1, "DECK_EXHAUSTED", "The Black Resource Deck is empty");
  const cardId = state.decks[DECK.BLACK].shift();
  const card = state.resources_by_id[cardId];
  card.location = playerLocation(command.player, "HAND");
  state.players[command.player].resource_hand_ids.push(cardId);
  state.harvest.remaining_unit_ids = [];
  state.harvest.failsafe_pending = false;
  recordEvent(state, "HarvestFailsafeUsed", { player: command.player, card_id: cardId }, state.rules.automatic_passes ? "PUBLIC" : command.player);
  completeHarvestDrawForActor(state);
}

function drawHarvest(state, command) {
  requirePhase(state, PHASE.HARVEST);
  requireCondition(state.harvest?.stage === "DRAW", "WRONG_HARVEST_STAGE", "Resource draws are complete");
  requireActor(state, command.player);
  requireCondition(!state.harvest.failsafe_pending, "FAILSAFE_DECISION_REQUIRED", "Choose whether to use the Harvest failsafe first");
  requireCondition(state.harvest.offer_ids.length === 0, "HARVEST_CHOICE_PENDING", "Choose a card from the current Harvest offer first");
  requireCondition(state.harvest.remaining_unit_ids.includes(command.unit_id), "UNIT_ALREADY_HARVESTED", "Select a Unit that has not Harvested this Year");
  requireCondition(!state.harvest.standard_order || state.harvest.remaining_unit_ids[0] === command.unit_id,
    "HARVEST_ORDER_REQUIRED", "Harvest the next Unit in the fixed Holdings, Levies, Level and square order");
  const unit = state.units_by_id[command.unit_id];
  const requiredDeck = deckForSquare(unit.square);
  const deck = command.deck ?? requiredDeck;
  requireCondition([DECK.BLACK, DECK.RED].includes(deck), "INVALID_DECK", "Select the Red or Black Resource Deck");
  requireCondition(isCorner(unit.square) || deck === requiredDeck, "INVALID_HARVEST_DECK", "Only corner Units may choose either Resource Deck");
  const count = drawCountOf(unit);
  if (!state.rules.resource_flow_v2) requireCondition(state.decks[deck].length >= count, "DECK_EXHAUSTED", `${deck} does not contain ${count} cards`, { deck, required: count });
  const cardIds = state.decks[deck].splice(0, count);
  // Exhaust the existing deck before recycling only earlier rejects. The current
  // offer is never in the reject pool and cannot be drawn twice.
  if (state.rules.resource_flow_v2 && cardIds.length < count) {
    returnHarvestRejects(state, deck);
    cardIds.push(...state.decks[deck].splice(0, count - cardIds.length));
  }
  for (const cardId of cardIds) state.resources_by_id[cardId].location = "HARVEST_OFFER";
  state.harvest.offer_ids = cardIds;
  state.harvest.unit_id = unit.unit_id;
  state.harvest.deck = deck;
  recordEvent(state, "HarvestCardsDrawn", { player: command.player, unit_id: unit.unit_id, deck, card_ids: cardIds }, state.rules.automatic_passes ? "PUBLIC" : command.player);
  if (state.rules.resource_flow_v2 && cardIds.length < count) recordEvent(state, "HarvestSupplyShortage", {
    player: command.player, unit_id: unit.unit_id, requested: count, available: cardIds.length, deck,
    message: cardIds.length ? `Short Harvest: ${cardIds.length} of ${count} cards at ${unit.square}.` : `No Resource card available at ${unit.square}.`,
  });
  if (!cardIds.length && state.rules.resource_flow_v2) { finishEmptyHarvest(state, unit); return; }
  if (state.rules.automatic_passes && cardIds.length === 1) keepHarvestCard(state, { player: command.player, card_id: cardIds[0] });
}

function keepHarvestCard(state, command) {
  requirePhase(state, PHASE.HARVEST);
  requireCondition(state.harvest?.stage === "DRAW", "WRONG_HARVEST_STAGE", "Resource draws are complete");
  requireActor(state, command.player);
  requireCondition(state.harvest.offer_ids.includes(command.card_id), "CARD_NOT_IN_OFFER", "Select a card from the current Harvest offer");
  const unit = state.units_by_id[state.harvest.unit_id];
  const kept = state.resources_by_id[command.card_id];
  const counterFromCenter = isCenter(unit.square);
  const vassal = unit.vassal_noble_id ? state.nobles_by_id[unit.vassal_noble_id] : null;
  const counterFromVassal = vassal?.suit === kept.suit;
  kept.has_counter = Boolean(counterFromCenter || counterFromVassal);
  kept.counter_sources = [counterFromCenter ? "CENTER" : null, counterFromVassal ? "VASSAL" : null].filter(Boolean);
  kept.location = playerLocation(command.player, "HAND");
  state.players[command.player].resource_hand_ids.push(kept.card_id);

  const returned = state.harvest.offer_ids.filter((id) => id !== kept.card_id);
  const deck = state.harvest.deck;
  for (const cardId of returned) {
    const card = state.resources_by_id[cardId];
    if (state.rules.resource_flow_v2) {
      card.location = "HARVEST_REJECT";
      state.harvest.rejects.push({ card_id: cardId, unit_id: unit.unit_id, deck });
    } else {
      card.location = `${deck}_DECK`;
      state.decks[deck].push(cardId);
    }
  }
  if (returned.length && state.rules.harvest_returns_immediately) shuffleDeck(state, deck);
  state.harvest.remaining_unit_ids = state.harvest.remaining_unit_ids.filter((id) => id !== unit.unit_id);
  state.harvest.offer_ids = [];
  state.harvest.unit_id = null;
  state.harvest.deck = null;
  recordEvent(state, "HarvestCardKept", {
    player: command.player,
    unit_id: unit.unit_id,
    kept_card_id: kept.card_id,
    returned_card_ids: returned,
    counter_sources: [counterFromCenter ? "CENTER" : null, counterFromVassal ? "VASSAL" : null].filter(Boolean),
  }, state.rules.automatic_passes ? "PUBLIC" : command.player);
  if (state.harvest.remaining_unit_ids.length === 0) completeHarvestDrawForActor(state);
}

// UI convenience within the same transaction and the same player's turn.
// Never choose a corner deck, a multi-card offer, the failsafe, or Poker cards.
function continueForcedHarvest(state, player) {
  while (state.current_actor === player && state.harvest?.stage === "DRAW"
    && !state.harvest.failsafe_pending) {
    const h = state.harvest;
    if (h.offer_ids.length > 1) return;
    if (h.offer_ids.length === 1) {
      keepHarvestCard(state, { player, card_id: h.offer_ids[0] });
      continue;
    }
    if (!h.standard_order) return;
    const unit = state.units_by_id[h.remaining_unit_ids[0]];
    if (!unit || isCorner(unit.square)) return;
    const deck = deckForSquare(unit.square);
    // Keep an already-resolved choice if a later automatic draw cannot proceed.
    // The next explicit draw reports the existing DECK_EXHAUSTED rule error.
    if (state.decks[deck].length < drawCountOf(unit)) return;
    drawHarvest(state, { player, unit_id: unit.unit_id, deck });
  }
}

function declarePoker(state, command) {
  requirePhase(state, PHASE.HARVEST);
  requireCondition(state.harvest?.stage === "POKER", "WRONG_HARVEST_STAGE", "The Poker window is not open");
  requireActor(state, command.player);
  const ids = [...new Set(command.card_ids ?? [])];
  requireCondition(ids.length === (command.card_ids ?? []).length, "DUPLICATE_CARD", "A card cannot appear twice in one declaration");
  requireCondition(ids.every((id) => state.players[command.player].resource_hand_ids.includes(id)), "CARD_NOT_OWNED", "Every declared card must be in your hand");
  const kind = pokerKindForCards(state, ids);
  if (state.rules.resource_flow_v2) {
    const error = pokerSelectionError(state, command.player, ids);
    requireCondition(!error, "INVALID_POKER_HAND", error);
  } else if (state.rules.automatic_passes) {
    requireCondition(availablePokerHands(state, command.player).some((hand) => hand.card_ids.length === ids.length && hand.card_ids.every((id) => ids.includes(id))),
      "POKER_HAND_UNAVAILABLE", "Choose an available Poker Hand which adds a bonus.");
  }
  requireCondition(Boolean(kind), "INVALID_POKER_HAND", "Select a Pair, Three-of-a-Kind, or Four-Card Straight");
  if (!state.rules.poker_overlap_allowed) {
    requireCondition(ids.every((id) => !state.harvest.poker_used_ids.includes(id)), "POKER_OVERLAP_FORBIDDEN", "A card has already been used in a Poker Hand");
  }
  for (const id of ids) {
    const card = state.resources_by_id[id];
    card.has_counter = true;
    if (state.rules.resource_flow_v2) card.poker_used_year = state.year_number;
    card.counter_sources = [...new Set([...(card.counter_sources ?? []), "POKER"])];
    card.mandatory_spend_year = state.year_number;
  }
  state.harvest.poker_used_ids.push(...ids);
  recordEvent(state, "PokerHandDeclared", { player: command.player, kind, card_ids: ids });
}

function finishPoker(state, command) {
  if (state.v2_acted) delete state.v2_acted[opportunityKey(state, command.player)];
  requirePhase(state, PHASE.HARVEST);
  requireCondition(state.harvest?.stage === "POKER", "WRONG_HARVEST_STAGE", "Poker declarations have not begun");
  requireActor(state, command.player);
  state.harvest.completed_poker_players.push(command.player);
  recordEvent(state, "PokerDeclarationsFinished", { player: command.player, automatic: Boolean(command.automatic) });
  if (state.rules.resource_flow_v2 && state.harvest.completed_draw_players.length < state.phase_actor_order.length) {
    initializeHarvestActor(state, nextActorInOrder(state, command.player, new Set(state.harvest.completed_draw_players)));
    return;
  }
  if (!state.rules.resource_flow_v2 && state.harvest.completed_poker_players.length < state.phase_actor_order.length) {
    state.current_actor = nextActorInOrder(state, command.player, new Set(state.harvest.completed_poker_players));
    state.harvest.poker_used_ids = [];
    return;
  }
  state.harvest = null;
  startPhase(state, PHASE.BUILD);
}

function tapResources(state, command) {
  requireCondition(state.status === "ACTIVE", "WRONG_MATCH_STATUS", "Resources can be tapped only during an active match");
  requireCondition(phaseAllowsTap(state.phase), "WRONG_PHASE", "Resources cannot be tapped in this phase");
  requireActor(state, command.player);
  if (state.phase === PHASE.RANSOM) {
    const offer = state.active_ransom;
    const noble = offer ? state.nobles_by_id[offer.noble_id] : null;
    const cost = noble ? actionCost(state, "RANSOM", { actor: command.player, noble_id: noble.noble_id }) : Infinity;
    requireCondition(
      availableResourceValue(state, command.player, SUIT.DIAMONDS) >= cost,
      "PURPOSELESS_TAPPING",
      "These Diamonds cannot make the pending Ransom affordable",
    );
  } else {
    requireCondition(
      phaseAvailability(state, command.player).available,
      "PURPOSELESS_TAPPING",
      "Resource Cards cannot be cycled when no substantive action is available",
    );
  }
  const suit = currentSuit(state);
  const ids = [...new Set(command.card_ids ?? [])];
  requireCondition(ids.length > 0 && ids.length === (command.card_ids ?? []).length, "INVALID_CARD_SELECTION", "Select one or more distinct Resource Cards");
  const cards = ids.map((id) => state.resources_by_id[id]);
  requireCondition(cards.every((card) => card && state.players[command.player].resource_hand_ids.includes(card.card_id)), "CARD_NOT_OWNED", "Every tapped card must be in your hand");
  requireCondition(cards.every((card) => !card.tapped), "CARD_ALREADY_TAPPED", "A selected Resource Card is already tapped");
  requireCondition(cards.every((card) => card.suit === suit), "WRONG_RESOURCE_SUIT", `Only ${suit} may be tapped during this Season`);
  const value = cards.reduce((sum, card) => sum + effectiveCardValue(card), 0);
  for (const card of cards) card.tapped = true;
  state.players[command.player].seasonal_pools[suit] += value;
  recordEvent(state, "ResourceCardsTapped", { player: command.player, card_ids: ids, suit, value });
}

function buildUnit(state, command) {
  requirePhase(state, PHASE.BUILD);
  requireActor(state, command.player);
  requireCondition(!unitAt(state, command.square), "TARGET_OCCUPIED", "Build target must be empty");
  requireCondition(validBuildTargets(state, command.player).includes(command.square), "NO_ADJACENT_SUPPORT", "A new Pawn requires adjacent friendly Level 2 or 3 support");
  requireCondition(state.players[command.player].reserve[UNIT_TYPE.PAWN] > 0, "NO_RESERVE_PIECE", "No Pawn remains in reserve");
  const cost = actionCost(state, "BUILD", { actor: command.player });
  spendPool(state, command.player, SUIT.CLOVERS, cost);
  const unitId = newUnitId(state, command.player);
  state.units_by_id[unitId] = {
    unit_id: unitId,
    owner: command.player,
    piece_color: command.player,
    unit_type: UNIT_TYPE.PAWN,
    square: command.square,
    vassal_noble_id: null,
    defeated: false,
    irreplaceable: false,
    captured_from: null,
  };
  state.players[command.player].unit_ids.push(unitId);
  state.players[command.player].reserve[UNIT_TYPE.PAWN] -= 1;
  recordEvent(state, "UnitBuilt", { player: command.player, unit_id: unitId, square: command.square, unit_type: UNIT_TYPE.PAWN, cost });
}

function upgradeUnit(state, command) {
  requirePhase(state, PHASE.UPGRADE);
  requireActor(state, command.player);
  const unit = state.units_by_id[command.unit_id];
  requireCondition(unit && !unit.defeated && unit.owner === command.player, "UNIT_NOT_OWNED", "Select one of your live Units");
  requireCondition(validUpgradeTypes(unit).includes(command.to_type), "INVALID_UPGRADE", "That Upgrade transition is not legal");
  requireCondition(state.players[command.player].reserve[command.to_type] > 0, "NO_RESERVE_PIECE", `No ${command.to_type} remains in reserve`);
  requireCondition(hasUpgradeSupport(state, unit, command.to_type), "NO_ADJACENT_SUPPORT", "The upgraded Unit lacks adjacent support of equal or higher Level");
  const cost = actionCost(state, "UPGRADE", { actor: command.player, unit_id: unit.unit_id, to_type: command.to_type });
  spendPool(state, command.player, SUIT.CLOVERS, cost);
  const fromType = unit.unit_type;
  state.players[command.player].reserve[fromType] += 1;
  state.players[command.player].reserve[command.to_type] -= 1;
  unit.unit_type = command.to_type;
  recordEvent(state, "UnitUpgraded", { player: command.player, unit_id: unit.unit_id, from_type: fromType, to_type: command.to_type, cost });
}

function respondRansom(state, command) {
  requirePhase(state, PHASE.RANSOM);
  const offer = state.active_ransom;
  requireCondition(Boolean(offer), "NO_RANSOM_OFFER", "No Ransom response is pending");
  requireActor(state, command.player);
  const expected = offer.stage === "OWNER" ? offer.owner : offer.captor;
  requireCondition(command.player === expected, "NOT_RANSOM_DECIDER", `The ${offer.stage.toLowerCase()} must decide`);
  const noble = state.nobles_by_id[offer.noble_id];
  const cost = actionCost(state, "RANSOM", { actor: command.player, noble_id: noble.noble_id });
  if (!command.pay) {
    recordEvent(state, "RansomDeclined", { player: command.player, noble_id: noble.noble_id, role: offer.stage, automatic: Boolean(command.automatic) });
    if (offer.stage === "OWNER") {
      offer.stage = "CAPTOR";
      state.current_actor = offer.captor;
    } else {
      nextRansomOffer(state);
    }
    return;
  }
  spendPool(state, command.player, SUIT.DIAMONDS, cost);
  const captor = offer.captor;
  state.players[captor].dungeon_noble_id = null;
  noble.location = playerLocation(command.player, "COURT");
  noble.assigned_unit_id = null;
  if (offer.stage === "CAPTOR") noble.owner = command.player;
  state.players[command.player].court_noble_ids.push(noble.noble_id);
  let proceeds = 0;
  if (offer.stage === "OWNER") {
    proceeds = Math.ceil(cost / 2);
    state.players[captor].seasonal_pools[SUIT.DIAMONDS] += proceeds;
  }
  recordEvent(state, "HostageRansomed", { buyer: command.player, captor, noble_id: noble.noble_id, cost, proceeds });
  nextRansomOffer(state);
}

function recruitNoble(state, command) {
  requirePhase(state, PHASE.RECRUIT);
  requireActor(state, command.player);
  requireCondition(state.decks[DECK.NOBLE].length > 0, "NOBLE_DECK_EMPTY", "No Noble remains available to Recruit");
  const cost = actionCost(state, "RECRUIT", { actor: command.player });
  spendPool(state, command.player, SUIT.DIAMONDS, cost);
  const nobleId = state.decks[DECK.NOBLE].shift();
  const noble = state.nobles_by_id[nobleId];
  noble.location = playerLocation(command.player, "COURT");
  noble.owner = command.player;
  noble.assigned_unit_id = null;
  state.players[command.player].court_noble_ids.push(nobleId);
  recordEvent(state, "NobleRecruited", { player: command.player, noble_id: nobleId, cost }, command.player);
}

function mobilizeUnit(state, command) {
  requirePhase(state, PHASE.MOBILIZE);
  requireActor(state, command.player);
  const unit = state.units_by_id[command.unit_id];
  requireCondition(unit && !unit.defeated && unit.owner === command.player, "UNIT_NOT_OWNED", "Select one of your live Units");
  requireCondition(isLevy(unit), "UNIT_NOT_LEVY", "Only a Levy may Mobilize");
  requireCondition(legalMovementDestinations(state, unit.unit_id).includes(command.destination), "ILLEGAL_DESTINATION", "That destination is not legal for this Unit");
  const cost = actionCost(state, "MOBILIZE", { actor: command.player, unit_id: unit.unit_id });
  spendPool(state, command.player, SUIT.SPADES, cost);
  const origin = unit.square;
  unit.square = command.destination;
  recordEvent(state, "UnitMobilized", { player: command.player, unit_id: unit.unit_id, origin, destination: unit.square, cost });
}

function returnNobleToDeck(state, nobleId, eventType, payload = {}) {
  const noble = state.nobles_by_id[nobleId];
  noble.location = "NOBLE_DECK";
  noble.assigned_unit_id = null;
  noble.owner = null;
  state.decks[DECK.NOBLE].push(nobleId);
  shuffleDeck(state, DECK.NOBLE);
  recordEvent(state, eventType, { noble_id: nobleId, ...payload });
}

function returnNoblesToDeckBatch(state, nobleIds, eventType, payload = {}) {
  const unique = [...new Set(nobleIds.filter(Boolean))];
  for (const nobleId of unique) {
    const noble = state.nobles_by_id[nobleId];
    if (!noble) continue;
    noble.location = "NOBLE_DECK";
    noble.assigned_unit_id = null;
    noble.owner = null;
    if (!state.decks[DECK.NOBLE].includes(nobleId)) state.decks[DECK.NOBLE].push(nobleId);
  }
  if (unique.length) shuffleDeck(state, DECK.NOBLE);
  recordEvent(state, eventType, { noble_ids: unique, ...payload });
}

function defeatUnit(state, unit, { returnToReserve = true } = {}) {
  unit.defeated = true;
  unit.square = null;
  state.players[unit.owner].unit_ids = state.players[unit.owner].unit_ids.filter((id) => id !== unit.unit_id);
  if (unit.unit_type !== UNIT_TYPE.KING && returnToReserve && !unit.irreplaceable) {
    state.players[unit.owner].reserve[unit.unit_type] += 1;
  }
  if (unit.irreplaceable && unit.captured_from && state.players[unit.captured_from]) {
    const defeatedPlayer = state.players[unit.captured_from];
    if (defeatedPlayer.advice_until_unit_id === unit.unit_id) {
      defeatedPlayer.advises_player = null;
      defeatedPlayer.advice_until_unit_id = null;
      recordEvent(state, "CapturedQueenDestroyed", { unit_id: unit.unit_id, defeated_player: unit.captured_from });
    }
  }
}

function beginFourPlayerConquest(state, {
  defeatedKing,
  victor,
  attacker,
  outcome,
  defeatedSquare,
  resumeActor,
}) {
  const defeatedPlayer = defeatedKing.owner;
  const defeatedState = state.players[defeatedPlayer];
  const victoriousState = state.players[victor];
  const sovereignId = defeatedKing.vassal_noble_id;

  defeatUnit(state, defeatedKing, { returnToReserve: false });
  defeatedState.eliminated = true;
  if(survivingPlayers(state).length===1) {
    if(outcome==='ATTACKER_WIN' && attacker) attacker.square=defeatedSquare;
    state.status='COMPLETE';state.winner=victor;state.current_actor=victor;state.victory_reason='LAST_KING_STANDING';
    recordEvent(state,'MatchCompleted',{winner:victor,defeated_king_id:defeatedKing.unit_id,reason:state.victory_reason});
    return;
  }

  const courtShuffle = shuffleWithState(defeatedState.court_noble_ids, state.rng_state);
  state.rng_state = courtShuffle.state;
  const capturedCourtCount = Math.ceil(courtShuffle.items.length / 2);
  const capturedCourtIds = courtShuffle.items.slice(0, capturedCourtCount);
  const returnedCourtIds = courtShuffle.items.slice(capturedCourtCount);
  defeatedState.court_noble_ids = [];
  for (const nobleId of capturedCourtIds) {
    const noble = state.nobles_by_id[nobleId];
    noble.location = playerLocation(victor, "COURT");
    noble.owner = victor;
    noble.assigned_unit_id = null;
    victoriousState.court_noble_ids.push(nobleId);
  }
  if (returnedCourtIds.length) {
    returnNoblesToDeckBatch(state, returnedCourtIds, "DefeatedCourtDispersed", { defeated_player: defeatedPlayer });
  }
  recordEvent(state, "DefeatedCourtClaimed", {
    defeated_player: defeatedPlayer,
    victor,
    captured_ids: capturedCourtIds,
    captured_count: capturedCourtIds.length,
    returned_count: returnedCourtIds.length,
  });

  const transferredResourceIds = defeatedState.resource_hand_ids.filter(
    (cardId) => !state.resources_by_id[cardId].tapped,
  );
  const transferredSet = new Set(transferredResourceIds);
  defeatedState.resource_hand_ids = defeatedState.resource_hand_ids.filter((cardId) => !transferredSet.has(cardId));
  for (const cardId of transferredResourceIds) {
    state.resources_by_id[cardId].location = playerLocation(victor, "HAND");
    victoriousState.resource_hand_ids.push(cardId);
  }
  recordEvent(state, "DefeatedResourcesClaimed", {
    defeated_player: defeatedPlayer,
    victor,
    card_ids: transferredResourceIds,
  });

  const releasedHostageId = defeatedState.dungeon_noble_id;
  defeatedState.dungeon_noble_id = null;
  if (releasedHostageId) {
    const hostage = state.nobles_by_id[releasedHostageId];
    const originalOwner = hostage.owner;
    if (originalOwner && state.players[originalOwner] && !state.players[originalOwner].eliminated) {
      hostage.location = playerLocation(originalOwner, "COURT");
      hostage.assigned_unit_id = null;
      state.players[originalOwner].court_noble_ids.push(hostage.noble_id);
      recordEvent(state, "HostageReleasedOnDefeat", {
        noble_id: hostage.noble_id,
        original_owner: originalOwner,
        former_captor: defeatedPlayer,
      });
    } else {
      returnNobleToDeck(state, hostage.noble_id, "HostageKilledOnDefeat", { defeated_player: defeatedPlayer });
    }
  }

  const killedHostageIds = [];
  for (const captor of matchPlayers(state)) {
    const hostageId = state.players[captor].dungeon_noble_id;
    if (!hostageId) continue;
    const hostage = state.nobles_by_id[hostageId];
    if (hostage.owner !== defeatedPlayer) continue;
    state.players[captor].dungeon_noble_id = null;
    killedHostageIds.push(hostageId);
  }
  if (killedHostageIds.length) {
    returnNoblesToDeckBatch(state, killedHostageIds, "DefeatedPlayersHostagesKilled", { defeated_player: defeatedPlayer });
  }

  const remainingUnits = liveUnits(state, defeatedPlayer);
  const queenUnit = remainingUnits.find((unit) => unit.unit_type === UNIT_TYPE.QUEEN && !unit.irreplaceable && (unit.piece_color ?? unit.owner) === defeatedPlayer) ?? null;
  const killedVassalIds = [];
  for (const unit of remainingUnits) {
    if (unit.vassal_noble_id) {
      killedVassalIds.push(unit.vassal_noble_id);
      unit.vassal_noble_id = null;
    }
    defeatUnit(state, unit, { returnToReserve: false });
  }
  if (killedVassalIds.length) {
    returnNoblesToDeckBatch(state, killedVassalIds, "DefeatedVassalsKilled", { defeated_player: defeatedPlayer });
  }
  for (const type of Object.keys(defeatedState.reserve)) defeatedState.reserve[type] = 0;

  state.pending_conquest = {
    defeated_player: defeatedPlayer,
    victor,
    sovereign_id: sovereignId,
    defeated_king_id: defeatedKing.unit_id,
    queen_unit_id: queenUnit?.unit_id ?? null,
    king_square: defeatedSquare,
    attacker_id: attacker?.unit_id ?? null,
    outcome,
    resume_actor: resumeActor,
  };
  state.current_actor = victor;
  recordEvent(state, "PlayerEliminated", { defeated_player: defeatedPlayer, victor, defeated_king_id: defeatedKing.unit_id });
  recordEvent(state, "ConquestChoiceRequested", {
    defeated_player: defeatedPlayer,
    victor,
    sovereign_id: sovereignId,
    king_square: defeatedSquare,
  });
}

function resolveConquest(state, command) {
  const pending = state.pending_conquest;
  requireCondition(Boolean(pending), "NO_CONQUEST_CHOICE", "No defeated realm awaits a Conquest choice");
  requireActor(state, command.player);
  requireCondition(command.player === pending.victor, "NOT_VICTOR", "Only the victorious player chooses the conquest reward");
  requireCondition(["CARD", "HOLDING"].includes(command.choice), "INVALID_CONQUEST_CHOICE", "Choose the Sovereign Card or the captured Queen Holding");

  const defeatedPlayer = pending.defeated_player;
  const victor = pending.victor;
  const defeatedState = state.players[defeatedPlayer];
  const sovereign = state.nobles_by_id[pending.sovereign_id];
  const defeatedKing = state.units_by_id[pending.defeated_king_id];
  defeatedKing.vassal_noble_id = null;
  sovereign.assigned_unit_id = null;

  let capturedQueenId = null;
  if (command.choice === "CARD") {
    sovereign.location = playerLocation(victor, "COURT");
    sovereign.owner = victor;
    state.players[victor].court_noble_ids.push(sovereign.noble_id);
    if (pending.outcome === "ATTACKER_WIN") {
      const attacker = state.units_by_id[pending.attacker_id];
      if (attacker && !attacker.defeated) attacker.square = pending.king_square;
    }
    defeatedState.advises_player = victor;
    defeatedState.advice_until_unit_id = null;
    recordEvent(state, "ConquestCardTaken", { defeated_player: defeatedPlayer, victor, sovereign_id: sovereign.noble_id });
  } else {
    returnNobleToDeck(state, sovereign.noble_id, "DefeatedSovereignReturned", { defeated_player: defeatedPlayer, victor });
    let queen = pending.queen_unit_id ? state.units_by_id[pending.queen_unit_id] : null;
    if (!queen) {
      const unitId = newUnitId(state, victor);
      queen = { unit_id: unitId };
      state.units_by_id[unitId] = queen;
    }
    capturedQueenId = queen.unit_id;
    queen.owner = victor;
    queen.piece_color = defeatedPlayer;
    queen.unit_type = UNIT_TYPE.QUEEN;
    queen.square = pending.king_square;
    queen.vassal_noble_id = null;
    queen.defeated = false;
    queen.irreplaceable = true;
    queen.captured_from = defeatedPlayer;
    if (!state.players[victor].unit_ids.includes(queen.unit_id)) state.players[victor].unit_ids.push(queen.unit_id);
    defeatedState.advises_player = victor;
    defeatedState.advice_until_unit_id = queen.unit_id;
    recordEvent(state, "ConquestHoldingTaken", {
      defeated_player: defeatedPlayer,
      victor,
      queen_unit_id: queen.unit_id,
      square: queen.square,
    });
  }

  if (pending.outcome === 'RESIGNATION') {
    state.pending_conquest=null;
    recordEvent(state,'ConquestResolved',{defeated_player:defeatedPlayer,victor,choice:command.choice,captured_queen_id:capturedQueenId});
    resumeAfterResignation(state,pending.resume_actor);
    return;
  }
  const priorOrder = [...state.phase_actor_order];
  state.phase_actor_order = priorOrder.filter((player) => !state.players[player].eliminated);
  state.passed_players = state.passed_players.filter((player) => !state.players[player].eliminated);
  delete state.stockpile_committed[defeatedPlayer];
  state.pending_conquest = null;
  recordEvent(state, "ConquestResolved", {
    defeated_player: defeatedPlayer,
    victor,
    choice: command.choice,
    captured_queen_id: capturedQueenId,
  });

  const survivors = survivingPlayers(state);
  if (survivors.length === 1) {
    state.status = "COMPLETE";
    state.winner = survivors[0];
    state.victory_reason = "LAST_KING_STANDING";
    state.current_actor = survivors[0];
    recordEvent(state, "MatchCompleted", { winner: survivors[0], defeated_king_id: pending.defeated_king_id, reason: state.victory_reason });
    return;
  }

  if (!state.players[pending.resume_actor].eliminated) {
    state.current_actor = pending.resume_actor;
    return;
  }
  const resumeIndex = priorOrder.indexOf(pending.resume_actor);
  let nextActor = null;
  for (let offset = 1; offset <= priorOrder.length; offset += 1) {
    const candidate = priorOrder[(resumeIndex + offset) % priorOrder.length];
    if (state.players[candidate]?.eliminated || state.passed_players.includes(candidate)) continue;
    nextActor = candidate;
    break;
  }
  if (nextActor) state.current_actor = nextActor;
  else advancePhase(state);
}

export function resignationBlock(state) {
  if (!state || state.status !== 'ACTIVE') return 'The match is not active.';
  if (state.phase === PHASE.SETUP) return 'Finish Sovereign selection first.';
  if (state.pending_resignation) return 'Resolve the current resignation ballot first.';
  if (state.pending_combat || state.pending_conquest || state.active_ransom || state.harvest?.offer_ids?.length || state.harvest?.failsafe_pending)
    return 'Resolve the compulsory decision first.';
  return null;
}

function resumeAfterResignation(state, resumeActor) {
  const priorOrder = [...state.phase_actor_order];
  state.phase_actor_order = priorOrder.filter(p => !state.players[p].eliminated);
  state.passed_players = state.passed_players.filter(p => !state.players[p].eliminated);
  if (state.phase === PHASE.HARVEST) {
    if(state.players[resumeActor].eliminated) returnHarvestRejects(state);
    state.harvest.completed_draw_players = state.harvest.completed_draw_players.filter(p => !state.players[p].eliminated);
    state.harvest.completed_poker_players = state.harvest.completed_poker_players.filter(p => !state.players[p].eliminated);
  }
  if (!state.players[resumeActor].eliminated) { state.current_actor = resumeActor; return; }
  const excluded = new Set(state.phase === PHASE.HARVEST ? state.harvest.completed_poker_players : state.passed_players);
  const start = priorOrder.indexOf(resumeActor);
  const next = Array.from({length:priorOrder.length},(_,i)=>priorOrder[(start+i+1)%priorOrder.length])
    .find(p=>!state.players[p].eliminated && !excluded.has(p));
  if (next) {
    state.current_actor = next;
    if (state.phase === PHASE.HARVEST) initializeHarvestActor(state,next);
  } else advancePhase(state);
}

function resignationNoSpoils(state, player) {
  const person=state.players[player], nobles=[...person.court_noble_ids];
  person.court_noble_ids=[];
  for(const captor of matchPlayers(state)) {
    const id=state.players[captor].dungeon_noble_id;
    if(id && (captor===player || state.nobles_by_id[id].owner===player)) {
      nobles.push(id);state.players[captor].dungeon_noble_id=null;
    }
  }
  for(const unit of liveUnits(state,player)) {
    if(unit.vassal_noble_id) nobles.push(unit.vassal_noble_id);
    unit.vassal_noble_id=null;defeatUnit(state,unit,{returnToReserve:false});
  }
  returnNoblesToDeckBatch(state,nobles,'ResignedNoblesReturned',{player});
  const decks=new Set();
  for(const id of person.resource_hand_ids) {
    const card=state.resources_by_id[id], deck=deckForSuit(card.suit);
    Object.assign(card,{has_counter:false,tapped:false,mandatory_spend_year:null,poker_used_year:null,counter_sources:[],location:`${deck}_DECK`});
    state.decks[deck].push(id);decks.add(deck);
  }
  person.resource_hand_ids=[];
  for(const deck of decks) shuffleDeck(state,deck);
  for(const suit of Object.keys(person.seasonal_pools)) person.seasonal_pools[suit]=0;
  for(const type of Object.keys(person.reserve)) person.reserve[type]=0;
  person.eliminated=true;delete state.stockpile_committed[player];
}

function resolveResignation(state, beneficiary, reason, at) {
  const pending=state.pending_resignation;
  state.pending_resignation=null;
  recordEvent(state,'ResignationResolved',{player:pending.player,beneficiary,reason,at,deadline:pending.deadline});
  if(beneficiary) {
    const king=liveUnits(state,pending.player).find(u=>u.unit_type===UNIT_TYPE.KING);
    beginFourPlayerConquest(state,{defeatedKing:king,victor:beneficiary,attacker:null,outcome:'RESIGNATION',defeatedSquare:king.square,resumeActor:pending.resume_actor});
  } else {
    resignationNoSpoils(state,pending.player);
    resumeAfterResignation(state,pending.resume_actor);
  }
}

function resign(state, command) {
  const blocked=resignationBlock(state);
  requireCondition(!blocked,'RESIGNATION_UNAVAILABLE',blocked);
  requireCondition(state.players[command.player] && !state.players[command.player].eliminated,'PLAYER_ELIMINATED','Only a surviving player may resign');
  requireCondition(command.confirmed===true,'CONFIRM_REQUIRED','Confirm resignation');
  requireCondition(Number.isFinite(Date.parse(command.at)),'INVALID_TIME','An authoritative resignation time is required');
  state.phase_notice=null;
  const survivors=survivingPlayers(state).filter(p=>p!==command.player);
  recordEvent(state,'PlayerResigned',{player:command.player,at:command.at});
  if(survivors.length===1) {
    defeatUnit(state,liveUnits(state,command.player).find(u=>u.unit_type===UNIT_TYPE.KING),{returnToReserve:false});
    state.players[command.player].eliminated=true;
    state.status='COMPLETE';state.winner=survivors[0];state.current_actor=survivors[0];state.victory_reason='RESIGNATION';
    recordEvent(state,'MatchCompleted',{winner:survivors[0],reason:'RESIGNATION',resigned_player:command.player});
    return;
  }
  state.pending_resignation={player:command.player,survivors,votes:{},started_at:command.at,
    deadline:new Date(Date.parse(command.at)+86400000).toISOString(),resume_actor:state.current_actor};
  if(survivors.length===2) resolveResignation(state,null,'TWO_SURVIVORS',command.at);
}

function resignationVote(state,command) {
  const pending=state.pending_resignation;
  requireCondition(pending,'NO_BALLOT','No resignation ballot is pending');
  requireCondition(pending.survivors.includes(command.player),'NOT_VOTER','Only the three survivors may vote');
  requireCondition(Date.parse(command.at)<Date.parse(pending.deadline),'BALLOT_EXPIRED','The ballot deadline has passed');
  requireCondition(command.choice==='NONE' || pending.survivors.includes(command.choice),'INVALID_VOTE','Choose a survivor or No spoils');
  pending.votes[command.player]=command.choice;
  recordEvent(state,'ResignationVoteCast',{player:command.player,choice:command.choice,at:command.at,deadline:pending.deadline});
  if(pending.survivors.every(p=>pending.votes[p]===command.choice)) resolveResignation(state,command.choice==='NONE'?null:command.choice,'UNANIMOUS',command.at);
}

function expireResignation(state,command) {
  requireCondition(state.pending_resignation && Date.parse(command.at)>=Date.parse(state.pending_resignation.deadline),'BALLOT_NOT_DUE','The ballot has not expired');
  resolveResignation(state,null,'TIMEOUT',command.at);
}

function laySiege(state, command) {
  requirePhase(state, PHASE.SIEGE);
  requireActor(state, command.player);
  const attacker = state.units_by_id[command.attacker_id];
  const defender = state.units_by_id[command.defender_id];
  requireCondition(attacker && !attacker.defeated && attacker.owner === command.player, "UNIT_NOT_OWNED", "Select one of your live Levies as attacker");
  requireCondition(isLevy(attacker), "UNIT_NOT_LEVY", "Only a Levy may Lay Siege");
  requireCondition(defender && !defender.defeated && defender.owner !== command.player, "INVALID_DEFENDER", "Select an enemy Unit");
  requireCondition(legalSiegeTargets(state, attacker.unit_id).includes(defender.unit_id), "TARGET_NOT_ADJACENT", "Siege targets must be adjacent");
  const cost = actionCost(state, "SIEGE", { actor: command.player, defender_id: defender.unit_id });
  spendPool(state, command.player, SUIT.SPADES, cost);

  const attackerRoll = rollDice(state.rng_state, deriveConstantsForLevel(attacker));
  const defenderRoll = rollDice(attackerRoll.state, deriveConstantsForLevel(defender));
  state.rng_state = defenderRoll.state;
  const attackerBonus = state.nobles_by_id[attacker.vassal_noble_id]?.rank ?? 0;
  const defenderBonus = state.nobles_by_id[defender.vassal_noble_id]?.rank ?? 0;
  const attackerHigh = Math.max(...attackerRoll.rolls);
  const defenderHigh = Math.max(...defenderRoll.rolls);
  const attackerTotal = attackerHigh + attackerBonus;
  const defenderTotal = defenderHigh + defenderBonus;
  const outcome = attackerTotal === defenderTotal
    ? "TIE"
    : attackerTotal > defenderTotal ? "ATTACKER_WIN" : "DEFENDER_WIN";
  const combatSnapshot = unit => ({ unit: { unit_id:unit.unit_id, owner:unit.owner,
    piece_color:unit.piece_color ?? unit.owner, unit_type:unit.unit_type, square:unit.square,
    vassal_noble_id:unit.vassal_noble_id, irreplaceable:Boolean(unit.irreplaceable) },
    noble:unit.vassal_noble_id ? { noble_id:unit.vassal_noble_id,
      face:state.nobles_by_id[unit.vassal_noble_id].face, suit:state.nobles_by_id[unit.vassal_noble_id].suit,
      rank:state.nobles_by_id[unit.vassal_noble_id].rank } : null });
  recordEvent(state, "CombatResolved", {
    attacker_snapshot:combatSnapshot(attacker), defender_snapshot:combatSnapshot(defender),
    attacker_id: attacker.unit_id,
    defender_id: defender.unit_id,
    cost,
    attacker_rolls: attackerRoll.rolls,
    defender_rolls: defenderRoll.rolls,
    attacker_high: attackerHigh,
    defender_high: defenderHigh,
    attacker_bonus: attackerBonus,
    defender_bonus: defenderBonus,
    attacker_total: attackerTotal,
    defender_total: defenderTotal,
    outcome,
  });
  if (outcome === "TIE") return;

  const defeated = outcome === "ATTACKER_WIN" ? defender : attacker;
  const victor = outcome === "ATTACKER_WIN" ? attacker.owner : defender.owner;
  const defeatedSquare = defeated.square;
  const defeatedVassalId = defeated.vassal_noble_id;
  if (defeated.unit_type === UNIT_TYPE.KING && state.rules.player_count === 4) {
    recordEvent(state, "UnitDefeated", {
      unit_id: defeated.unit_id,
      defeated_owner: defeated.owner,
      victor,
      attacker_occupied_square: null,
    });
    beginFourPlayerConquest(state, {
      defeatedKing: defeated,
      victor,
      attacker,
      outcome,
      defeatedSquare,
      resumeActor: command.player,
    });
    return;
  }

  defeatUnit(state, defeated);
  if (outcome === "ATTACKER_WIN") attacker.square = defeatedSquare;
  recordEvent(state, "UnitDefeated", {
    unit_id: defeated.unit_id,
    defeated_owner: defeated.owner,
    victor,
    attacker_occupied_square: outcome === "ATTACKER_WIN" ? defeatedSquare : null,
  });

  if (defeated.unit_type === UNIT_TYPE.KING) {
    state.status = "COMPLETE";
    state.winner = victor;
    state.victory_reason = "KING_DEFEATED";
    recordEvent(state, "MatchCompleted", { winner: victor, defeated_king_id: defeated.unit_id, reason: state.victory_reason });
    return;
  }
  if (!defeatedVassalId) return;

  defeated.vassal_noble_id = null;
  const noble = state.nobles_by_id[defeatedVassalId];
  noble.assigned_unit_id = null;
  if (state.players[victor].dungeon_noble_id) {
    returnNobleToDeck(state, noble.noble_id, "NobleKilledInBattle", { victor, reason: "DUNGEON_FULL" });
    return;
  }
  noble.location = "PENDING_QUARTER";
  state.pending_combat = {
    noble_id: noble.noble_id,
    victor,
    resume_actor: command.player,
  };
  state.current_actor = victor;
  recordEvent(state, "QuarterDecisionRequested", { noble_id: noble.noble_id, victor });
}

function deriveConstantsForLevel(unit) {
  return unit.unit_type === UNIT_TYPE.PAWN ? 1
    : [UNIT_TYPE.ROOK, UNIT_TYPE.KNIGHT, UNIT_TYPE.BISHOP].includes(unit.unit_type) ? 2 : 3;
}

function chooseQuarter(state, command) {
  requireCondition(Boolean(state.pending_combat), "NO_QUARTER_DECISION", "No defeated Vassal awaits a Quarter decision");
  const pending = state.pending_combat;
  requireActor(state, command.player);
  requireCondition(command.player === pending.victor, "NOT_VICTOR", "Only the victorious player chooses Quarter");
  const noble = state.nobles_by_id[pending.noble_id];
  if (command.quarter) {
    requireCondition(!state.players[pending.victor].dungeon_noble_id, "DUNGEON_FULL", "The Dungeon is already occupied");
    state.players[pending.victor].dungeon_noble_id = noble.noble_id;
    noble.location = playerLocation(pending.victor, "DUNGEON");
    recordEvent(state, "NobleCaptured", { noble_id: noble.noble_id, captor: pending.victor, owner: noble.owner });
  } else {
    returnNobleToDeck(state, noble.noble_id, "NobleKilledInBattle", { victor: pending.victor, reason: "NO_QUARTER" });
  }
  state.current_actor = pending.resume_actor;
  state.pending_combat = null;
}

function vassalizeNoble(state, command) {
  requirePhase(state, PHASE.VASSALIZE);
  requireActor(state, command.player);
  const noble = state.nobles_by_id[command.noble_id];
  const unit = state.units_by_id[command.unit_id];
  requireCondition(noble && state.players[command.player].court_noble_ids.includes(noble.noble_id), "NOBLE_NOT_IN_COURT", "Select a Noble from your Court");
  requireCondition(unit && unit.owner === command.player && !unit.defeated, "UNIT_NOT_OWNED", "Select one of your live Units");
  requireCondition(!isLevy(unit), "UNIT_ALREADY_LEVY", "V1.1 does not permit replacing an existing Vassal");
  const cost = actionCost(state, "VASSALIZE", { actor: command.player, noble_id: noble.noble_id });
  spendPool(state, command.player, SUIT.HEARTS, cost);
  state.players[command.player].court_noble_ids = state.players[command.player].court_noble_ids.filter((id) => id !== noble.noble_id);
  noble.location = "ASSIGNED";
  noble.assigned_unit_id = unit.unit_id;
  noble.owner = command.player;
  unit.vassal_noble_id = noble.noble_id;
  recordEvent(state, "NobleVassalized", { player: command.player, noble_id: noble.noble_id, unit_id: unit.unit_id, cost });
}

function executeHostage(state, command) {
  requirePhase(state, PHASE.EXECUTE);
  requireActor(state, command.player);
  const nobleId = state.players[command.player].dungeon_noble_id;
  requireCondition(Boolean(nobleId), "DUNGEON_EMPTY", "There is no Hostage to Execute");
  const cost = actionCost(state, "EXECUTE", { actor: command.player, noble_id: nobleId });
  spendPool(state, command.player, SUIT.HEARTS, cost);
  state.players[command.player].dungeon_noble_id = null;
  returnNobleToDeck(state, nobleId, "HostageExecuted", { player: command.player, cost });
}

function acknowledgePhaseNotice(state, command) {
  const notice = state.phase_notice;
  requireCondition(Boolean(notice), "NO_PHASE_NOTICE", "No unavailable phase notice is pending");
  requireActor(state, command.player);
  if (notice.player) {
    requireCondition(notice.player === command.player, "NOT_NOTICE_PLAYER", "The named player must acknowledge this notice");
  }
  const acknowledged = deepClone(notice);
  state.phase_notice = null;
  recordEvent(state, "PhaseUnavailableAcknowledged", acknowledged);
  if (acknowledged.scope === "GLOBAL") {
    advancePhase(state);
    return;
  }
  passPhase(state, { type: "PASS_PHASE", player: command.player });
}

function passPhase(state, command) {
  if (state.v2_acted) delete state.v2_acted[opportunityKey(state, command.player)];
  requireCondition(state.status === "ACTIVE", "WRONG_MATCH_STATUS", "The match is not active");
  requireCondition(![PHASE.HARVEST, PHASE.RANSOM, PHASE.STOCKPILE].includes(state.phase), "PASS_NOT_ALLOWED", "This phase has a specific completion decision");
  requireCondition(!state.pending_combat, "PENDING_DECISION", "Resolve the Quarter decision first");
  requireActor(state, command.player);
  requireCondition(!state.passed_players.includes(command.player), "ALREADY_PASSED", "This player already passed");
  state.passed_players.push(command.player);
  recordEvent(state, "ActorPassed", { player: command.player, phase: state.phase, automatic: Boolean(command.automatic) });
  if (state.passed_players.length < state.phase_actor_order.length) {
    state.current_actor = nextActorInOrder(state, command.player, new Set(state.passed_players));
    return;
  }
  advancePhase(state);
}

function chooseStockpile(state, command) {
  requirePhase(state, PHASE.STOCKPILE);
  requireActor(state, command.player);
  const kept = command.card_ids ?? [];
  const hand = state.players[command.player].resource_hand_ids;
  if (!state.rules.resource_flow_v2 && state.rules.automatic_passes && !validateStockpile(state, command.player, hand)) {
    requireCondition(kept.length === hand.length && hand.every((id) => kept.includes(id)), "VOLUNTARY_DISCARD_DISABLED", "All remaining cards fit and are retained automatically in the digital game.");
  }
  const validation = validateStockpile(state, command.player, kept);
  requireCondition(!validation, "INVALID_STOCKPILE", validation ?? "Invalid Stockpile");
  const keptSet = new Set(kept);
  const discarded = state.players[command.player].resource_hand_ids.filter((id) => !keptSet.has(id));
  const affectedDecks = new Set();
  for (const cardId of discarded) {
    const card = state.resources_by_id[cardId];
    const deck = deckForSuit(card.suit);
    card.has_counter = false;
    card.tapped = false;
    card.mandatory_spend_year = null;
    card.poker_used_year = null;
    card.counter_sources = [];
    card.location = `${deck}_DECK`;
    state.decks[deck].push(cardId);
    affectedDecks.add(deck);
  }
  for (const cardId of kept) state.resources_by_id[cardId].location = playerLocation(command.player, "HAND");
  state.players[command.player].resource_hand_ids = [...kept];
  for (const deck of affectedDecks) shuffleDeck(state, deck);
  state.stockpile_committed[command.player] = true;
  recordEvent(state, "ResourceStockpileCommitted", { player: command.player, kept_card_ids: kept, discarded_card_ids: discarded, automatic: Boolean(command.automatic) });
  if (Object.keys(state.stockpile_committed).length < state.phase_actor_order.length) {
    state.current_actor = nextActorInOrder(state, command.player, new Set(Object.keys(state.stockpile_committed)));
    return;
  }
  state.button_holder = nextSurvivingClockwise(state, state.button_holder);
  state.year_number += 1;
  state.stockpile_committed = {};
  recordEvent(state, "ButtonPassed", { button_holder: state.button_holder });
  recordEvent(state, "YearStarted", { year: state.year_number, button_holder: state.button_holder });
  startHarvest(state);
}

function setStockpileInstructions(state, command) {
  requireCondition(state.rules.resource_flow_v2 && state.status === "ACTIVE" && state.players[command.player] && !state.players[command.player].eliminated,
    "STOCKPILE_UNAVAILABLE", "Only a surviving player in an active V2 game can plan Stockpile");
  const input = command.instructions;
  requireCondition(input && ["MANUAL", "AUTO"].includes(input.mode), "INVALID_STOCKPILE_INSTRUCTIONS", "Choose Manual or Auto");
  requireCondition(Array.isArray(input.suit_order) && input.suit_order.length === 4 && SUITS.every(s => input.suit_order.includes(s)), "INVALID_SUIT_ORDER", "Rank each of the four suits once");
  const cardOrder = {};
  for (const suit of SUITS) {
    const ids = input.card_order?.[suit] ?? [];
    requireCondition(Array.isArray(ids) && ids.length <= 20 && new Set(ids).size === ids.length
      && ids.every(id => state.resources_by_id[id]?.suit === suit), "INVALID_CARD_ORDER", "Card priorities must identify distinct physical cards of that suit");
    cardOrder[suit] = [...ids];
  }
  const plan = input.manual_plan ?? null;
  requireCondition(plan === null || (plan.year === state.year_number && Array.isArray(plan.card_ids)
    && plan.card_ids.length <= 8 && new Set(plan.card_ids).size === plan.card_ids.length
    && plan.card_ids.every(id => Boolean(state.resources_by_id[id]))), "INVALID_MANUAL_PLAN", "Save an exact selection of up to eight cards for this Year");
  requireCondition(input.manual_year == null || input.manual_year === state.year_number, "INVALID_MANUAL_YEAR", "A Manual override applies only to this Year");
  state.players[command.player].stockpile_instructions = {
    mode: input.mode, suit_order: [...input.suit_order], card_order: cardOrder,
    manual_year: input.manual_year ?? null, manual_plan: plan ? deepClone(plan) : null,
  };
  recordEvent(state, "StockpileInstructionsSaved", { player: command.player, instructions: deepClone(state.players[command.player].stockpile_instructions) }, command.player);
}

// Planning is independent of reversible gameplay. An Undo keeps the latest saved
// private instructions, recording them again so command replay stays exact.
export function preserveStockpileInstructions(restored, latest) {
  for (const player of matchPlayers(latest)) {
    const instructions = latest.players[player].stockpile_instructions;
    if (!instructions || JSON.stringify(instructions) === JSON.stringify(restored.players[player].stockpile_instructions)) continue;
    const result = dispatch(restored, { type: "SET_STOCKPILE_INSTRUCTIONS", player, instructions });
    if (!result.ok) throw new RuleError(result.error.code, result.error.message);
    restored = result.state;
  }
  return restored;
}

export function reversibleAction(before, after, command) {
  return ["TAP_RESOURCES", "BUILD_UNIT", "UPGRADE_UNIT", "MOBILIZE_UNIT", "VASSALIZE_NOBLE", "DECLARE_POKER"].includes(command.type)
    && JSON.stringify(before.rng_state) === JSON.stringify(after.rng_state);
}

function queueAutomaticNotice(state, reason, section = state.phase, player = state.current_actor) {
  const event = recordEvent(state, "PhaseAutomaticallyPassed", { player, section, reason });
  state.automatic_notices ??= [];
  state.automatic_notices.push({ id: event.event_id, sequence: event.sequence,
    year: state.year_number, phase: state.phase, section, player, reason });
}

// Settle all clerical transitions in the same transaction. This never draws for
// the next piece, chooses among offered cards, or spends a player's resources.
function opportunityKey(state, player = state.current_actor) { return `${state.year_number}:${state.phase}:${player}`; }

export function settleAutomaticPhases(state) {
  if (!state.rules.automatic_passes) return;
  state.phase_notice = null;
  for (let step = 0; step < 256 && state.status === "ACTIVE"; step++) {
    if (state.pending_combat || state.pending_conquest || state.pending_resignation) return;
    const player = state.current_actor;
    if (state.rules.explicit_action_pass && state.v2_acted?.[opportunityKey(state)]) return;
    if (state.phase === PHASE.HARVEST) {
      if (state.harvest.stage === "DRAW") return;
      if (availablePokerHands(state, player).length) return;
      if (!state.rules.resource_flow_v2) queueAutomaticNotice(state, "No available Poker Hand can add a bonus.", "POKER");
      finishPoker(state, { player, automatic: true });
    } else if (state.phase === PHASE.STOCKPILE) {
      if (state.rules.resource_flow_v2) {
        const plan = stockpilePlan(state, player);
        if (!plan.submitted || plan.error) return;
        chooseStockpile(state, { player, card_ids: plan.card_ids, automatic: true });
        continue;
      }
      const cards = state.players[player].resource_hand_ids;
      if (validateStockpile(state, player, cards)) return;
      queueAutomaticNotice(state, "Every remaining card fits your Stockpile. All were retained automatically.");
      chooseStockpile(state, { player, card_ids: [...cards], automatic: true });
    } else if (state.phase === PHASE.RANSOM) {
      const offer = state.active_ransom;
      if (!offer) {
        for (const actor of state.phase_actor_order) queueAutomaticNotice(state, "There are no Hostages to ransom.", PHASE.RANSOM, actor);
        advancePhase(state);
        continue;
      }
      const cost = actionCost(state, "RANSOM", { actor: player, noble_id: offer.noble_id });
      const value = availableResourceValue(state, player, SUIT.DIAMONDS);
      if (value >= cost) return;
      queueAutomaticNotice(state, `Ransom costs ${cost} Diamonds; only ${value} are available. The unaffordable offer was declined.`);
      respondRansom(state, { player, pay: false, automatic: true });
    } else {
      const availability = phaseAvailability(state, player);
      if (availability.available) return;
      queueAutomaticNotice(state, availability.reason);
      passPhase(state, { player, automatic: true });
    }
  }
  requireCondition(state.status !== "ACTIVE", "AUTOMATIC_PASS_LIMIT", "Automatic phase progression did not reach a decision.");
}

export function turnBoundaryCrossed(before, after, events = []) {
  return before.status !== after.status || before.phase !== after.phase
    || before.current_actor !== after.current_actor || before.year_number !== after.year_number
    || (!before.rules.resource_flow_v2 && before.harvest?.stage !== after.harvest?.stage) || before.active_ransom?.stage !== after.active_ransom?.stage
    || events.some((event) => ["ActorPassed", ...(!before.rules.resource_flow_v2 ? ["HarvestActorCompleted"] : []), "PokerDeclarationsFinished", "ResourceStockpileCommitted", "PhaseAutomaticallyPassed"].includes(event.type));
}

function applyV15Usability(state) {
  state.rules.automatic_passes = true;
  state.rules.harvest_order = "STANDARD_V15";
  state.rules.resource_hands_public = true;
  state.rules.ruleset_version = "1.2-digital-1.5";
  state.ruleset_version = state.rules.ruleset_version;
  state.phase_notice = null;
  if (state.harvest?.stage === "DRAW") {
    const remaining = new Set(state.harvest.remaining_unit_ids);
    const completed = (state.harvest.ordered_unit_ids ?? []).filter((id) => !remaining.has(id));
    const ordered = orderedHarvestUnits(state, state.current_actor).map((unit) => unit.unit_id).filter((id) => remaining.has(id));
    // Finish an existing offer before applying the new tie-break to later pieces.
    if (state.harvest.unit_id) ordered.sort((a, b) => a === state.harvest.unit_id ? -1 : b === state.harvest.unit_id ? 1 : 0);
    state.harvest.ordered_unit_ids = [...completed, ...ordered];
    state.harvest.remaining_unit_ids = ordered;
    state.harvest.standard_order = true;
  }
  recordEvent(state, "UsabilityRevisionApplied", { version: "1.5" });
}

export function upgradeToV15(state) {
  if (state.rules.automatic_passes && state.rules.harvest_order === "STANDARD_V15") return state;
  const result = dispatch(state, { type: "APPLY_V15_USABILITY" });
  if (!result.ok) throw new RuleError(result.error.code, result.error.message);
  return result.state;
}

const HANDLERS = Object.freeze({
  APPLY_V15_USABILITY: applyV15Usability,
  CHOOSE_SOVEREIGN: chooseSovereign,
  RESOLVE_HARVEST_FAILSAFE: resolveHarvestFailsafe,
  DRAW_HARVEST: drawHarvest,
  KEEP_HARVEST_CARD: keepHarvestCard,
  DECLARE_POKER: declarePoker,
  FINISH_POKER: finishPoker,
  TAP_RESOURCES: tapResources,
  BUILD_UNIT: buildUnit,
  UPGRADE_UNIT: upgradeUnit,
  RESPOND_RANSOM: respondRansom,
  RECRUIT_NOBLE: recruitNoble,
  MOBILIZE_UNIT: mobilizeUnit,
  LAY_SIEGE: laySiege,
  CHOOSE_QUARTER: chooseQuarter,
  CHOOSE_CONQUEST: resolveConquest,
  RESIGN: resign,
  RESIGNATION_VOTE: resignationVote,
  EXPIRE_RESIGNATION: expireResignation,
  VASSALIZE_NOBLE: vassalizeNoble,
  EXECUTE_HOSTAGE: executeHostage,
  ACKNOWLEDGE_PHASE_NOTICE: acknowledgePhaseNotice,
  PASS_PHASE: passPhase,
  CHOOSE_STOCKPILE: chooseStockpile,
  SET_STOCKPILE_INSTRUCTIONS: setStockpileInstructions,
});

export function dispatch(state, command) {
  const beforeSequence = state.event_sequence;
  const working = deepClone(state);
  try {
    requireCondition(command && typeof command.type === "string", "INVALID_COMMAND", "Command type is required");
    requireCondition(!(working.status === "COMPLETE" && !["NEW_MATCH", "APPLY_V15_USABILITY"].includes(command.type)), "MATCH_COMPLETE", "No commands are accepted after victory");
    if (working.pending_resignation && !['RESIGNATION_VOTE','EXPIRE_RESIGNATION'].includes(command.type)) fail('NEGOTIATION_PENDING','Play is paused for the resignation ballot');
    const lifecycle=['RESIGN','RESIGNATION_VOTE','EXPIRE_RESIGNATION'].includes(command.type);
    const planning = command.type === "SET_STOCKPILE_INSTRUCTIONS";
    if (working.phase_notice && !planning && !lifecycle && !["ACKNOWLEDGE_PHASE_NOTICE", "APPLY_V15_USABILITY"].includes(command.type)) {
      fail("PHASE_NOTICE_PENDING", "Acknowledge the unavailable phase before taking another action");
    }
    if (working.pending_combat && !planning && !["CHOOSE_QUARTER", "APPLY_V15_USABILITY"].includes(command.type)) {
      fail("PENDING_DECISION", "Resolve the Quarter decision before taking another action");
    }
    if (working.pending_conquest && !planning && !["CHOOSE_CONQUEST", "APPLY_V15_USABILITY"].includes(command.type)) {
      fail("PENDING_DECISION", "Resolve the Conquest choice before taking another action");
    }
    const handler = HANDLERS[command.type];
    requireCondition(Boolean(handler), "UNKNOWN_COMMAND", `Unknown command: ${command.type}`);
    if (working.rules.explicit_action_pass && ["TAP_RESOURCES", "BUILD_UNIT", "UPGRADE_UNIT", "RECRUIT_NOBLE",
      "MOBILIZE_UNIT", "LAY_SIEGE", "VASSALIZE_NOBLE", "EXECUTE_HOSTAGE", "DECLARE_POKER"].includes(command.type)) {
      working.v2_acted ??= {}; working.v2_acted[opportunityKey(working, command.player)] = true;
    }
    handler(working, command);
    if (!working.rules.automatic_passes && command.auto_harvest && ["DRAW_HARVEST", "KEEP_HARVEST_CARD", "RESOLVE_HARVEST_FAILSAFE"].includes(command.type)) {
      continueForcedHarvest(working, command.player);
    }
    const ordinaryAction = ["TAP_RESOURCES", "BUILD_UNIT", "UPGRADE_UNIT", "RECRUIT_NOBLE",
      "MOBILIZE_UNIT", "LAY_SIEGE", "VASSALIZE_NOBLE", "EXECUTE_HOSTAGE", "DECLARE_POKER"].includes(command.type);
    const sameOpportunity = working.current_actor === state.current_actor && working.phase === state.phase;
    if (planning && !(working.phase === PHASE.STOCKPILE && working.current_actor === command.player)) {
      // Saving while waiting must never advance somebody else's opportunity.
    } else if (working.rules.automatic_passes) {
      if (!(working.rules.explicit_action_pass && ordinaryAction && sameOpportunity)) settleAutomaticPhases(working);
    }
    else refreshPhaseNotice(working);
    working.command_log.push(deepClone(command));
    const invariantErrors = validateInvariants(working);
    requireCondition(invariantErrors.length === 0, "INVARIANT_FAILURE", invariantErrors.join("; "), { errors: invariantErrors });
    return {
      ok: true,
      state: working,
      events: working.event_log.filter((event) => event.sequence > beforeSequence),
    };
  } catch (error) {
    if (error instanceof RuleError) {
      return {
        ok: false,
        state,
        events: [],
        error: { code: error.code, message: error.message, details: error.details },
      };
    }
    throw error;
  }
}

export function newMatch(options = {}) {
  return createInitialState(options);
}

export function replayCommandLog(savedState) {
  let replay = newMatch({
    seed: savedState.seed,
    rules: { harvest_order: "PLAYER_CHOICE", automatic_passes: false, ...(savedState.event_log.find((e) => e.type === "MatchCreated")?.payload.rules ?? savedState.rules) },
    matchId: savedState.match_id,
  });
  for (const command of savedState.command_log ?? []) {
    const result = dispatch(replay, command);
    if (!result.ok) {
      throw new RuleError("REPLAY_FAILED", `${command.type}: ${result.error.code} — ${result.error.message}`, {
        command,
        error: result.error,
      });
    }
    replay = result.state;
  }
  return replay;
}

export function legalCommandSummary(state, player = state.current_actor) {
  if (state.status === "COMPLETE") return [];
  if (state.phase_notice) return [{ type: "ACKNOWLEDGE_PHASE_NOTICE", player }];
  if (state.status === "SETUP") {
    return sovereignCandidates(state).map((noble) => ({ type: "CHOOSE_SOVEREIGN", player, noble_id: noble.noble_id }));
  }
  if (state.pending_conquest) {
    return [
      { type: "CHOOSE_CONQUEST", player, choice: "CARD" },
      { type: "CHOOSE_CONQUEST", player, choice: "HOLDING" },
    ];
  }
  if (state.pending_combat) {
    return [
      { type: "CHOOSE_QUARTER", player, quarter: true },
      { type: "CHOOSE_QUARTER", player, quarter: false },
    ];
  }
  if (state.phase === PHASE.HARVEST) {
    if (state.harvest.stage === "POKER") return [
      ...availablePokerHands(state, player).map((hand) => ({ type: "DECLARE_POKER", player, card_ids: hand.card_ids })),
      { type: "FINISH_POKER", player },
    ];
    if (state.harvest.failsafe_pending) {
      return [
        { type: "RESOLVE_HARVEST_FAILSAFE", player, use: true },
        { type: "RESOLVE_HARVEST_FAILSAFE", player, use: false },
      ];
    }
    if (state.harvest.offer_ids.length) {
      return state.harvest.offer_ids.map((cardId) => ({ type: "KEEP_HARVEST_CARD", player, card_id: cardId }));
    }
    const nextUnits = state.harvest.standard_order
      ? state.harvest.remaining_unit_ids.slice(0, 1) : state.harvest.remaining_unit_ids;
    return nextUnits.flatMap((unitId) => {
      const unit = state.units_by_id[unitId];
      const decks = isCorner(unit.square) ? [DECK.BLACK, DECK.RED] : [deckForSquare(unit.square)];
      return decks.map((deck) => ({ type: "DRAW_HARVEST", player, unit_id: unitId, deck }));
    });
  }
  if (state.phase === PHASE.RANSOM) {
    return [
      { type: "RESPOND_RANSOM", player, pay: false },
      { type: "RESPOND_RANSOM", player, pay: true },
    ];
  }
  if (state.phase === PHASE.STOCKPILE) return [{ type: "CHOOSE_STOCKPILE", player, card_ids: [] }];
  return [{ type: "PASS_PHASE", player }];
}

export function canPlayerAffordAction(state, action, details = {}) {
  const player = details.actor ?? state.current_actor;
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase];
  if (!suit) return false;
  return canAfford(state, player, suit, actionCost(state, action, details));
}

export function suggestedPhaseActions(state) {
  return phaseActionCandidates(state, state.current_actor);
}
