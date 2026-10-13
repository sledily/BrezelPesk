import { PLAYER, UNIT_TYPE, SUIT, SUIT_GLYPH, NOBLE_NAME, NOBLE_DISPLAY_CODE, LEVEL_BY_TYPE, DECK } from "./constants.js";
import { liveUnits, isLevy, isCorner, deckForSquare, sortResourceCards } from "./rules.js";
import { formatNoble, formatResource, title } from "./format.js";
import { COURT_ART } from "./court-art.js";

export const PIECE_GLYPH = {
  [PLAYER.WHITE]: {
    [UNIT_TYPE.PAWN]: "♙",
    [UNIT_TYPE.ROOK]: "♖",
    [UNIT_TYPE.KNIGHT]: "♘",
    [UNIT_TYPE.BISHOP]: "♗",
    [UNIT_TYPE.QUEEN]: "♕",
    [UNIT_TYPE.KING]: "♔",
  },
  [PLAYER.BLACK]: {
    [UNIT_TYPE.PAWN]: "♟",
    [UNIT_TYPE.ROOK]: "♜",
    [UNIT_TYPE.KNIGHT]: "♞",
    [UNIT_TYPE.BISHOP]: "♝",
    [UNIT_TYPE.QUEEN]: "♛",
    [UNIT_TYPE.KING]: "♚",
  },
  [PLAYER.GREEN]: {
    [UNIT_TYPE.PAWN]: "♙",
    [UNIT_TYPE.ROOK]: "♖",
    [UNIT_TYPE.KNIGHT]: "♘",
    [UNIT_TYPE.BISHOP]: "♗",
    [UNIT_TYPE.QUEEN]: "♕",
    [UNIT_TYPE.KING]: "♔",
  },
  [PLAYER.RED]: {
    [UNIT_TYPE.PAWN]: "♟",
    [UNIT_TYPE.ROOK]: "♜",
    [UNIT_TYPE.KNIGHT]: "♞",
    [UNIT_TYPE.BISHOP]: "♝",
    [UNIT_TYPE.QUEEN]: "♛",
    [UNIT_TYPE.KING]: "♚",
  },
};

