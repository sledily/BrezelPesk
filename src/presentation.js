import { PLAYER, UNIT_TYPE, SUIT, SUIT_GLYPH, NOBLE_NAME, NOBLE_DISPLAY_CODE, LEVEL_BY_TYPE, DECK } from "./constants.js";
import { liveUnits, isLevy, isCorner, deckForSquare, sortResourceCards } from "./rules.js";
import { formatNoble, formatResource, title } from "./format.js";

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

// Original, code-native chess illustrations; shared by board, reserve and inspection.
export function chessPieceSvg(type) {
  const crowns = {
    PAWN: '<circle cx="32" cy="19" r="8"/><path d="M26 28h12l-3 13 8 9H21l8-9z"/>',
    ROOK: '<path d="M17 10h8v8h5v-8h5v8h5v-8h7v18l-7 5 2 17H22l2-17-7-5z"/><path d="M23 28h18M26 36h12" fill="none"/>',
    KNIGHT: '<path d="M20 50c0-13 9-15 13-23l-12 6-7-7 12-13 1-7 7 5c15 1 17 18 12 39z"/><path d="m26 19-5 7m15-10c10 10 4 17 1 22" fill="none"/><circle cx="30" cy="18" r="1.5" class="piece-eye"/>',
    BISHOP: '<path d="M32 6c-5 7-12 10-12 17 0 6 6 10 12 10s12-4 12-10c0-7-7-10-12-17zM28 34h8l-2 7 9 9H21l9-9z"/><path d="m34 15-8 10" fill="none"/>',
    QUEEN: '<path d="m17 18 8 9 7-15 7 15 8-9-6 22H23zM25 40h14l4 10H21z"/><circle cx="16" cy="15" r="3"/><circle cx="32" cy="10" r="3"/><circle cx="48" cy="15" r="3"/><path d="M23 34h18" fill="none"/>',
    KING: '<path d="M29 6h6v6h6v6h-6v7h-6v-7h-6v-6h6zM20 26c-5 8 1 15 6 16l-5 8h22l-5-8c5-1 11-8 6-16l-12 5z"/><path d="M26 41h12" fill="none"/>',
  };
  return `<svg class="chess-piece" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g fill="currentColor" stroke="var(--piece-edge, #3c3026)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">${crowns[type] ?? crowns.PAWN}<path d="M21 50h22l4 7H17z"/><path d="M18 57h28v3H18z"/></g><path d="M23 54h17" stroke="white" opacity=".35" stroke-linecap="round"/></svg>`;
}

export function nobleCardHtml(noble) {
  if (!noble || noble.hidden) return '<span class="concealed-court">Hidden Court card</span>';
  const red = [SUIT.DIAMONDS, SUIT.HEARTS].includes(noble.suit);
  return `<span class="noble-card ${red ? "red" : ""}"><strong>${NOBLE_DISPLAY_CODE[noble.face]}${SUIT_GLYPH[noble.suit]}</strong><span>${escapeMarkup(NOBLE_NAME[noble.face]?.[noble.suit] ?? noble.name)}</span></span>`;
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
