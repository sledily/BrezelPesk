import {
  ACTIVE_SUIT_BY_PHASE,
  DECK,
  DRAW_COUNT_BY_TYPE,
  LEVEL_BY_TYPE,
  NOBLE_FACE,
  PHASE,
  PLAYER,
  STORAGE_TYPE,
  SUIT,
  SUITS,
  UNIT_TYPE,
} from "./constants.js";

export function parseSquare(square) {
  if (!/^[a-h][1-8]$/.test(square ?? "")) return null;
  return { x: square.charCodeAt(0) - 97, y: Number(square[1]) - 1 };
}

export function toSquare(x, y) {
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  return `${String.fromCharCode(97 + x)}${y + 1}`;
}

export function isBlackSquare(square) {
  const point = parseSquare(square);
  return point ? (point.x + point.y) % 2 === 0 : false;
}

export function isCorner(square) {
  return ["a1", "a8", "h1", "h8"].includes(square);
}

export function isCenter(square) {
  return ["d4", "d5", "e4", "e5"].includes(square);
}

export function areAdjacent(a, b) {
  const one = parseSquare(a);
  const two = parseSquare(b);
  if (!one || !two) return false;
  const dx = Math.abs(one.x - two.x);
  const dy = Math.abs(one.y - two.y);
  return Math.max(dx, dy) === 1;
}

export function levelOf(unit) {
  return LEVEL_BY_TYPE[unit.unit_type];
}

export function drawCountOf(unit) {
  return DRAW_COUNT_BY_TYPE[unit.unit_type];
}

export function liveUnits(state, player = null) {
  return Object.values(state.units_by_id).filter(
    (unit) => !unit.defeated && unit.square && (player === null || unit.owner === player),
  );
}

export function unitAt(state, square) {
  return liveUnits(state).find((unit) => unit.square === square) ?? null;
}

export function isLevy(unit) {
  return Boolean(unit.vassal_noble_id);
}

// Status and Level take priority; each color has its own coordinate keys.
export function usesStandardHarvestOrder(state) {
  return state.rules.harvest_order === "STANDARD_V15"
    || (state.rules.harvest_order === "STANDARD_V1" && (state.rules.player_count ?? 2) === 2);
}

export function orderedHarvestUnits(state, player) {
  const units = liveUnits(state, player);
  if (!usesStandardHarvestOrder(state)) return units;
  return units.sort((a, b) => {
    const status = Number(isLevy(a)) - Number(isLevy(b));
    const level = levelOf(a) - levelOf(b);
    if (status || level) return status || level;
    const aa = parseSquare(a.square);
    const bb = parseSquare(b.square);
    switch (player) {
      case PLAYER.WHITE: return bb.x - aa.x || bb.y - aa.y;
      case PLAYER.GREEN: return bb.y - aa.y || aa.x - bb.x;
      case PLAYER.RED: return bb.x - aa.x || aa.y - bb.y;
      default: return aa.y - bb.y || aa.x - bb.x;
    }
  });
}

export function deckSize(state, deck) {
  const cards = state.decks[deck];
  return Array.isArray(cards) ? cards.length : cards?.count ?? 0;
}

export function deriveConstants(state, actor = state.current_actor, defender = null) {
  const actingUnits = liveUnits(state, actor).length;
  const defendingUnits = defender ? liveUnits(state, defender).length : null;
  const nobleDeckCount = deckSize(state, DECK.NOBLE);
  const players = state.player_order ?? Object.keys(state.players);
  const hostages = players.filter((player) => state.players[player].dungeon_noble_id).length;
  const vassals = liveUnits(state).filter(isLevy).length;
  const nobleCardTotal = state.rules?.noble_card_total ?? (players.length === 4 ? 24 : 12);
  return {
    C: actingUnits * 2,
    D: nobleCardTotal - nobleDeckCount,
    S_mobilize: actingUnits,
    S_siege: defendingUnits,
    H: vassals + hostages,
  };
}

export function actionCost(state, action, details = {}) {
  const actor = details.actor ?? state.current_actor;
  const unit = details.unit_id ? state.units_by_id[details.unit_id] : null;
  const defender = details.defender_id ? state.units_by_id[details.defender_id] : null;
  const noble = details.noble_id ? state.nobles_by_id[details.noble_id] : null;
  const constants = deriveConstants(state, actor, defender?.owner ?? null);
  switch (action) {
    case "BUILD": return constants.C;
    case "UPGRADE": return LEVEL_BY_TYPE[details.to_type] * constants.C;
    case "RANSOM": return constants.D * noble.rank;
    case "RECRUIT": return 2 * constants.D;
    case "MOBILIZE": return constants.S_mobilize + levelOf(unit);
    case "SIEGE": return constants.S_siege + levelOf(defender);
    case "VASSALIZE": return constants.H * noble.rank;
    case "EXECUTE": return constants.H + noble.rank;
    default: throw new Error(`Unknown action: ${action}`);
  }
}

