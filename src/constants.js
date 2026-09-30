export const PLAYER = Object.freeze({
  WHITE: "WHITE",
  GREEN: "GREEN",
  BLACK: "BLACK",
  RED: "RED",
});

export const PLAYERS = Object.freeze([
  PLAYER.WHITE,
  PLAYER.GREEN,
  PLAYER.BLACK,
  PLAYER.RED,
]);

export const TWO_PLAYER_ORDER = Object.freeze([PLAYER.WHITE, PLAYER.BLACK]);
export const FOUR_PLAYER_COUNTERCLOCKWISE = Object.freeze([
  PLAYER.WHITE,
  PLAYER.GREEN,
  PLAYER.BLACK,
  PLAYER.RED,
]);
export const FOUR_PLAYER_CLOCKWISE = Object.freeze([
  PLAYER.WHITE,
  PLAYER.RED,
  PLAYER.BLACK,
  PLAYER.GREEN,
]);

export const UNIT_TYPE = Object.freeze({
  PAWN: "PAWN",
  ROOK: "ROOK",
  KNIGHT: "KNIGHT",
  BISHOP: "BISHOP",
  QUEEN: "QUEEN",
  KING: "KING",
});

export const SUIT = Object.freeze({
  CLOVERS: "CLOVERS",
  DIAMONDS: "DIAMONDS",
  SPADES: "SPADES",
  HEARTS: "HEARTS",
});

export const SUITS = Object.freeze([
  SUIT.CLOVERS,
  SUIT.DIAMONDS,
  SUIT.SPADES,
  SUIT.HEARTS,
]);

export const DECK = Object.freeze({ RED: "RED", BLACK: "BLACK", NOBLE: "NOBLE" });

export const NOBLE_FACE = Object.freeze({ JACK: "JACK", QUEEN: "QUEEN", KING: "KING" });

export const PHASE = Object.freeze({
  HARVEST: "HARVEST",
  BUILD: "BUILD",
  UPGRADE: "UPGRADE",
  RANSOM: "RANSOM",
  RECRUIT: "RECRUIT",
  MOBILIZE: "MOBILIZE",
  SIEGE: "SIEGE",
  VASSALIZE: "VASSALIZE",
  EXECUTE: "EXECUTE",
  STOCKPILE: "STOCKPILE",
});

export const PHASE_ORDER = Object.freeze([
  PHASE.HARVEST,
  PHASE.BUILD,
  PHASE.UPGRADE,
  PHASE.RANSOM,
  PHASE.RECRUIT,
  PHASE.MOBILIZE,
  PHASE.SIEGE,
  PHASE.VASSALIZE,
  PHASE.EXECUTE,
  PHASE.STOCKPILE,
]);

export const SEASON_BY_PHASE = Object.freeze({
  [PHASE.HARVEST]: "HARVEST",
  [PHASE.BUILD]: "WINTER",
  [PHASE.UPGRADE]: "WINTER",
  [PHASE.RANSOM]: "SPRING",
  [PHASE.RECRUIT]: "SPRING",
  [PHASE.MOBILIZE]: "SUMMER",
  [PHASE.SIEGE]: "SUMMER",
  [PHASE.VASSALIZE]: "FALL",
  [PHASE.EXECUTE]: "FALL",
  [PHASE.STOCKPILE]: "YEAR_END",
});

export const ACTIVE_SUIT_BY_PHASE = Object.freeze({
  [PHASE.BUILD]: SUIT.CLOVERS,
  [PHASE.UPGRADE]: SUIT.CLOVERS,
  [PHASE.RANSOM]: SUIT.DIAMONDS,
  [PHASE.RECRUIT]: SUIT.DIAMONDS,
  [PHASE.MOBILIZE]: SUIT.SPADES,
  [PHASE.SIEGE]: SUIT.SPADES,
  [PHASE.VASSALIZE]: SUIT.HEARTS,
  [PHASE.EXECUTE]: SUIT.HEARTS,
});

export const LEVEL_BY_TYPE = Object.freeze({
  [UNIT_TYPE.PAWN]: 1,
  [UNIT_TYPE.ROOK]: 2,
  [UNIT_TYPE.KNIGHT]: 2,
  [UNIT_TYPE.BISHOP]: 2,
  [UNIT_TYPE.QUEEN]: 3,
  [UNIT_TYPE.KING]: 3,
});

export const DRAW_COUNT_BY_TYPE = Object.freeze({
  [UNIT_TYPE.PAWN]: 1,
  [UNIT_TYPE.ROOK]: 2,
  [UNIT_TYPE.KNIGHT]: 1,
  [UNIT_TYPE.BISHOP]: 2,
  [UNIT_TYPE.QUEEN]: 3,
  [UNIT_TYPE.KING]: 3,
});

