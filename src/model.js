import {
  DEFAULT_RULES,
  DECK,
  FOUR_PLAYER_CLOCKWISE,
  FOUR_PLAYER_COUNTERCLOCKWISE,
  NOBLE_CODE,
  NOBLE_FACE,
  NOBLE_NAME,
  NOBLE_RANK,
  PLAYER,
  RESERVE_PROFILE,
  SUIT,
  SUIT_CODE,
  SUITS,
  TWO_PLAYER_ORDER,
  UNIT_TYPE,
  playerCode,
} from "./constants.js";
import { normalizeSeed, shuffleWithState } from "./rng.js";
import { snapshotChronicleEntry } from "./notation.js";

export function deepClone(value) {
  return structuredClone(value);
}

export function makeResourceCards(copies = 1) {
  const cards = {};
  for (const suit of SUITS) {
    for (let value = 1; value <= 10; value += 1) {
      for (let copy = 0; copy < copies; copy += 1) {
        const suffix = copies === 1 ? "" : `-${String.fromCharCode(65 + copy)}`;
        const id = `RC-${SUIT_CODE[suit]}-${String(value).padStart(2, "0")}${suffix}`;
        cards[id] = {
          card_id: id,
          suit,
          face_value: value,
          copy: copy + 1,
          has_counter: false,
          location: suit === SUIT.CLOVERS || suit === SUIT.SPADES ? "BLACK_DECK" : "RED_DECK",
          tapped: false,
          mandatory_spend_year: null,
        };
      }
    }
  }
  return cards;
}

export function makeNobleCards(copies = 1) {
  const cards = {};
  for (const face of [NOBLE_FACE.JACK, NOBLE_FACE.QUEEN, NOBLE_FACE.KING]) {
    for (const suit of SUITS) {
      for (let copy = 0; copy < copies; copy += 1) {
        const suffix = copies === 1 ? "" : `-${String.fromCharCode(65 + copy)}`;
        const id = `NC-${NOBLE_CODE[face]}-${SUIT_CODE[suit]}${suffix}`;
        cards[id] = {
          noble_id: id,
          face,
          rank: NOBLE_RANK[face],
          suit,
          copy: copy + 1,
          name: NOBLE_NAME[face][suit],
          location: face === NOBLE_FACE.KING ? "SOVEREIGN_POOL" : "NOBLE_DECK",
          owner: null,
          assigned_unit_id: null,
        };
      }
    }
  }
  return cards;
}

function makePlayer(playerId) {
  return {
    player_id: playerId,
    unit_ids: [],
    resource_hand_ids: [],
    court_noble_ids: [],
    dungeon_noble_id: null,
    seasonal_pools: {
      [SUIT.CLOVERS]: 0,
      [SUIT.DIAMONDS]: 0,
      [SUIT.SPADES]: 0,
      [SUIT.HEARTS]: 0,
    },
    reserve: { ...RESERVE_PROFILE },
    next_unit_serial: 2,
    eliminated: false,
    advises_player: null,
    advice_until_unit_id: null,
  };
}

export function createInitialState({ seed = "dendarv", rules = {}, matchId = null, playerCount = null } = {}) {
  const requestedPlayerCount = Number(playerCount ?? rules.player_count ?? DEFAULT_RULES.player_count);
  if (![2, 4].includes(requestedPlayerCount)) throw new Error("Dendarv supports two or four players");
  const settings = {
    ...DEFAULT_RULES,
    ...rules,
    player_count: requestedPlayerCount,
    noble_card_total: requestedPlayerCount === 4 ? 24 : 12,
  };
  const copies = requestedPlayerCount === 4 ? 2 : 1;
  let rngState = normalizeSeed(seed);
  const resources = makeResourceCards(copies);
  const nobles = makeNobleCards(copies);

  const blackResourceIds = Object.values(resources)
    .filter((card) => card.location === "BLACK_DECK")
    .map((card) => card.card_id);
  const redResourceIds = Object.values(resources)
    .filter((card) => card.location === "RED_DECK")
    .map((card) => card.card_id);
  const ordinaryNobleIds = Object.values(nobles)
    .filter((card) => card.location === "NOBLE_DECK")
    .map((card) => card.noble_id);

  const blackShuffle = shuffleWithState(blackResourceIds, rngState);
  rngState = blackShuffle.state;
  const redShuffle = shuffleWithState(redResourceIds, rngState);
  rngState = redShuffle.state;
  const nobleShuffle = shuffleWithState(ordinaryNobleIds, rngState);
  rngState = nobleShuffle.state;

  const playerOrder = requestedPlayerCount === 4
    ? [...FOUR_PLAYER_COUNTERCLOCKWISE]
    : [...TWO_PLAYER_ORDER];
  const setupOrder = requestedPlayerCount === 4
    ? [PLAYER.GREEN, PLAYER.BLACK, PLAYER.RED, PLAYER.WHITE]
    : [PLAYER.BLACK, PLAYER.WHITE];
  const players = Object.fromEntries(playerOrder.map((player) => [player, makePlayer(player)]));
  const startSquares = {
    [PLAYER.WHITE]: settings.white_start_square,
    [PLAYER.GREEN]: settings.green_start_square,
    [PLAYER.BLACK]: settings.black_start_square,
    [PLAYER.RED]: settings.red_start_square,
  };
  const units = {};
  for (const player of playerOrder) {
    const unitId = `U-${playerCode(player)}-001`;
    units[unitId] = {
      unit_id: unitId,
      owner: player,
      piece_color: player,
      unit_type: UNIT_TYPE.KING,
      square: startSquares[player],
      vassal_noble_id: null,
      defeated: false,
      irreplaceable: false,
      captured_from: null,
    };
    players[player].unit_ids.push(unitId);
  }

  const state = {
    schema_version: 1,
    ruleset_version: settings.ruleset_version,
    rules: settings,
    match_id: matchId ?? `DEN-${Date.now().toString(36).toUpperCase()}`,
    seed: String(seed),
    rng_state: rngState,
    status: "SETUP",
    setup_step: `${setupOrder[0]}_SOVEREIGN`,
    setup_order: setupOrder,
    setup_index: 0,
    player_order: playerOrder,
    year_number: 0,
    phase: null,
    button_holder: PLAYER.WHITE,
    phase_actor_order: [...playerOrder],
    current_actor: setupOrder[0],
    passed_players: [],
    players,
    units_by_id: units,
    resources_by_id: resources,
    nobles_by_id: nobles,
    decks: {
      [DECK.BLACK]: blackShuffle.items,
      [DECK.RED]: redShuffle.items,
      [DECK.NOBLE]: nobleShuffle.items,
    },
    sovereign_pool_ids: Object.values(nobles)
      .filter((card) => card.face === NOBLE_FACE.KING)
      .map((card) => card.noble_id),
    harvest: null,
    active_ransom: null,
    ransom_queue: [],
    phase_notice: null,
    pending_combat: null,
    pending_conquest: null,
    stockpile_committed: {},
    winner: null,
    victory_reason: null,
    event_sequence: 0,
    event_log: [],
    command_log: [],
  };

  recordEvent(state, "MatchCreated", {
    seed: state.seed,
    rules: state.rules,
    player_count: requestedPlayerCount,
    black_resource_order: state.decks[DECK.BLACK],
    red_resource_order: state.decks[DECK.RED],
    noble_order_without_kings: state.decks[DECK.NOBLE],
  });
  return state;
}