export function currentSuit(state) {
  return ACTIVE_SUIT_BY_PHASE[state.phase] ?? null;
}

export function deckForSuit(suit) {
  return suit === SUIT.CLOVERS || suit === SUIT.SPADES ? DECK.BLACK : DECK.RED;
}

export function deckForSquare(square) {
  return isBlackSquare(square) ? DECK.BLACK : DECK.RED;
}

export function effectiveCardValue(card) {
  return card.face_value + (card.has_counter ? 1 : 0);
}

export function sortResourceCards(cards) {
  const suitOrder = new Map(SUITS.map((suit, index) => [suit, index]));
  return [...cards].sort((left, right) => (
    suitOrder.get(left.suit) - suitOrder.get(right.suit)
    || effectiveCardValue(right) - effectiveCardValue(left)
    || right.face_value - left.face_value
    || left.card_id.localeCompare(right.card_id)
  ));
}

export function validBuildTargets(state, player) {
  const targets = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const square = toSquare(x, y);
      if (unitAt(state, square)) continue;
      const supported = liveUnits(state, player).some(
        (unit) => levelOf(unit) >= 2 && areAdjacent(unit.square, square),
      );
      if (supported) targets.push(square);
    }
  }
  return targets;
}

export function validUpgradeTypes(unit) {
  if (unit.unit_type === UNIT_TYPE.PAWN) {
    return [UNIT_TYPE.ROOK, UNIT_TYPE.KNIGHT, UNIT_TYPE.BISHOP];
  }
  if ([UNIT_TYPE.ROOK, UNIT_TYPE.KNIGHT, UNIT_TYPE.BISHOP].includes(unit.unit_type)) {
    return [UNIT_TYPE.QUEEN];
  }
  return [];
}

export function hasUpgradeSupport(state, unit, toType) {
  const needed = LEVEL_BY_TYPE[toType];
  return liveUnits(state, unit.owner).some(
    (other) => other.unit_id !== unit.unit_id
      && areAdjacent(other.square, unit.square)
      && levelOf(other) >= needed,
  );
}

const ORTHOGONAL = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
const ALL_DIRECTIONS = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]);

function pathDirections(unitType) {
  return unitType === UNIT_TYPE.ROOK ? ORTHOGONAL : ALL_DIRECTIONS;
}

export function legalMovementPaths(state, unitId) {
  const unit = state.units_by_id[unitId];
  if (!unit || unit.defeated || !unit.square || !isLevy(unit)) return [];
  const source = parseSquare(unit.square);
  const paths = [];
  const firstDirections = pathDirections(unit.unit_type);
  const maxSteps = unit.unit_type === UNIT_TYPE.PAWN ? 1 : 2;

  for (const [dx1, dy1] of firstDirections) {
    const firstSquare = toSquare(source.x + dx1, source.y + dy1);
    if (!firstSquare) continue;
    const firstOccupant = unitAt(state, firstSquare);
    if (!firstOccupant) paths.push([unit.square, firstSquare]);
    if (maxSteps === 1) continue;
    if (unit.unit_type !== UNIT_TYPE.KNIGHT && firstOccupant) continue;

    for (const [dx2, dy2] of pathDirections(unit.unit_type)) {
      const secondSquare = toSquare(source.x + dx1 + dx2, source.y + dy1 + dy2);
      if (!secondSquare || secondSquare === unit.square || unitAt(state, secondSquare)) continue;
      paths.push([unit.square, firstSquare, secondSquare]);
    }
  }
  return paths;
}

export function legalMovementDestinations(state, unitId) {
  return [...new Set(legalMovementPaths(state, unitId).map((path) => path.at(-1)))];
}

export function legalSiegeTargets(state, unitId) {
  const unit = state.units_by_id[unitId];
  if (!unit || !isLevy(unit) || !unit.square || unit.defeated) return [];
  return liveUnits(state)
    .filter((other) => other.owner !== unit.owner && areAdjacent(unit.square, other.square))
    .map((other) => other.unit_id);
}