export const STORAGE_TYPE = Object.freeze({
  [UNIT_TYPE.PAWN]: false,
  [UNIT_TYPE.ROOK]: true,
  [UNIT_TYPE.KNIGHT]: false,
  [UNIT_TYPE.BISHOP]: false,
  [UNIT_TYPE.QUEEN]: true,
  [UNIT_TYPE.KING]: true,
});

export const PIECE_CODE = Object.freeze({
  [UNIT_TYPE.PAWN]: "P",
  [UNIT_TYPE.ROOK]: "R",
  [UNIT_TYPE.KNIGHT]: "N",
  [UNIT_TYPE.BISHOP]: "B",
  [UNIT_TYPE.QUEEN]: "Q",
  [UNIT_TYPE.KING]: "K",
});

export const SUIT_CODE = Object.freeze({
  [SUIT.CLOVERS]: "C",
  [SUIT.DIAMONDS]: "D",
  [SUIT.SPADES]: "S",
  [SUIT.HEARTS]: "H",
});

export const SUIT_GLYPH = Object.freeze({
  [SUIT.CLOVERS]: "♧",
  [SUIT.DIAMONDS]: "◇",
  [SUIT.SPADES]: "♤",
  [SUIT.HEARTS]: "♡",
});

export const NOBLE_CODE = Object.freeze({
  [NOBLE_FACE.JACK]: "J",
  [NOBLE_FACE.QUEEN]: "Q",
  [NOBLE_FACE.KING]: "K",
});

export const NOBLE_DISPLAY_CODE = Object.freeze({
  [NOBLE_FACE.JACK]: "Vz",
  [NOBLE_FACE.QUEEN]: "Dx",
  [NOBLE_FACE.KING]: "Rx",
});

export const NOBLE_NAME = Object.freeze({
  [NOBLE_FACE.JACK]: Object.freeze({
    [SUIT.CLOVERS]: "Colbert",
    [SUIT.DIAMONDS]: "Catherine De Medici",
    [SUIT.SPADES]: "Barbarrosa Heyreddin",
    [SUIT.HEARTS]: "La Malinche",
  }),
  [NOBLE_FACE.QUEEN]: Object.freeze({
    [SUIT.CLOVERS]: "Heinrich the Lion",
    [SUIT.DIAMONDS]: "Eleanor of Aquitaine",
    [SUIT.SPADES]: "Jean d'Arc",
    [SUIT.HEARTS]: "Innocent",
  }),
  [NOBLE_FACE.KING]: Object.freeze({
    [SUIT.CLOVERS]: "Boudica",
    [SUIT.DIAMONDS]: "Caesar",
    [SUIT.SPADES]: "David",
    [SUIT.HEARTS]: "Cleopatra",
  }),
});

export const NOBLE_RANK = Object.freeze({
  [NOBLE_FACE.JACK]: 1,
  [NOBLE_FACE.QUEEN]: 2,
  [NOBLE_FACE.KING]: 3,
});

export const RESERVE_PROFILE = Object.freeze({
  [UNIT_TYPE.PAWN]: 8,
  [UNIT_TYPE.ROOK]: 2,
  [UNIT_TYPE.KNIGHT]: 2,
  [UNIT_TYPE.BISHOP]: 2,
  [UNIT_TYPE.QUEEN]: 1,
  [UNIT_TYPE.KING]: 0,
});

export const DEFAULT_RULES = Object.freeze({
  ruleset_version: "1.2-digital-1.5",
  harvest_order: "STANDARD_V15",
  automatic_passes: true,
  player_count: 2,
  resource_hands_public: true,
  harvest_failsafe_enabled: true,
  harvest_returns_immediately: true,
  poker_overlap_allowed: true,
  purposeless_tapping_allowed: false,
  levies_retain_vassals_on_upgrade: true,
  white_start_square: "a1",
  green_start_square: "h1",
  black_start_square: "h8",
  red_start_square: "a8",
});

export function otherPlayer(player) {
  return player === PLAYER.WHITE ? PLAYER.BLACK : PLAYER.WHITE;
}

export function playerCode(player) {
  return {
    [PLAYER.WHITE]: "W",
    [PLAYER.GREEN]: "G",
    [PLAYER.BLACK]: "B",
    [PLAYER.RED]: "R",
  }[player] ?? "?";
}

export function phaseLabel(phase) {
  return phase.charAt(0) + phase.slice(1).toLowerCase();
}
