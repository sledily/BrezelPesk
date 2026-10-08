import { ACTIVE_SUIT_BY_PHASE, PHASE, PHASE_ORDER, SUITS, SUIT, SUIT_GLYPH, UNIT_TYPE, LEVEL_BY_TYPE, STORAGE_TYPE } from "./constants.js";
import { deriveConstants, sortResourceCards, liveUnits, drawCountOf, isLevy, actionCost } from "./rules.js";
import { escapeMarkup, pieceIcon, nobleCardHtml } from "./presentation.js";
import { formatNoble, formatResource, title } from "./format.js";

export function calendarHtml(state) {
  const index = PHASE_ORDER.indexOf(state.phase);
  return `<div class="year-calendar"><svg viewBox="0 0 100 100" role="img" aria-label="Ten-phase Year calendar: ${escapeMarkup(title(state.phase ?? 'Setup'))}"><circle cx="50" cy="50" r="34" class="calendar-orbit"/>${PHASE_ORDER.map((phase, i) => {
    const a = (i * 36 - 90) * Math.PI / 180;
    return `<circle cx="${50 + 34 * Math.cos(a)}" cy="${50 + 34 * Math.sin(a)}" r="${index === i ? 7 : 4}" class="calendar-phase ${index === i ? 'current' : i < index ? 'done' : ''}"><title>${i + 1}. ${title(phase)}${index === i ? ' — current' : i < index ? ' — completed' : ' — upcoming'}</title></circle>`;
  }).join('')}<text x="50" y="47" text-anchor="middle">YEAR</text><text x="50" y="66" text-anchor="middle" class="calendar-year">${state.year_number ?? 0}</text></svg><div class="button-dots" aria-label="Button holder">${(state.player_order ?? Object.keys(state.players)).map(p => `<span class="player-dot ${p.toLowerCase()} ${p === state.button_holder ? 'has-button' : ''}" title="${title(p)}${p === state.button_holder ? ' holds the Button' : ''}" aria-label="${title(p)}${p === state.button_holder ? ' holds the Button' : ''}"></span>`).join('')}</div></div>`;
}

export function constantsHtml(state, viewer, defenderId = null) {
  const seated = viewer && !state.players[viewer]?.eliminated ? viewer : state.current_actor;
  const c = deriveConstants(state, seated);
  const defender = state.units_by_id[defenderId];
  const mover = deriveConstants(state, state.current_actor);
  const s = state.phase === PHASE.SIEGE ? defender ? liveUnits(state, defender.owner).length : '⌖' : mover.S_mobilize;
  const allC = (state.player_order ?? Object.keys(state.players)).map(p => `${title(p)}: ${deriveConstants(state, p).C}`).join(' · ');
  return `<div class="constant-grid" aria-label="Public constants">
    <details class="constant"><summary><strong>♧ ${c.C}</strong><span>${title(seated)} · Build</span></summary><p>Twice the player's Unit count. ${allC}.</p></details>
    <details class="constant"><summary><strong>◇ ${c.D}</strong><span>Nobles drawn</span></summary><p>All Nobles outside the Noble deck.</p></details>
    <details class="constant"><summary><strong>♤ ${s}</strong><span>${state.phase === PHASE.SIEGE ? defender ? `${title(defender.owner)} · Defender` : 'Select defender' : `${title(state.current_actor)} · Units`}</span></summary><p>Mobilization uses the mover's Unit count. Siege uses the selected defender's Unit count. Add the relevant Unit's Level to get the action cost.</p></details>
    <details class="constant"><summary><strong>♡ ${c.H}</strong><span>Vassals + Hostages</span></summary><p>Assigned Vassals plus Hostages in all Dungeons.</p></details>
  </div>`;
}