export function recordEvent(state, type, payload = {}, visibility = "PUBLIC") {
  state.event_sequence += 1;
  const event = {
    event_id: `EV-${String(state.event_sequence).padStart(6, "0")}`,
    sequence: state.event_sequence,
    match_id: state.match_id,
    ruleset_version: state.ruleset_version,
    year: state.year_number,
    phase: state.phase,
    actor: state.current_actor,
    type,
    visibility,
    payload: deepClone(payload),
  };
  const chronicle = snapshotChronicleEntry(state, type, payload);
  if (chronicle) event.payload.chronicle = chronicle;
  state.event_log.push(event);
  return event;
}

export function newUnitId(state, player) {
  const serial = state.players[player].next_unit_serial;
  state.players[player].next_unit_serial += 1;
  return `U-${playerCode(player)}-${String(serial).padStart(3, "0")}`;
}

export function playerLocation(player, kind) {
  return `${player}_${kind}`;
}

export function allCardIds(state) {
  return [
    ...Object.keys(state.resources_by_id),
    ...Object.keys(state.nobles_by_id),
  ];
}

export function createReplayBaseFromCreatedEvent(event) {
  if (event.type !== "MatchCreated") throw new Error("Replay must start with MatchCreated");
  return createInitialState({
    seed: event.payload.seed,
    rules: event.payload.rules,
    matchId: event.match_id,
  });
}

export function sortedPlayersFromButton(button) {
  return button === PLAYER.WHITE
    ? [PLAYER.WHITE, PLAYER.BLACK]
    : [PLAYER.BLACK, PLAYER.WHITE];
}

export function matchPlayers(state) {
  return state.player_order ?? Object.keys(state.players);
}

export function survivingPlayers(state) {
  return matchPlayers(state).filter((player) => !state.players[player]?.eliminated);
}

function rotateFrom(order, player) {
  const index = order.indexOf(player);
  if (index < 0) return [...order];
  return [...order.slice(index), ...order.slice(0, index)];
}

export function phaseOrderFromButton(state) {
  if ((state.rules?.player_count ?? matchPlayers(state).length) === 2) {
    return rotateFrom(TWO_PLAYER_ORDER, state.button_holder)
      .filter((player) => state.players[player] && !state.players[player].eliminated);
  }
  const direction = state.year_number % 2 === 0
    ? FOUR_PLAYER_COUNTERCLOCKWISE
    : FOUR_PLAYER_CLOCKWISE;
  return rotateFrom(direction, state.button_holder)
    .filter((player) => state.players[player] && !state.players[player].eliminated);
}

export function nextSurvivingClockwise(state, player = state.button_holder) {
  const clockwise = (state.rules?.player_count ?? matchPlayers(state).length) === 4
    ? FOUR_PLAYER_CLOCKWISE
    : TWO_PLAYER_ORDER;
  const rotated = rotateFrom(clockwise, player);
  for (const candidate of rotated.slice(1).concat(rotated.slice(0, 1))) {
    if (state.players[candidate] && !state.players[candidate].eliminated) return candidate;
  }
  return player;
}