export function storageBonusCount(state, player) {
  return liveUnits(state, player).filter((unit) => STORAGE_TYPE[unit.unit_type]).length;
}

export function recommendedStockpileIds(state, player) {
  const eligible = sortResourceCards(
    state.players[player].resource_hand_ids
      .map((id) => state.resources_by_id[id])
      .filter((card) => !card.tapped && card.mandatory_spend_year !== state.year_number),
  );
  const selected = [];
  const counts = Object.fromEntries(SUITS.map((suit) => [suit, 0]));

  for (const suit of SUITS) {
    const card = eligible.find((candidate) => candidate.suit === suit);
    if (!card) continue;
    selected.push(card.card_id);
    counts[suit] = 1;
  }

  const selectedSet = new Set(selected);
  const extras = [...eligible]
    .filter((card) => !selectedSet.has(card.card_id))
    .sort((left, right) => (
      effectiveCardValue(right) - effectiveCardValue(left)
      || right.face_value - left.face_value
      || SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit)
      || left.card_id.localeCompare(right.card_id)
    ));
  let bonusSlots = storageBonusCount(state, player);
  for (const card of extras) {
    if (!bonusSlots) break;
    if (counts[card.suit] !== 1) continue;
    selected.push(card.card_id);
    counts[card.suit] = 2;
    bonusSlots -= 1;
  }
  return selected;
}

export function validateStockpile(state, player, keptIds) {
  const unique = [...new Set(keptIds)];
  if (unique.length !== keptIds.length) return "Duplicate Resource Card selected";
  const cards = unique.map((id) => state.resources_by_id[id]);
  if (cards.some((card) => !card || !state.players[player].resource_hand_ids.includes(card.card_id))) {
    return "A selected Resource Card is not in the player's hand";
  }
  if (cards.some((card) => card.tapped || card.mandatory_spend_year === state.year_number)) {
    return "Tapped or mandatory-spend cards cannot be Stockpiled";
  }
  const counts = Object.fromEntries(SUITS.map((suit) => [suit, 0]));
  for (const card of cards) counts[card.suit] += 1;
  if (SUITS.some((suit) => counts[suit] > 2)) return "At most two cards of each suit may be Stockpiled";
  const bonusSlotsUsed = SUITS.reduce((sum, suit) => sum + Math.max(0, counts[suit] - 1), 0);
  if (bonusSlotsUsed > storageBonusCount(state, player)) return "Not enough bonus Stockpile slots";
  return null;
}

export function pokerKindForCards(state, cardIds) {
  const cards = cardIds.map((id) => state.resources_by_id[id]).filter(Boolean);
  const values = cards.map((card) => card.face_value).sort((a, b) => a - b);
  if (cards.length === 2 && values[0] === values[1]) return "PAIR";
  if (cards.length === 3 && values.every((value) => value === values[0])) return "THREE_OF_A_KIND";
  if (cards.length === 4 && values.every((value, index) => index === 0 || value === values[index - 1] + 1)) {
    return "FOUR_CARD_STRAIGHT";
  }
  return null;
}

// Include only declarations which add a Counter or a new mandatory-spend
// commitment. Repeating an already-resolved declaration is bookkeeping, not a choice.
export function availablePokerHands(state, player = state.current_actor) {
  const used = new Set(state.harvest?.poker_used_ids ?? []);
  const cards = state.players[player].resource_hand_ids.map((id) => state.resources_by_id[id])
    .filter((card) => card && !card.tapped && (state.rules.poker_overlap_allowed || !used.has(card.card_id)));
  const byValue = new Map();
  for (const card of cards) {
    if (!byValue.has(card.face_value)) byValue.set(card.face_value, []);
    byValue.get(card.face_value).push(card.card_id);
  }
  const hands = [];
  const add = (ids) => {
    if (!ids.some((id) => !state.resources_by_id[id].has_counter || state.resources_by_id[id].mandatory_spend_year !== state.year_number)) return;
    hands.push({ kind: pokerKindForCards(state, ids), card_ids: ids });
  };
  for (const ids of byValue.values()) {
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      add([ids[a], ids[b]]);
      for (let c = b + 1; c < ids.length; c++) add([ids[a], ids[b], ids[c]]);
    }
  }
  for (let start = 1; start <= 7; start++) {
    const groups = [0, 1, 2, 3].map((offset) => byValue.get(start + offset));
    if (groups.some((group) => !group)) continue;
    for (const a of groups[0]) for (const b of groups[1]) for (const c of groups[2]) for (const d of groups[3]) add([a, b, c, d]);
  }
  return hands;
}

