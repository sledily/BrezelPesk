import { NOBLE_DISPLAY_CODE, PHASE, PIECE_CODE, PLAYER, SUIT_CODE, UNIT_TYPE, playerCode } from "./constants.js";

export const CHRONICLE_PHASES = Object.freeze({
  HARVEST: "Harvest", POKER: "Poker Hands", BUILD: "Build", UPGRADE: "Upgrade",
  RANSOM: "Ransom", RECRUIT: "Recruit", MOBILIZE: "Mobilization", SIEGE: "Siege",
  VASSALIZE: "Vassalization", EXECUTE: "Execution", STOCKPILE: "Stockpile",
});

function notationPlayer(player) {
  return String(player ?? "Unknown").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

export function notationResource(card, counter = card?.has_counter) {
  return card && !card.hidden ? `${card.face_value}${SUIT_CODE[card.suit]}${counter ? "*" : ""}` : "??";
}

export function notationNoble(noble) {
  return noble && !noble.hidden ? `${NOBLE_DISPLAY_CODE[noble.face]}${SUIT_CODE[noble.suit]}` : "[XX]";
}

function notationUnit(unit, square = unit?.square) {
  return unit && square ? `${PIECE_CODE[unit.unit_type]}${square}` : "[Unknown Unit]";
}

// Called while an event is created: strings preserve the historical position,
// Counter state and forgone Noble bonus, independently of later state changes.
export function snapshotChronicleEntry(state, type, p, actor = state.current_actor) {
  const resource = (id, counter) => notationResource(state.resources_by_id[id], counter);
  const noble = (id) => notationNoble(state.nobles_by_id[id]);
  const unit = (id) => state.units_by_id[id];
  const entry = { player: p.player ?? actor, section: state.phase, text: "" };
  switch (type) {
    case "SovereignChosen":
      entry.section = "SETUP";
      entry.text = `${notationUnit(unit(p.unit_id))}*${noble(p.noble_id)}`;
      break;
    case "HarvestCardKept": {
      const vassal = state.nobles_by_id[unit(p.unit_id)?.vassal_noble_id];
      const kept = `(${resource(p.kept_card_id, Boolean(p.counter_sources?.length))})`;
      const rejected = (p.returned_card_ids ?? []).map((id) => resource(id,
        Boolean(vassal && state.resources_by_id[id]?.suit === vassal.suit)));
      entry.section = "HARVEST";
      entry.text = [kept, ...rejected].join(" ");
      // The complete Harvest offer is public, including rejected Counter annotations.
      entry.public_text = entry.text;
      break;
    }
    case "HarvestFailsafeUsed":
      entry.section = "HARVEST";
      entry.text = `${state.rules?.resource_flow_v2 ? 'Alt' : ''}(${resource(p.card_id, false)})`;
      entry.public_text = entry.text;
      break;
    case "HarvestCardsDrawn":
      if (!state.rules?.resource_flow_v2 || p.card_ids.length) return null;
      entry.section = "HARVEST";
      entry.text = `()${['a1','a8','h1','h8'].includes(unit(p.unit_id)?.square) ? `@${p.deck === 'BLACK' ? 'Black' : 'Red'}` : ''}`;
      entry.public_text = entry.text;
      break;
    case "PokerHandDeclared":
      entry.section = "POKER";
      entry.text = `Dec ${p.card_ids.map((id) => resource(id, true)).join("+")}`;
      break;
    case "UnitBuilt": entry.text = `Bld(${p.cost}) ${p.square}`; break;
    case "UnitUpgraded": entry.text = `Upg(${p.cost}) ${notationUnit({ ...unit(p.unit_id), unit_type: p.to_type })}`; break;
    case "HostageRansomed":
      entry.player = p.buyer;
      entry.text = `Ran(${p.cost}) ${noble(p.noble_id)}`;
      break;
    case "NobleRecruited":
      entry.text = `Rec(${p.cost}) ${noble(p.noble_id)}`;
      entry.public_text = `Rec(${p.cost}) [XX]`;
      break;
    case "UnitMobilized": entry.text = `${notationUnit(unit(p.unit_id), p.origin)}-${p.destination}(${p.cost})`; break;
    case "CombatResolved":
      entry.player = unit(p.attacker_id)?.owner ?? actor;
      entry.text = `${notationUnit(unit(p.attacker_id))}${{ ATTACKER_WIN: "x", TIE: "y", DEFENDER_WIN: "z" }[p.outcome]}${notationUnit(unit(p.defender_id))}(${p.cost})`;
      break;
    case "NobleCaptured":
    case "NobleKilledInBattle":
      // A defender's Quarter decision continues the attacker's Siege entry.
      entry.player = state.pending_combat?.resume_actor ?? actor;
      entry.text = `${type === "NobleCaptured" ? "Cap" : "Kil"} ${noble(p.noble_id)}`;
      break;
    case "NobleVassalized": entry.text = `Vas(${p.cost}) ${notationUnit(unit(p.unit_id))}*${noble(p.noble_id)}`; break;
    case "HostageExecuted": entry.text = `Exe(${p.cost}) ${noble(p.noble_id)}`; break;
    case "ResourceStockpileCommitted":
      entry.text = `(${p.kept_card_ids.map((id) => resource(id)).join(", ")})`;
      break;
    case "MatchCompleted":
      return { kind: "result", text: p.reason === "LAST_KING_STANDING"
        ? `Result: ${notationPlayer(p.winner)} wins in Year ${state.year_number} as the last surviving King.`
        : `Result: ${notationPlayer(p.winner)} wins in Year ${state.year_number} by defeating ${notationPlayer(unit(p.defeated_king_id)?.owner)}'s King.` };
    case "ConquestCardTaken":
      return { kind: "extension", text: `${notationPlayer(p.victor)} takes ${notationPlayer(p.defeated_player)}'s Sovereign into Court.` };
    case "ConquestHoldingTaken":
      return { kind: "extension", text: `${notationPlayer(p.victor)} takes ${notationPlayer(p.defeated_player)}'s capital as Q${p.square}.` };
    case "PlayerEliminated":
      return { kind: "extension", text: `${notationPlayer(p.defeated_player)} is eliminated by ${notationPlayer(p.victor)}; resolve the four-player defeat rules.` };
    default: return null;
  }
  return entry;
}

// Reconstruct older event-only history without reading mutable current squares
// or Counters. New events already carry their immutable chronicle entry.
export function chronicleEvents(state) {
  const players = state.player_order ?? Object.keys(state.players);
  const ledger = {
    ...state,
    units_by_id: {},
    resources_by_id: Object.fromEntries(Object.entries(state.resources_by_id).map(([id, card]) => [id, { ...card, has_counter: false }])),
    pending_combat: null,
  };
  for (const player of players) {
    const id = `U-${playerCode(player)}-001`;
    ledger.units_by_id[id] = { unit_id: id, owner: player, unit_type: UNIT_TYPE.KING,
      square: state.rules[`${player.toLowerCase()}_start_square`] ?? { WHITE: "a1", BLACK: "h8", GREEN: "h1", RED: "a8" }[player] };
  }
  let lastCombat = null;
  return state.event_log.map((event) => {
    const p = event.payload ?? {};
    ledger.current_actor = event.actor;
    ledger.phase = event.phase;
    ledger.year_number = event.year;
    const unit = ledger.units_by_id[p.unit_id];
    if (event.type === "SovereignChosen" && unit) unit.vassal_noble_id = p.noble_id;
    if (event.type === "UnitBuilt") ledger.units_by_id[p.unit_id] = { ...p, owner: p.player };
    if (event.type === "UnitUpgraded" && unit) unit.unit_type = p.to_type;
    if (event.type === "NobleVassalized" && unit) unit.vassal_noble_id = p.noble_id;
    if (event.type === "HarvestCardKept" && ledger.resources_by_id[p.kept_card_id]) {
      ledger.resources_by_id[p.kept_card_id].has_counter = Boolean(p.counter_sources?.length);
    }
    if (event.type === "PokerHandDeclared") for (const id of p.card_ids ?? []) {
      if (ledger.resources_by_id[id]) ledger.resources_by_id[id].has_counter = true;
    }
    let chronicle = p.chronicle ?? (p.hidden ? null : snapshotChronicleEntry(ledger, event.type, p, event.actor));
    if (chronicle) {
      const customTitles = (text) => text?.replace(/\b([JQK])([CDSH])\b/g, (_, face, suit) => ({ J: "Vz", Q: "Dx", K: "Rx" })[face] + suit);
      chronicle = { ...chronicle, text: customTitles(chronicle.text), ...(chronicle.public_text ? { public_text: customTitles(chronicle.public_text) } : {}) };
      if (["HarvestCardKept", "HarvestFailsafeUsed"].includes(event.type)) chronicle.public_text = chronicle.text;
    }
    if (event.type === "CombatResolved") lastCombat = { ...p, actor: event.actor };
    if (event.type === "QuarterDecisionRequested") ledger.pending_combat = { resume_actor: lastCombat?.actor };
    if (["NobleCaptured", "NobleKilledInBattle"].includes(event.type)) ledger.pending_combat = null;
    if (event.type === "UnitMobilized" && unit) unit.square = p.destination;
    if (event.type === "UnitDefeated" && unit) {
      unit.square = null;
      if (p.attacker_occupied_square && ledger.units_by_id[lastCombat?.attacker_id]) {
        ledger.units_by_id[lastCombat.attacker_id].square = p.attacker_occupied_square;
      }
    }
    if (event.type === "SeasonCleaned") for (const id of p.returned_card_ids ?? []) {
      if (ledger.resources_by_id[id]) ledger.resources_by_id[id].has_counter = false;
    }
    if (event.type === "ResourceStockpileCommitted") for (const id of p.discarded_card_ids ?? []) {
      if (ledger.resources_by_id[id]) ledger.resources_by_id[id].has_counter = false;
    }
    if (event.type === "ConquestHoldingTaken") ledger.units_by_id[p.queen_unit_id] = {
      unit_id: p.queen_unit_id, owner: p.victor, unit_type: UNIT_TYPE.QUEEN, square: p.square,
    };
    return chronicle ? { ...event, payload: { ...p, chronicle } } : event;
  });
}

export function formatChronicle(state, { playerNames = {} } = {}) {
  if (state.rules.resource_flow_v2) return formatV2Chronicle(state, playerNames);
  const players = state.player_order ?? Object.keys(state.players);
  const fourPlayer = players.length === 4;
  const lines = ["DENDARV GAME RECORD", `Ruleset: ${fourPlayer ? "1.2 (four-player)" : "1.1"}`];
  for (const player of players) lines.push(`${notationPlayer(player)}: ${String(playerNames[player] ?? notationPlayer(player)).replace(/[\r\n]/g, " ")}`);
  lines.push("Noble notation: Rx / Dx / Vz. Harvest offers are public; unrevealed Court identities are private.");
  if (fourPlayer) lines.push("Four-player extensions are labeled explicitly.");
  if (!["STANDARD_V1", "STANDARD_V15"].includes(state.rules.harvest_order)) lines.push("Legacy record: Harvest used player-selected Unit order; implicit order is not guaranteed.");
  if (state.rules.resource_flow_v2) lines.push("Digital V2: personal Harvest followed immediately by Poker; private Manual or opted-in Auto Stockpile resolves at Year end.");
  else if (state.rules.automatic_passes) lines.push("Digital v1.5: automatically retain all cards when they fit the Stockpile; unavailable turns pass automatically.");
  const setup = new Map();
  const years = new Map();
  let currentBlock = null;
  let result = null;
  let lastOrder = [...players];
  const startBlock = (year, section, order = lastOrder) => {
    if (currentBlock) for (const player of currentBlock.order) currentBlock.done.add(player);
    if (!years.has(year)) years.set(year, new Map());
    const phases = years.get(year);
    if (!phases.has(section)) phases.set(section, { order: [...order], entries: new Map(), done: new Set(), extensions: [] });
    currentBlock = phases.get(section);
    lastOrder = [...order];
    return currentBlock;
  };
  for (const event of chronicleEvents(state)) {
    const p = event.payload ?? {};
    const entry = p.chronicle;
    if (event.type === "PhaseStarted") startBlock(event.year, p.phase, p.actor_order ?? lastOrder);
    if (event.type === "PokerDeclarationsStarted") startBlock(event.year, "POKER", p.actor_order ?? lastOrder);
    if (entry?.section === "SETUP") { setup.set(entry.player, entry.text); continue; }
    if (entry?.kind === "result") { result = entry.text; break; }
    if (entry?.kind === "extension") { currentBlock?.extensions.push(entry.text); continue; }
    if (entry?.text && entry.section) {
      const block = years.get(event.year)?.get(entry.section) ?? startBlock(event.year, entry.section);
      if (!block.entries.has(entry.player)) block.entries.set(entry.player, []);
      block.entries.get(entry.player).push(entry.text);
    }
    if (["ActorPassed", "HarvestActorCompleted", "PokerDeclarationsFinished", "ResourceStockpileCommitted"].includes(event.type)) {
      currentBlock?.done.add(p.player ?? event.actor);
    }
    if (event.type === "PhaseUnavailableAcknowledged" && p.scope === "GLOBAL") {
      for (const player of currentBlock?.order ?? []) currentBlock.done.add(player);
    }
  }
  lines.push("", "Turn 0");
  for (const player of players) if (setup.has(player)) lines.push(`${notationPlayer(player)}: ${setup.get(player)}`);
  lines.push("Button: White");
  for (const [year, phases] of years) {
    lines.push("", `Year ${year}`);
    for (const [section, block] of phases) {
      lines.push(CHRONICLE_PHASES[section] ?? section);
      for (const player of block.order) {
        const entries = block.entries.get(player) ?? [];
        if (entries.length) lines.push(`${notationPlayer(player)}: ${entries.join(" ; ")}`);
        else if (block.done.has(player) && section !== PHASE.STOCKPILE) lines.push(`${notationPlayer(player)}: /`);
      }
      for (const extension of block.extensions) lines.push(`[Four-player extension: ${extension}]`);
    }
  }
  if (result) lines.push("", result);
  return `${lines.join("\n")}\n`;
}

function formatV2Chronicle(state, playerNames) {
  const players = state.player_order ?? Object.keys(state.players);
  const lines = ['DENDARV GAME RECORD', `Ruleset: ${state.ruleset_version}`, 'Notation: 1.1', `Players: ${players.length}`];
  for (const player of players) lines.push(`${notationPlayer(player)}: ${String(playerNames[player] ?? notationPlayer(player)).replace(/[\r\n]/g, ' ')}`);
  lines.push('Noble notation: Rx / Dx / Vz. Harvest offers are public; unrevealed Court identities are private.', '', 'Turn 0');
  let year = 0, heading = 'SETUP', segment = null;
  const flush = () => {
    if (!segment) return;
    const suffix = ['HARVEST', 'POKER'].includes(segment.section) ? ` ${segment.section === 'HARVEST' ? 'Harvest' : 'Poker'}` : '';
    lines.push(`${notationPlayer(segment.player)}${suffix}: ${segment.entries.join(' ; ') || '/'}`);
    segment = null;
  };
  const section = (event, name) => {
    const nextHeading = ['HARVEST','POKER'].includes(name) ? 'Harvest / Poker' : CHRONICLE_PHASES[name] ?? name;
    if (year !== event.year) { flush(); year = event.year; lines.push('', `Year ${year}`); heading = null; }
    if (heading !== nextHeading) { flush(); lines.push(nextHeading); heading = nextHeading; }
  };
  const begin = (event, name, player) => {
    section(event, name);
    if (segment && (segment.section !== name || segment.player !== player)) flush();
    segment ??= { section: name, player, entries: [] };
  };
  for (const event of chronicleEvents(state)) {
    const p = event.payload ?? {}, entry = p.chronicle;
    if (entry?.section === 'SETUP') { lines.push(`${notationPlayer(entry.player)}: ${entry.text}`); continue; }
    if (event.type === 'SetupCompleted') { lines.push('Button: White'); continue; }
    if (event.type === 'PhaseStarted') section(event, p.phase);
    if (entry?.kind === 'result') { flush(); lines.push('', entry.text); break; }
    if (entry?.kind === 'extension') { flush(); lines.push(`[Four-player extension: ${entry.text}]`); continue; }
    if (entry?.text && entry.section) { begin(event, entry.section, entry.player); segment.entries.push(entry.text); }
    const boundary = event.type === 'HarvestActorCompleted' ? 'HARVEST' : event.type === 'PokerDeclarationsFinished' ? 'POKER'
      : ['ActorPassed','ResourceStockpileCommitted'].includes(event.type) ? p.section ?? event.phase : null;
    if (boundary) { begin(event, boundary, p.player ?? event.actor); flush(); }
  }
  flush();
  return `${lines.join('\n')}\n`;
}