export function tabletopRegionsHtml(state, { viewer = null, names = {}, resourceHtml = null, canAct = false, stockpileHtml = null } = {}) {
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase];
  const regions = { WHITE: 'south-west', GREEN: 'south-east', BLACK: 'north-east', RED: 'north-west' };
  return (state.player_order ?? Object.keys(state.players)).map(player => {
    const p = state.players[player];
    const privateOwner = player === viewer && !p.eliminated;
    const actionable = privateOwner && canAct && state.status === 'ACTIVE' && state.current_actor === player;
    const hand = sortResourceCards(p.resource_hand_ids.map(id => state.resources_by_id[id]).filter(card => card && !card.hidden));
    const mode = actionable ? state.phase === PHASE.HARVEST && state.harvest?.stage === 'POKER' ? 'POKER' : state.phase === PHASE.STOCKPILE ? 'STOCKPILE' : suit ? 'TAP' : 'NONE' : 'NONE';
    const hostage = state.nobles_by_id[p.dungeon_noble_id];
    return `<section data-player-region="${player}" class="corner-region ${regions[player]} ${player.toLowerCase()} ${p.eliminated ? 'defeated' : ''}" aria-label="${title(player)} player area">
      <div class="realm-hand"><header><div><span class="player-dot ${player.toLowerCase()}"></span><h2>${escapeMarkup(names[player] || title(player))}</h2><span class="realm-caption">${title(player)}${player === viewer ? ' · You' : ''}${p.eliminated ? ' · Defeated' : state.current_actor === player ? ' · Acting' : ''}${state.button_holder === player ? ' · Button' : ''}</span></div>${suit ? `<div class="table-pool" aria-label="${title(player)} seasonal pool"><span>Pool</span><strong>${SUIT_GLYPH[suit]} ${p.seasonal_pools[suit]}</strong></div>` : ''}</header>
      ${privateOwner && stockpileHtml ? stockpileHtml(player) : ''}
      <div class="suit-groups">${SUITS.map(group => `<div class="suit-group" aria-label="${title(group)} Resources"><span class="suit-heading ${[SUIT.DIAMONDS, SUIT.HEARTS].includes(group) ? 'red-suit' : ''}">${SUIT_GLYPH[group]}</span><div class="suit-cards">${hand.filter(card => card.suit === group).map(card => resourceHtml ? resourceHtml(card, mode, player) : `<span class="card-token">${formatResource(card)}</span>`).join('') || '<span class="empty-suit">—</span>'}</div></div>`).join('')}</div>
      ${actionable && suit ? '<div class="resource-actions"><button id="tap-selected" class="button" disabled>Select cards to tap</button><span id="tap-preview" class="payment-preview" aria-live="polite"></span></div>' : ''}</div>
      <div class="realm-side"><div class="court-heading"><h3>Court</h3><span>${p.court_noble_ids.length} private</span></div><div class="court-fan" aria-label="${title(player)} face-down Court">${p.court_noble_ids.map((id, i) => `<button class="court-back" ${privateOwner ? `data-inspect-court="${escapeMarkup(id)}"` : 'disabled'} aria-label="${privateOwner ? 'Privately inspect' : 'Face-down'} ${title(player)} Court card ${i + 1}"><span aria-hidden="true">◇</span></button>`).join('') || '<span class="empty-state">No Court cards</span>'}</div>
      <h3>Dungeon</h3><div class="dungeon-slot ${hostage && !hostage.hidden ? 'occupied' : ''}">${hostage && !hostage.hidden ? `<button class="hostage-card" data-inspect-noble="${escapeMarkup(hostage.noble_id)}" aria-label="Inspect Hostage ${escapeMarkup(formatNoble(hostage))}">${nobleCardHtml(hostage)}</button>` : '<span>Empty</span>'}</div>
      <h3>Reserve</h3><div class="reserve-pieces">${Object.values(UNIT_TYPE).filter(type => p.reserve[type] > 0).map(type => `<div class="reserve-group" aria-label="${p.reserve[type]} ${title(type)} pieces">${Array.from({length: p.reserve[type]}, () => pieceIcon({owner: player, unit_type: type})).join('')}</div>`).join('') || '<span class="empty-state">No pieces in reserve</span>'}</div></div>
    </section>`;
  }).join('');
}

export function unitInspectionHtml(state, unit) {
  const noble = state.nobles_by_id[unit.vassal_noble_id];
  return `${pieceIcon(unit)}<h2>${title(unit.owner)} ${title(unit.unit_type)} · ${unit.square}</h2><p>${isLevy(unit) ? 'Levy' : 'Holding'} · Level ${LEVEL_BY_TYPE[unit.unit_type]} · Draw ${drawCountOf(unit)}, keep one at Harvest.</p>${noble ? nobleCardHtml(noble) : '<p>An unassigned Holding Harvests and defends; assign a Vassal before moving or attacking.</p>'}<p>${STORAGE_TYPE[unit.unit_type] ? 'Adds one bonus Stockpile slot.' : 'No bonus Stockpile slot.'}</p>`;
}

export function nobleInspectionHtml(state, noble) {
  if (!noble || noble.hidden) return '';
  const captor = Object.keys(state.players).find(p => state.players[p].dungeon_noble_id === noble.noble_id);
  return `${nobleCardHtml(noble)}<p>${escapeMarkup(formatNoble(noble))}</p><p>Matching ${SUIT_GLYPH[noble.suit]} Harvest gains a Counter. Combat bonus +${noble.rank}.</p>${captor ? `<p>Hostage · original owner ${title(noble.owner)} · held by ${title(captor)}.</p><p>Ransom: ${actionCost(state, 'RANSOM', {noble_id: noble.noble_id})} ◇ · Execution: ${actionCost(state, 'EXECUTE', {noble_id: noble.noble_id})} ♡ at current constants.</p>` : ''}`;
}