export function escapeMarkup(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function pieceIcon(unit) {
  const color = unit.piece_color ?? unit.owner;
  return `<span class="realm-piece ${color.toLowerCase()}" role="img" aria-label="${title(unit.unit_type)}">${chessPieceSvg(unit.unit_type)}</span>`;
}

// Approved Court-inspired painted miniatures; every SVG is self-contained.
// The shared renderer keeps board, reserves, inspection, Harvest and replay consistent.
const MINIATURE_PLINTH = '<path class="miniature-body" d="M18 62Q32 57 46 62L48 67Q32 75 16 67Z"/><path class="miniature-highlight" d="M20 64Q32 68 43 64"/><path class="miniature-etch" d="M19 69L21 65M24 70L25 66M29 71L29 67M34 71L34 67M39 70L38 66M44 69L43 65"/>';
const PAINTED_MINIATURE_ART = Object.freeze({
  PAWN: '<path class="miniature-body" d="M21 35Q18 16 31 13Q45 17 43 35L39 38Q46 43 45 61Q32 69 19 61Q18 44 25 38Z"/><path class="miniature-face" d="M25 24Q32 18 39 24V33Q36 40 31 39Q25 37 25 30Z"/><path class="miniature-shade" d="M33 41L43 41L45 61L36 65Z"/><path class="miniature-highlight" d="M23 43L21 58M30 44L28 61M34 48L33 60"/><path class="miniature-gold" d="M24 44L35 46L34 55L28 59L23 53Z"/><path class="miniature-etch" d="M28 27H29M35 27H36M32 29V33L34 33M29 36H34M27 48L31 49M25 51L32 52"/>',
  ROOK: '<path class="miniature-body" d="M16 10H24V19H29V10H35V19H40V10H48V30L43 32V61Q32 66 21 61V32L16 30Z"/><path class="miniature-shade" d="M38 32H43V61L36 64V38Z"/><path class="miniature-gold" d="M20 28H44V33H20Z"/><path class="miniature-shade" d="M27 58V47Q32 37 37 47V58Z"/><path class="miniature-highlight" d="M21 13V24M25 35V42M25 45V57M29 48Q32 43 35 48M19 60H25"/><path class="miniature-etch" d="M22 38H42M22 46H26M38 46H43M22 53H27M37 54H43M31 33V38M35 38V43M25 56V61M40 56V62"/>',
  KNIGHT: '<path class="miniature-body" d="M20 63Q17 51 29 38L24 31L19 32L12 27L23 17L26 7L31 15L36 9L38 19Q47 28 47 43Q47 57 41 63Z"/><path class="miniature-shade" d="M38 23Q50 42 39 61L42 63Q51 43 46 32Q43 25 38 23Z"/><path class="miniature-gold" d="M24 31L28 36L27 40L22 38L20 33ZM23 47Q35 42 44 46L44 51Q35 49 21 54Z"/><path class="miniature-highlight" d="M25 20L18 26M29 41Q22 49 24 59M30 23Q37 24 38 31M28 50L37 49"/><path class="miniature-etch" d="M17 26L21 27M33 34Q40 40 34 44M35 18L37 22M38 27L43 30M39 33L45 35M39 38L46 41M39 53L43 55M36 58L41 60"/><circle cx="29" cy="26" r="1.65" fill="var(--piece-edge, #282b24)"/>',
  BISHOP: '<path class="miniature-body" d="M32 4L22 17L22 27Q31 33 42 27V17Z"/><path class="miniature-face" d="M25 28H39V35Q37 43 31 42Q25 40 25 35Z"/><path class="miniature-body" d="M24 39L18 46L19 63Q33 69 46 62L45 45L39 39L32 46Z"/><path class="miniature-gold" d="M31 13H34V27H31ZM23 40L32 47L40 40L41 45L34 51L35 63H30L31 51L22 45Z"/><path class="miniature-highlight" d="M26 18L25 24M23 49V60M40 49L42 59"/><path class="miniature-etch" d="M35 19L40 22M35 23L40 26M29 32H30M35 32H36M32 34V38M29 40H35M38 49L43 52M37 53L43 56M36 58L43 60"/>',
  QUEEN: '<path class="miniature-body" d="M24 28Q19 36 21 42L18 46L17 62Q33 71 47 62L45 44L40 40Q44 33 40 28Z"/><path class="miniature-face" d="M24 22Q32 16 40 22V33Q36 42 31 39Q25 37 24 30Z"/><path class="miniature-gold" d="M20 13L25 19L27 9L33 18L38 9L40 19L45 13L42 26Q32 31 22 26Z"/><path class="miniature-body" d="M23 42L31 49L41 41L45 47L41 62L31 65L21 60L19 47Z"/><path class="miniature-gold" d="M29 45L33 45L34 54L39 61L33 64L26 62L30 54Z"/><circle class="miniature-gold" cx="32" cy="23" r="2.2"/><path class="miniature-highlight" d="M24 48L22 56M39 48L41 55M25 60L28 61"/><path class="miniature-etch" d="M27 30H29M35 30H37M32 31V35M29 37H34M35 49L41 52M35 53L40 56M35 58L41 60"/>',
  KING: '<path class="miniature-gold" d="M29 3H35V9H41V14H35V20H29V14H23V9H29Z"/><path class="miniature-face" d="M23 26Q32 20 41 26V34Q37 44 31 43Q23 39 23 34Z"/><path class="miniature-gold" d="M20 19L25 25L29 20L33 25L38 20L42 25L46 19L43 30Q31 33 21 30Z"/><path class="miniature-body" d="M24 41L16 47L18 62Q32 70 48 62L47 47L40 41L32 47Z"/><path class="miniature-gold" d="M23 43L32 49L41 43L42 47L32 54L22 47ZM30 53H34L35 63H29Z"/><path class="miniature-shade" d="M24 35L29 40H35L40 35L38 42L32 45L26 42Z"/><path class="miniature-highlight" d="M21 50L22 59M41 50L44 59M25 63L28 64"/><path class="miniature-etch" d="M27 34H29M35 34H37M32 35V39M27 55L29 57M36 54L43 57M36 58L45 61M30 39H35"/>',
});

export function chessPieceSvg(type) {
  const pieceType = Object.hasOwn(PAINTED_MINIATURE_ART, type) ? type : UNIT_TYPE.PAWN;
  return `<svg class="chess-piece painted-miniature" data-piece-type="${pieceType.toLowerCase()}" viewBox="0 0 64 80" aria-hidden="true" focusable="false">${MINIATURE_PLINTH}${PAINTED_MINIATURE_ART[pieceType]}</svg>`;
}

export function nobleCardHtml(noble, { illustrated = false } = {}) {
  if (!noble || noble.hidden) return '<span class="concealed-court">Hidden Court card</span>';
  const red = [SUIT.DIAMONDS, SUIT.HEARTS].includes(noble.suit);
  const art = illustrated ? COURT_ART[`${noble.face}:${noble.suit}`] : null;
  const caption = `<strong>${NOBLE_DISPLAY_CODE[noble.face]}${SUIT_GLYPH[noble.suit]}</strong><span>${escapeMarkup(NOBLE_NAME[noble.face]?.[noble.suit] ?? noble.name)}</span>`;
  return `<span class="noble-card ${red ? "red" : ""} ${art ? 'illustrated' : ''}" title="${escapeMarkup(formatNoble(noble))}">${art ? `<img class="noble-art" src="${art}" alt="${escapeMarkup(formatNoble(noble))}" width="1024" height="1536" decoding="async"><span class="noble-caption">${caption}</span>` : `<strong>${NOBLE_DISPLAY_CODE[noble.face]}${SUIT_GLYPH[noble.suit]}</strong>`}</span>`;
}

export function realmComparisonHtml(state, viewer, playerNames = {}) {
  const players = state.player_order ?? Object.keys(state.players);
  const playerUnits = Object.fromEntries(players.map((player) => [player, liveUnits(state, player)]));
  const cells = (renderCell) => players.map((player) => `<div class="realm-cell ${player.toLowerCase()}">${renderCell(player)}</div>`).join("");
  const row = (label, renderCell) => `<div class="comparison-label">${label}</div><div class="comparison-row">${cells(renderCell)}</div>`;
  const unitsHtml = (player, levies) => {
    const units = playerUnits[player].filter((unit) => isLevy(unit) === levies);
    return units.length ? units.map((unit) => `<div class="realm-unit">${pieceIcon(unit)}<span class="unit-position">${unit.square}</span>${levies ? nobleCardHtml(state.nobles_by_id[unit.vassal_noble_id]) : ""}</div>`).join("") : '<span class="empty-state">None</span>';
  };
  return `<div class="realm-comparison" style="--realm-count:${players.length}" tabindex="0" aria-label="Players side by side">
    <div class="comparison-row comparison-head">${cells((player) => `<strong>${title(player)}</strong>${playerNames[player] ? `<span>${escapeMarkup(playerNames[player])}</span>` : ""}<span class="realm-meta">${state.players[player].eliminated ? "Eliminated" : `${playerUnits[player].length} Units · ${playerUnits[player].filter(isLevy).length} Levies`}</span>${state.current_actor === player && state.status !== "COMPLETE" ? '<span class="acting-label">Acting</span>' : ""}`)}</div>
    ${row("Resources", (player) => {
      const hand = sortResourceCards(state.players[player].resource_hand_ids.map((id) => state.resources_by_id[id]).filter(Boolean));
      return hand.length ? `<div class="realm-resources">${hand.map((card) => `<span class="card-token ${[SUIT.DIAMONDS, SUIT.HEARTS].includes(card.suit) ? "red" : ""} ${card.tapped ? "tapped" : ""} ${card.mandatory_spend_year === state.year_number ? "mandatory" : ""}" title="${card.tapped ? "Tapped" : "Available"}">${formatResource(card)}</span>`).join("")}</div>` : '<span class="empty-state">No Resources</span>';
    })}
    ${row("Holdings", (player) => unitsHtml(player, false))}
    ${row("Levies", (player) => unitsHtml(player, true))}
    ${row("Court", (player) => {
      const ids = state.players[player].court_noble_ids;
      if (!ids.length) return '<span class="empty-state">Empty</span>';
      return player === viewer ? `<div class="court-cards">${ids.map((id) => nobleCardHtml(state.nobles_by_id[id])).join("")}</div>` : `<span class="concealed-court" aria-label="${ids.length} hidden Court cards"><span aria-hidden="true">▧</span> ${ids.length} hidden card${ids.length === 1 ? "" : "s"}</span>`;
    })}
    ${row("Dungeon", (player) => {
      const id = state.players[player].dungeon_noble_id;
      const noble = state.nobles_by_id[id];
      return id ? `${nobleCardHtml(noble)}<span class="realm-meta">Hostage of ${title(noble?.owner)}</span>` : '<span class="empty-state">Empty</span>';
    })}
  </div>`;
}

export const HARVEST_COORDINATE_GUIDE = Object.freeze({
  WHITE: "Letters h → a, then numbers 8 → 1.",
  GREEN: "Numbers 8 → 1, then letters a → h.",
  BLACK: "Numbers 1 → 8, then letters a → h.",
  RED: "Letters h → a, then numbers 1 → 8.",
});

export function harvestListHtml(state) {
  const h = state.harvest;
  const ids = h.ordered_unit_ids ?? h.remaining_unit_ids;
  return `<ol class="harvest-list">${ids.map((id, index) => {
    const unit = state.units_by_id[id];
    const done = !h.remaining_unit_ids.includes(id);
    const current = h.remaining_unit_ids[0] === id;
    const pending = h.unit_id === id && h.offer_ids.length;
    const decks = isCorner(unit.square) ? [DECK.BLACK, DECK.RED] : [deckForSquare(unit.square)];
    const noble = state.nobles_by_id[unit.vassal_noble_id];
    return `<li class="harvest-piece ${done ? "completed" : ""} ${current ? "current" : ""}" value="${index + 1}">
      <span class="harvest-number">${index + 1}</span><div class="harvest-piece-label">${pieceIcon(unit)}<div><strong>${title(unit.unit_type)} · ${unit.square}</strong><small>${isLevy(unit) ? "Levy" : "Holding"} · Level ${LEVEL_BY_TYPE[unit.unit_type]}</small>${noble ? nobleCardHtml(noble) : ""}</div></div>
      <div class="harvest-decks">${decks.map((deck) => `<button class="button harvest-draw deck-${deck.toLowerCase()}" data-unit-id="${id}" data-deck="${deck}" ${done || pending || h.failsafe_pending ? "disabled" : ""} aria-label="Harvest piece ${index + 1}, ${title(unit.unit_type)} at ${unit.square}, ${title(deck)} deck">${title(deck)} ${deck === DECK.BLACK ? "♧ ♤" : "◇ ♡"}</button>`).join("")}${done ? '<span class="harvest-completed">✓ Harvested</span>' : pending ? '<span class="harvest-completed">Choose a card below</span>' : ""}</div>
    </li>`;
  }).join("")}</ol>`;
}