export function hasBlackSquareUnit(state, player) {
  return liveUnits(state, player).some((unit) => isBlackSquare(unit.square));
}

export function validateInvariants(state) {
  const errors = [];
  const players = state.player_order ?? Object.keys(state.players);
  const live = liveUnits(state);
  const squares = new Set();
  for (const unit of live) {
    if (!parseSquare(unit.square)) errors.push(`${unit.unit_id} is off board`);
    if (squares.has(unit.square)) errors.push(`Multiple Units occupy ${unit.square}`);
    squares.add(unit.square);
    if (LEVEL_BY_TYPE[unit.unit_type] === undefined) errors.push(`${unit.unit_id} has invalid type`);
    if (unit.vassal_noble_id) {
      const noble = state.nobles_by_id[unit.vassal_noble_id];
      if (!noble || noble.assigned_unit_id !== unit.unit_id) errors.push(`${unit.unit_id} has broken Vassal link`);
    }
  }
  for (const noble of Object.values(state.nobles_by_id)) {
    if (noble.assigned_unit_id) {
      const unit = state.units_by_id[noble.assigned_unit_id];
      if (!unit || unit.vassal_noble_id !== noble.noble_id) errors.push(`${noble.noble_id} has broken Unit link`);
    }
  }
  for (const player of players) {
    if (state.players[player].seasonal_pools[SUIT.CLOVERS] < 0
      || state.players[player].seasonal_pools[SUIT.DIAMONDS] < 0
      || state.players[player].seasonal_pools[SUIT.SPADES] < 0
      || state.players[player].seasonal_pools[SUIT.HEARTS] < 0) {
      errors.push(`${player} has a negative seasonal pool`);
    }
    if (state.players[player].dungeon_noble_id) {
      const noble = state.nobles_by_id[state.players[player].dungeon_noble_id];
      if (!noble || noble.location !== `${player}_DUNGEON`) errors.push(`${player} Dungeon link is broken`);
    }
  }
  const locations = new Map();
  for (const deckName of [DECK.BLACK, DECK.RED]) {
    for (const cardId of state.decks[deckName]) {
      locations.set(cardId, (locations.get(cardId) ?? 0) + 1);
    }
  }
  for (const player of players) {
    for (const cardId of state.players[player].resource_hand_ids) {
      locations.set(cardId, (locations.get(cardId) ?? 0) + 1);
    }
  }
  for (const cardId of state.harvest?.offer_ids ?? []) {
    locations.set(cardId, (locations.get(cardId) ?? 0) + 1);
  }
  for (const id of Object.keys(state.resources_by_id)) {
    if (locations.get(id) !== 1) errors.push(`${id} has ${locations.get(id) ?? 0} locations`);
  }
  if (state.phase_notice) {
    if (state.phase_notice.phase !== state.phase) errors.push("Phase notice does not match the current phase");
    if (state.phase_notice.player && state.phase_notice.player !== state.current_actor) {
      errors.push("Phase notice does not match the current actor");
    }
  }
  const nobleCardTotal = state.rules?.noble_card_total ?? (players.length === 4 ? 24 : 12);
  if (deriveConstants(state).D !== nobleCardTotal - state.decks[DECK.NOBLE].length) errors.push("D invariant failed");
  const surviving = players.filter((player) => !state.players[player].eliminated);
  const liveKings = live.filter((unit) => unit.unit_type === UNIT_TYPE.KING);
  if (state.status === "ACTIVE" && liveKings.length !== surviving.length) {
    errors.push("Every surviving player must control exactly one live King");
  }
  if (state.status === "COMPLETE" && liveKings.length !== 1) {
    errors.push("A completed match must have exactly one live King");
  }
  return errors;
}

export function phaseAllowsTap(phase) {
  return ![PHASE.HARVEST, PHASE.STOCKPILE].includes(phase);
}

export function sovereignCandidates(state) {
  return state.sovereign_pool_ids.map((id) => state.nobles_by_id[id]);
}

export function courtNobles(state, player) {
  return state.players[player].court_noble_ids.map((id) => state.nobles_by_id[id]);
}

export function availableHoldingUnits(state, player) {
  return liveUnits(state, player).filter((unit) => !isLevy(unit));
}

export function canAfford(state, player, suit, amount) {
  return state.players[player].seasonal_pools[suit] >= amount;
}

export function isKingNoble(noble) {
  return noble.face === NOBLE_FACE.KING;
}

export { PLAYER };
