import {
  NOBLE_DISPLAY_CODE,
  NOBLE_NAME,
  PIECE_CODE,
  SUIT_CODE,
  SUIT_GLYPH,
  LEVEL_BY_TYPE,
} from "./constants.js";
import { actionCost, deriveConstants, isCenter } from "./rules.js";

export function harvestCardDetails(card, unit, state) {
  const center = isCenter(unit.square);
  const match = state.nobles_by_id[unit.vassal_noble_id]?.suit === card.suit;
  const sources = [center ? "Center square" : null, match ? "matching Vassal suit" : null].filter(Boolean);
  return {
    card: { ...card, has_counter: center || match },
    effective_value: card.face_value + Number(center || match),
    explanation: sources.length ? `+1 Counter: ${sources.join(" and ")}${sources.length > 1 ? " (one Counter maximum)" : ""}` : "No Harvest Counter",
  };
}

export function actionCostDescription(state, action, details = {}) {
  const values = deriveConstants(state, details.actor ?? state.current_actor,
    state.units_by_id[details.defender_id]?.owner ?? null);
  const unit = state.units_by_id[details.unit_id];
  const defender = state.units_by_id[details.defender_id];
  const noble = state.nobles_by_id[details.noble_id];
  const cost = actionCost(state, action, details);
  const descriptions = {
    BUILD: [`2 × ${values.C / 2} Units`, "♧"],
    UPGRADE: [`Level ${LEVEL_BY_TYPE[details.to_type]} × ${values.C} build base`, "♧"],
    RECRUIT: [`2 × ${values.D} Nobles outside the deck`, "◇"],
    RANSOM: [`${values.D} Nobles outside the deck × ${formatNoble(noble)}`, "◇"],
    MOBILIZE: [`${values.S_mobilize} Units + Level ${LEVEL_BY_TYPE[unit?.unit_type]}`, "♤"],
    SIEGE: [`${values.S_siege} defending Units + Level ${LEVEL_BY_TYPE[defender?.unit_type]}`, "♤"],
    VASSALIZE: [`${values.H} Vassals and Hostages × ${formatNoble(noble)}`, "♡"],
    EXECUTE: [`${values.H} Vassals and Hostages + ${formatNoble(noble)}`, "♡"],
  };
  const [formula, glyph] = descriptions[action];
  return `${formula} = ${cost} ${glyph}`;
}

export function formatResource(card, glyphs = true) {
  if (!card || card.hidden) return "Hidden card";
  const face = card.face_value === 1 ? "A" : String(card.face_value);
  const suit = glyphs ? SUIT_GLYPH[card.suit] : SUIT_CODE[card.suit];
  return `${face}${suit}${card.has_counter ? "*" : ""}`;
}

export function formatNoble(noble, glyphs = true, includeName = true) {
  if (!noble || noble.hidden) return "Hidden Noble";
  const suit = glyphs ? SUIT_GLYPH[noble.suit] : SUIT_CODE[noble.suit];
  const code = `${NOBLE_DISPLAY_CODE[noble.face]}${suit}`;
  const name = NOBLE_NAME[noble.face]?.[noble.suit] ?? noble.name;
  return includeName && name ? `${code} · ${name}` : code;
}

export function formatUnit(unit, state) {
  if (!unit) return "Unknown Unit";
  const piece = PIECE_CODE[unit.unit_type];
  const base = `${piece}${unit.square ?? "--"}`;
  const noble = unit.vassal_noble_id ? state.nobles_by_id[unit.vassal_noble_id] : null;
  return noble ? `${base}^${formatNoble(noble)}` : base;
}

export function formatEvent(event, state) {
  const p = event.payload ?? {};
  switch (event.type) {
    case "SovereignChosen": return `${title(p.player)} chose ${formatNoble(state.nobles_by_id[p.noble_id])} as Sovereign`;
    case "HarvestCardKept": return `${title(p.player)} kept ${formatResource(state.resources_by_id[p.kept_card_id])} for ${formatUnit(state.units_by_id[p.unit_id], state)}`;
    case "HarvestFailsafeUsed": return `${title(p.player)} sacrificed Harvest and kept ${formatResource(state.resources_by_id[p.card_id])}`;
    case "PokerHandDeclared": return `${title(p.player)} declared ${p.kind.replaceAll("_", " ")}`;
    case "ResourceCardsTapped": return `${title(p.player)} tapped ${p.card_ids.map((id) => formatResource(state.resources_by_id[id])).join(" ")} for ${p.value}`;
    case "UnitBuilt": return `${title(p.player)} built ${formatUnit(state.units_by_id[p.unit_id], state)} (${p.cost})`;
    case "UnitUpgraded": return `${title(p.player)} upgraded ${p.unit_id} to ${p.to_type} (${p.cost})`;
    case "NobleRecruited": return `${title(p.player)} recruited a Noble (${p.cost})`;
    case "UnitMobilized": return `${title(p.player)} moved ${p.origin}-${p.destination} (${p.cost})`;
    case "CombatResolved": return `Combat ${p.attacker_total}-${p.defender_total}: ${p.outcome.replaceAll("_", " ")} (${p.cost})`;
    case "NobleCaptured": return `${title(p.captor)} captured ${formatNoble(state.nobles_by_id[p.noble_id])}`;
    case "NobleKilledInBattle": return `${formatNoble(state.nobles_by_id[p.noble_id])} received No Quarter`;
    case "HostageReleasedOnDefeat": return `${formatNoble(state.nobles_by_id[p.noble_id])} was released to ${title(p.original_owner)}`;
    case "DefeatedCourtClaimed": return `${title(p.victor)} claimed ${p.captured_count} Court card${p.captured_count === 1 ? "" : "s"} from ${title(p.defeated_player)}`;
    case "DefeatedResourcesClaimed": return `${title(p.victor)} claimed ${p.card_ids.length} untapped Resource card${p.card_ids.length === 1 ? "" : "s"} from ${title(p.defeated_player)}`;
    case "PlayerEliminated": return `${title(p.defeated_player)} was eliminated by ${title(p.victor)}`;
    case "ConquestChoiceRequested": return `${title(p.victor)} must choose the fallen Sovereign or capital`;
    case "ConquestCardTaken": return `${title(p.victor)} took ${title(p.defeated_player)}'s Sovereign Card`;
    case "ConquestHoldingTaken": return `${title(p.victor)} preserved ${title(p.defeated_player)}'s capital as a captured Queen`;
    case "CapturedQueenDestroyed": return `${title(p.defeated_player)}'s captured Queen was permanently destroyed`;
    case "NobleVassalized": return `${title(p.player)} assigned ${formatNoble(state.nobles_by_id[p.noble_id])} to ${formatUnit(state.units_by_id[p.unit_id], state)} (${p.cost})`;
    case "HostageExecuted": return `${title(p.player)} executed a Hostage (${p.cost})`;
    case "HostageRansomed": return `${title(p.buyer)} acquired ${formatNoble(state.nobles_by_id[p.noble_id])} by Ransom (${p.cost})`;
    case "ActorPassed": return `${title(p.player)} passed ${title(p.phase)}`;
    case "PhaseUnavailable": return p.player
      ? `${title(p.player)} has no legal ${title(p.phase)} action: ${p.reason}`
      : `${title(p.phase)} skipped: ${p.reason}`;
    case "PhaseUnavailableAcknowledged": return `${title(p.phase)} unavailability acknowledged`;
    case "PhaseStarted": return `${title(p.phase)} began`;
    case "YearStarted": return `Year ${p.year} began`;
    case "MatchCompleted": return p.reason === "LAST_KING_STANDING"
      ? `${title(p.winner)} won as the last surviving King`
      : `${title(p.winner)} won by defeating the enemy King`;
    default: return event.type.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
}

export function title(value) {
  if (!value) return "";
  return String(value).toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
