import {
  ACTIVE_SUIT_BY_PHASE,
  DECK,
  LEVEL_BY_TYPE,
  NOBLE_NAME,
  PHASE,
  PLAYER,
  SUIT,
  SUIT_GLYPH,
  UNIT_TYPE,
  playerCode,
} from "./constants.js";
import {
  dispatch,
  newMatch,
  suggestedPhaseActions,
  turnBoundaryCrossed,
  upgradeToV15,
} from "./engine.js";
import { actionCostDescription, harvestCardDetails, formatNoble, formatResource, formatUnit, title } from "./format.js";
import { PIECE_GLYPH, nobleCardHtml, realmComparisonHtml, harvestListHtml, HARVEST_COORDINATE_GUIDE } from "./presentation.js";
import { formatChronicle } from "./notation.js";
import { deserializeMatch, loadFromBrowser, saveToBrowser, serializeMatch } from "./persistence.js";
import { matchPlayers } from "./model.js";
import { OnlineClient, onlineShareUrl, roomCodeFromLocation } from "./online.js";
import { playerName, projectForPlayer } from "./projection.js";
import {
  actionCost,
  availableHoldingUnits,
  availablePokerHands,
  courtNobles,
  deriveConstants,
  deckSize,
  drawCountOf,
  isBlackSquare,
  isCenter,
  isCorner,
  isLevy,
  legalMovementDestinations,
  legalSiegeTargets,
  liveUnits,
  recommendedStockpileIds,
  sortResourceCards,
  storageBonusCount,
  unitAt,
  validBuildTargets,
  validUpgradeTypes,
  validateStockpile,
} from "./rules.js";


const dom = {
  board: document.querySelector("#board"),
  boardHint: document.querySelector("#board-hint"),
  matchStatus: document.querySelector("#match-status"),
  playerSummary: document.querySelector("#player-summary"),
  turnCard: document.querySelector("#turn-card"),
  resourceControls: document.querySelector("#resource-controls"),
  actionControls: document.querySelector("#action-controls"),
  history: document.querySelector("#history"),
  handoff: document.querySelector("#handoff"),
  handoffSeal: document.querySelector("#handoff-seal"),
  handoffTitle: document.querySelector("#handoff-title"),
  handoffText: document.querySelector("#handoff-text"),
  toast: document.querySelector("#toast"),
  newDialog: document.querySelector("#new-game-dialog"),
  newForm: document.querySelector("#new-game-form"),
  seed: document.querySelector("#seed"),
  playerCount: document.querySelector("#player-count"),
  importFile: document.querySelector("#import-file"),
  undoAction: document.querySelector("#undo-action"),
  phaseNotice: document.querySelector("#phase-notice"),
  phaseNoticeEyebrow: document.querySelector("#phase-notice-eyebrow"),
  phaseNoticeTitle: document.querySelector("#phase-notice-title"),
  phaseNoticeText: document.querySelector("#phase-notice-text"),
  phaseNoticeReason: document.querySelector("#phase-notice-reason"),
  onlineDialog: document.querySelector("#online-dialog"),
  onlineCreateName: document.querySelector("#online-create-name"),
  onlineCreateCount: document.querySelector("#online-create-count"),
  onlineCreateSeat: document.querySelector("#online-create-seat"),
  onlineRoomCode: document.querySelector("#online-room-code"),
  onlineStrip: document.querySelector("#online-strip"),
  onlineStripText: document.querySelector("#online-strip-text"),
  onlineLobby: document.querySelector("#online-lobby"),
  onlineLobbyTitle: document.querySelector("#online-lobby-title"),
  onlineLobbyStatus: document.querySelector("#online-lobby-status"),
  onlineSeatList: document.querySelector("#online-seat-list"),
  onlineJoinControls: document.querySelector("#online-join-controls"),
  onlineJoinName: document.querySelector("#online-join-name"),
  startOnlineMatch: document.querySelector("#start-online-match"),
};

let state = loadInitialState();
let selectedResourceIds = new Set();
let interaction = emptyInteraction();
let toastTimer = null;
let stockpileSelectionKey = null;
let undoStack = [];
let acknowledgingPhaseNotice = false;
let onlineClient = null;
let onlinePayload = null;
let onlinePollTimer = null;
let onlineRequestPending = false;
let dismissedOnlineNotice = null;
let vassalSelection = { nobleId: null, unitId: null };

function loadInitialState() {
  try {
    return upgradeToV15(loadFromBrowser() ?? newMatch({ seed: "Remy-and-Franny", playerCount: 4 }));
  } catch {
    return newMatch({ seed: "Remy-and-Franny", playerCount: 4 });
  }
}

function emptyInteraction() {
  return { mode: null, unitId: null, legalSquares: new Set(), attackSquares: new Set() };
}

function activePlayer() {
  return onlinePayload?.viewer?.seat ?? state.current_actor;
}

function onlinePlayerCanAct() {
  if (!onlinePayload) return true;
  return onlinePayload.viewer.role === "PLAYER"
    && onlinePayload.viewer.is_your_turn
    && !onlinePayload.viewer.waiting_for_pass;
}

function onlineNoticeKey() {
  if (!state.phase_notice) return null;
  return `${state.year_number}:${state.phase}:${state.phase_notice.scope}:${state.phase_notice.player ?? "GLOBAL"}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[character]));
}

async function run(command, { keepSelection = false } = {}) {
  if (pendingAutomaticNotices().length) { maybeShowPhaseNotice(); return false; }
  const retainTarget = ["TAP_RESOURCES", "MOBILIZE_UNIT"].includes(command.type);
  const previousTarget = retainTarget ? structuredClone(interaction) : null;
  if (onlineClient) {
    if (!onlinePlayerCanAct() || onlineRequestPending) return false;
    onlineRequestPending = true;
    try {
      const payload = await onlineClient.command(command);
      applyOnlinePayload(payload, { resetSelection: !keepSelection, force: true, retainedInteraction: previousTarget });
      return true;
    } catch (error) {
      showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
      return false;
    } finally {
      onlineRequestPending = false;
    }
  }
  const previousActor = state.current_actor;
  const undoSnapshot = {
    state: structuredClone(state),
    selectedResourceIds: structuredClone(selectedResourceIds),
    interaction: structuredClone(interaction),
    stockpileSelectionKey,
    command: structuredClone(command),
  };
  const result = dispatch(state, command);
  if (!result.ok) {
    showToast(`${result.error.code}: ${result.error.message}`);
    return false;
  }
  if (state.rules.automatic_passes && turnBoundaryCrossed(state, result.state, result.events)) undoStack = [];
  else undoStack.push(undoSnapshot);
  state = result.state;
  if (!keepSelection) {
    selectedResourceIds = new Set();
    interaction = retainTarget && state.current_actor === previousActor ? previousTarget : emptyInteraction();
  }
  try {
    saveToBrowser(state);
  } catch {
    showToast("The match advanced, but browser autosave was unavailable.");
  }
  render();
  if (state.status !== "COMPLETE" && state.current_actor && state.current_actor !== previousActor) {
    showHandoff(state.current_actor);
  } else {
    maybeShowPhaseNotice();
  }
  return true;
}

function applyOnlinePayload(payload, { resetSelection = false, force = false, retainedInteraction = null } = {}) {
  const previousSignature = onlinePayload
    ? `${onlinePayload.room.status}:${onlinePayload.room.revision}:${onlinePayload.viewer.private_revision}:${onlinePayload.viewer.role}:${onlinePayload.viewer.seat}`
    : null;
  const nextSignature = `${payload.room.status}:${payload.room.revision}:${payload.viewer.private_revision}:${payload.viewer.role}:${payload.viewer.seat}`;
  onlinePayload = payload;
  if (payload.game && (force || previousSignature !== nextSignature)) {
    state = payload.game;
    if (resetSelection) {
      selectedResourceIds = new Set();
      interaction = retainedInteraction && state.current_actor === payload.viewer.seat && !payload.viewer.waiting_for_pass
        ? retainedInteraction : emptyInteraction();
      stockpileSelectionKey = null;
    } else {
      selectedResourceIds = new Set([...selectedResourceIds].filter((id) => state.resources_by_id[id]));
    }
    render();
    maybeShowPhaseNotice();
  }
  renderOnlineChrome();
}

function newLocalMatch(seed, playerCount = 4) {
  leaveOnlineMode({ updateLocation: true });
  state = newMatch({ seed: seed || "dendarv", playerCount });
  selectedResourceIds = new Set();
  interaction = emptyInteraction();
  stockpileSelectionKey = null;
  undoStack = [];
  saveToBrowser(state);
  render();
  showHandoff(state.current_actor);
}

function showHandoff(player) {
  if (onlineClient) return;
  if (!player) return;
  const name = playerName(player);
  dom.handoffTitle.textContent = `${name} to act`;
  dom.handoffText.textContent = `Pass the device to ${name}. Your Court cards will be revealed after confirmation. Harvest cards are public.`;
  dom.handoffSeal.textContent = playerCode(player);
  dom.handoffSeal.className = `handoff-seal ${player.toLowerCase()}`;
  dom.phaseNotice.hidden = true;
  dom.handoff.hidden = false;
  document.querySelector(".app-shell").inert = true;
}

function hideHandoff() {
  dom.handoff.hidden = true;
  document.querySelector(".app-shell").inert = false;
  maybeShowPhaseNotice();
}

function syncRecommendedStockpile() {
  if (onlinePayload && !onlinePlayerCanAct()) {
    stockpileSelectionKey = null;
    return;
  }
  if (state.phase !== PHASE.STOCKPILE || state.status !== "ACTIVE") {
    stockpileSelectionKey = null;
    return;
  }
  const key = `${state.match_id}:${state.year_number}:${state.current_actor}`;
  if (stockpileSelectionKey === key) return;
  selectedResourceIds = new Set(recommendedStockpileIds(state, state.current_actor));
  interaction = emptyInteraction();
  stockpileSelectionKey = key;
}

const acknowledgedNotices = new Map();
function noticeStorageKey() {
  return `dendarv.notices.${state.match_id}.${activePlayer()}`;
}

function pendingAutomaticNotices() {
  if (!state.rules.automatic_passes || !onlinePlayerCanAct() || state.status !== "ACTIVE") return [];
  const key = noticeStorageKey();
  if (!acknowledgedNotices.has(key)) {
    try { acknowledgedNotices.set(key, Number(localStorage.getItem(key)) || 0); }
    catch { acknowledgedNotices.set(key, 0); }
  }
  return (state.automatic_notices ?? []).filter((notice) => notice.player === activePlayer() && notice.sequence > acknowledgedNotices.get(key));
}

function renderPhaseNotice() {
  const notices = pendingAutomaticNotices();
  const notice = notices[0] ?? (!state.rules.automatic_passes ? state.phase_notice : null);
  if (!notice || !dom.handoff.hidden) {
    dom.phaseNotice.hidden = true;
    document.querySelector(".app-shell").inert = !dom.handoff.hidden;
    return;
  }
  const phase = notice.section === "POKER" ? "Poker Hands" : title(notice.phase);
  dom.phaseNoticeEyebrow.textContent = `Year ${notice.year ?? state.year_number} · ${seasonForPhase(notice.phase)}`;
  dom.phaseNoticeTitle.textContent = `${phase} passed · ${playerName(notice.player ?? activePlayer())}`;
  dom.phaseNoticeText.textContent = state.rules.automatic_passes
    ? `This step has already resolved. ${notices.length > 1 ? `${notices.length} explanations remain before your next decision.` : "Your next decision is ready."}`
    : "The game will proceed after this explanation.";
  dom.phaseNoticeReason.textContent = notice.reason;
  document.querySelector("#dismiss-phase-notice").textContent = notices.length > 1 ? "Next explanation" : "Continue to my decision";
}

function maybeShowPhaseNotice() {
  renderPhaseNotice();
  if (!dom.handoff.hidden || !onlinePlayerCanAct()) return;
  if (!pendingAutomaticNotices().length && !state.phase_notice) return;
  dom.phaseNotice.hidden = false;
  document.querySelector(".app-shell").inert = true;
  document.querySelector("#dismiss-phase-notice").focus();
}

function acknowledgeCurrentPhaseNotice(event) {
  if (dom.phaseNotice.hidden) return;
  event?.preventDefault();
  const notice = pendingAutomaticNotices()[0];
  if (notice) {
    const key = noticeStorageKey();
    acknowledgedNotices.set(key, notice.sequence);
    try { localStorage.setItem(key, String(notice.sequence)); } catch { /* Session acknowledgement still works. */ }
    dom.phaseNotice.hidden = true;
    document.querySelector(".app-shell").inert = false;
    maybeShowPhaseNotice();
    if (dom.phaseNotice.hidden) { dom.actionControls.tabIndex = -1; dom.actionControls.focus(); }
  } else if (state.phase_notice) {
    dom.phaseNotice.hidden = true;
    document.querySelector(".app-shell").inert = false;
    if (onlinePayload) passOnlineTurn();
    else run({ type: "ACKNOWLEDGE_PHASE_NOTICE", player: activePlayer() });
  }
}

function showToast(message, success = false) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.className = `toast${success ? " success" : ""}`;
  dom.toast.hidden = false;
  toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 4200);
}

function render() {
  syncRecommendedStockpile();
  syncBoardInteraction();
  renderStatus();
  renderBoard();
  renderTurnCard();
  renderResourceControls();
  renderActionControls();
  renderPlayerSummary();
  renderHistory();
  renderPhaseNotice();
  dom.undoAction.disabled = onlinePayload ? !onlinePayload.viewer.can_undo : undoStack.length === 0;
  bindDynamicControls();
}

function renderStatus() {
  const phase = state.status === "SETUP" ? "Sovereign selection" : state.status === "COMPLETE" ? "Match complete" : title(state.phase);
  const season = state.phase ? seasonForPhase(state.phase) : "Setup";
  dom.matchStatus.innerHTML = `
    <span class="status-chip strong">${state.year_number ? `Year ${state.year_number}` : "Turn 0"}</span>
    <span class="status-chip">${matchPlayers(state).length} players</span>
    <span class="status-chip">${season}</span>
    <span class="status-chip">${phase}</span>
    <span class="status-chip">Button: ${playerName(state.button_holder)}</span>
  `;
}

function seasonForPhase(phase) {
  if ([PHASE.BUILD, PHASE.UPGRADE].includes(phase)) return "Winter";
  if ([PHASE.RANSOM, PHASE.RECRUIT].includes(phase)) return "Spring";
  if ([PHASE.MOBILIZE, PHASE.SIEGE].includes(phase)) return "Summer";
  if ([PHASE.VASSALIZE, PHASE.EXECUTE].includes(phase)) return "Fall";
  if (phase === PHASE.HARVEST) return "Harvest";
  return "Year end";
}

function nobleDetail(noble) {
  if (!noble) return "Unknown Noble";
  const name = noble.name ?? NOBLE_NAME[noble.face]?.[noble.suit] ?? formatNoble(noble);
  return `${formatNoble(noble)} · matching ${SUIT_GLYPH[noble.suit]} Harvest gains a Counter`;
}

function hasPool(cost) {
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase];
  return Boolean(suit && state.players[activePlayer()]?.seasonal_pools[suit] >= cost);
}

function fundingDescription(cost) {
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase];
  const pool = state.players[activePlayer()]?.seasonal_pools[suit] ?? 0;
  return pool >= cost ? "Ready to pay from the pool" : `Tap cards to add ${cost - pool} more ${SUIT_GLYPH[suit]} to the pool`;
}

function syncBoardInteraction() {
  if (!onlinePlayerCanAct() || state.status !== "ACTIVE" || state.phase_notice || state.pending_combat || state.pending_conquest) {
    interaction = emptyInteraction();
    return;
  }
  if (state.phase === PHASE.BUILD) {
    const cost = actionCost(state, "BUILD");
    interaction = { mode: "BUILD", unitId: null,
      legalSquares: new Set(hasPool(cost) && state.players[activePlayer()].reserve.PAWN > 0 ? validBuildTargets(state, activePlayer()) : []),
      attackSquares: new Set() };
  } else if (interaction.mode === "MOBILIZE" && state.phase === PHASE.MOBILIZE) {
    const unit = state.units_by_id[interaction.unitId];
    if (!unit || unit.defeated || unit.owner !== activePlayer()) { interaction = emptyInteraction(); return; }
    interaction.legalSquares = new Set(hasPool(actionCost(state, "MOBILIZE", { unit_id: unit.unit_id })) ? legalMovementDestinations(state, unit.unit_id) : []);
  } else if (interaction.mode === "SIEGE" && state.phase === PHASE.SIEGE) {
    interaction.attackSquares = new Set(legalSiegeTargets(state, interaction.unitId)
      .filter((id) => hasPool(actionCost(state, "SIEGE", { defender_id: id })))
      .map((id) => state.units_by_id[id].square));
  } else if (interaction.mode) interaction = emptyInteraction();
}

function nobleToken(noble) {
  return nobleCardHtml(noble);
}

function renderBoard() {
  const parts = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const file = String.fromCharCode(97 + fileIndex);
      const square = `${file}${rank}`;
      const unit = unitAt(state, square);
      const isSelected = interaction.unitId && unit?.unit_id === interaction.unitId;
      const isLegal = interaction.legalSquares.has(square);
      const isAttack = interaction.attackSquares.has(square);
      const interactive = onlinePlayerCanAct() && (isLegal || isAttack || canSelectBoardUnit(unit));
      const classes = [
        "square",
        isBlackSquare(square) ? "dark" : "light",
        isCenter(square) ? "center-square" : "",
        isSelected ? "selected" : "",
        isLegal ? "legal" : "",
        isAttack ? "attack" : "",
        unit ? (isLevy(unit) ? "levy-square" : "holding-square") : "",
        unit && state.phase === PHASE.HARVEST && state.harvest?.stage === "DRAW" && (state.harvest?.unit_id ?? (state.harvest?.standard_order ? state.harvest.remaining_unit_ids[0] : null)) === unit?.unit_id ? "harvesting" : "",
        interactive ? "interactive" : "",
      ].filter(Boolean).join(" ");
      const vassal = unit?.vassal_noble_id ? state.nobles_by_id[unit.vassal_noble_id] : null;
      const pieceColor = unit?.piece_color ?? unit?.owner;
      const unitHtml = unit ? `
        <span class="piece ${pieceColor.toLowerCase()}" aria-hidden="true">${PIECE_GLYPH[pieceColor][unit.unit_type]}</span>
        ${vassal ? `<span class="vassal-badge ${[SUIT.DIAMONDS, SUIT.HEARTS].includes(vassal.suit) ? "red" : ""}" title="${formatNoble(vassal, true, false)}">${formatNoble(vassal, true, false)}</span>` : `<span class="holding-marker" title="Holding: Harvests and defends; needs a Vassal to move or attack" aria-hidden="true">○</span>`}
      ` : "";
      parts.push(`
        <button class="${classes}" data-square="${square}" role="gridcell" aria-label="${square}${unit ? `, ${playerName(unit.owner)}-controlled ${playerName(pieceColor)} ${title(unit.unit_type)}${vassal ? `, Levy assigned to ${formatNoble(vassal, true, false)}` : ", Holding"}` : ", empty"}">
          ${fileIndex === 0 ? `<span class="coordinate rank">${rank}</span>` : ""}
          ${rank === 1 ? `<span class="coordinate file">${file}</span>` : ""}
          ${unitHtml}
        </button>
      `);
    }
  }
  dom.board.innerHTML = parts.join("");
  dom.board.querySelectorAll("[data-square]").forEach((element) => {
    element.addEventListener("click", () => handleBoardClick(element.dataset.square));
  });
  dom.boardHint.textContent = boardHint();
}

function canSelectBoardUnit(unit) {
  if (!onlinePlayerCanAct()) return false;
  if (!unit || unit.owner !== activePlayer() || state.status !== "ACTIVE") return false;
  if (state.phase === PHASE.MOBILIZE) return isLevy(unit);
  if (state.phase === PHASE.SIEGE) return isLevy(unit);
  return false;
}

function boardHint() {
  if (interaction.mode === "BUILD") return interaction.legalSquares.size ? "Choose a marked empty square to Build a Pawn." : "Tap Clubs into the pool to make the legal Build squares available.";
  if (interaction.mode === "MOBILIZE") return `Choose a highlighted destination for ${formatUnit(state.units_by_id[interaction.unitId], state)}.`;
  if (interaction.mode === "SIEGE") return "Choose a red-ringed adjacent enemy Unit.";
  if (state.phase === PHASE.MOBILIZE) return "Select one of your Levies to show its legal destinations.";
  if (state.phase === PHASE.SIEGE) return "Select one of your Levies to show adjacent Siege targets.";
  return "The four outlined squares are the Center Squares and grant a Harvest Counter.";
}

function handleBoardClick(square) {
  if (!onlinePlayerCanAct()) return;
  const unit = unitAt(state, square);
  if (interaction.mode === "BUILD" && interaction.legalSquares.has(square)) {
    run({ type: "BUILD_UNIT", player: activePlayer(), square });
    return;
  }
  if (interaction.mode === "MOBILIZE" && interaction.legalSquares.has(square)) {
    run({ type: "MOBILIZE_UNIT", player: activePlayer(), unit_id: interaction.unitId, destination: square });
    return;
  }
  if (interaction.mode === "SIEGE" && interaction.attackSquares.has(square) && unit) {
    run({ type: "LAY_SIEGE", player: activePlayer(), attacker_id: interaction.unitId, defender_id: unit.unit_id });
    return;
  }
  if (unit?.owner === activePlayer() && state.phase === PHASE.MOBILIZE && isLevy(unit)) {
    selectMovement(unit.unit_id);
  } else if (unit?.owner === activePlayer() && state.phase === PHASE.SIEGE && isLevy(unit)) {
    selectSiege(unit.unit_id);
  } else if (unit && isLevy(unit)) {
    dom.boardHint.textContent = nobleDetail(state.nobles_by_id[unit.vassal_noble_id]);
  }
}

function selectMovement(unitId) {
  interaction = {
    mode: "MOBILIZE",
    unitId,
    legalSquares: new Set(legalMovementDestinations(state, unitId)),
    attackSquares: new Set(),
  };
  syncBoardInteraction();
  renderBoard();
}

function selectSiege(unitId) {
  const targetSquares = legalSiegeTargets(state, unitId).map((id) => state.units_by_id[id].square);
  interaction = {
    mode: "SIEGE",
    unitId,
    legalSquares: new Set(),
    attackSquares: new Set(targetSquares),
  };
  syncBoardInteraction();
  renderBoard();
}

function renderTurnCard() {
  const player = state.status === "COMPLETE" ? state.winner
    : onlinePayload?.viewer.waiting_for_pass ? onlinePayload.viewer.seat
      : state.current_actor;
  const initialBase = matchPlayers(state).length;
  const constants = state.status !== "SETUP" ? deriveConstants(state, player) : { C: 2, D: initialBase, S_mobilize: 1, H: initialBase };
  const actionName = state.status === "SETUP" ? "Choose a Sovereign"
    : state.status === "COMPLETE" ? `${playerName(state.winner)} is victorious`
      : `${playerName(player)} · ${title(state.phase)}`;
  const actorPosition = state.phase_actor_order?.indexOf(player) ?? -1;
  const sub = state.status === "COMPLETE" ? (state.victory_reason === "LAST_KING_STANDING" ? "Only one King remains on the board." : "The enemy King has been defeated.")
    : state.status === "SETUP" ? `${playerName(player)} chooses from the available Rx Nobles.`
      : `${seasonForPhase(state.phase)} · ${state.button_holder === player ? "holds the button" : `acts ${ordinal(actorPosition + 1)} this phase`}`;
  dom.turnCard.innerHTML = `
    <div class="turn-banner">
      <div class="player-seal ${player?.toLowerCase() ?? "white"}">${playerCode(player)}</div>
      <div><h2 class="turn-title">${actionName}</h2><div class="turn-subtitle">${sub}</div></div>
    </div>
    <div class="constant-grid" aria-label="Action costs for ${playerName(player)}">
      <div class="constant" title="Clubs base: twice your current Unit count"><strong><span class="suit-symbol">${SUIT_GLYPH[SUIT.CLOVERS]}</span> ${constants.C}</strong><span>Build base</span></div>
      <div class="constant" title="Diamonds base: all Nobles outside the deck"><strong><span class="suit-symbol red-suit">${SUIT_GLYPH[SUIT.DIAMONDS]}</span> ${constants.D}</strong><span>Nobles drawn</span></div>
      <div class="constant" title="Spades base: your Units for Mobilization; the defender's Units for Siege"><strong><span class="suit-symbol">${SUIT_GLYPH[SUIT.SPADES]}</span> ${constants.S_mobilize}</strong><span>Your Units</span></div>
      <div class="constant" title="Hearts base: assigned Vassals plus Hostages in all Dungeons"><strong><span class="suit-symbol red-suit">${SUIT_GLYPH[SUIT.HEARTS]}</span> ${constants.H}</strong><span>Vassals + Hostages</span></div>
    </div>
    <ol class="season-track" aria-label="Year sequence">
      ${[["Harvest", "Draw"], ["Winter", SUIT_GLYPH[SUIT.CLOVERS]], ["Spring", SUIT_GLYPH[SUIT.DIAMONDS]], ["Summer", SUIT_GLYPH[SUIT.SPADES]], ["Fall", SUIT_GLYPH[SUIT.HEARTS]], ["Year end", "Keep"]].map(([season, symbol]) => `<li ${seasonForPhase(state.phase) === season && state.status === "ACTIVE" ? 'aria-current="step"' : ""}><span>${symbol}</span>${season}</li>`).join("")}
    </ol>
  `;
}

function ordinal(value) {
  if (value === 1) return "first";
  if (value === 2) return "second";
  if (value === 3) return "third";
  if (value === 4) return "fourth";
  return String(value);
}

function renderResourceControls() {
  if (state.status !== "ACTIVE") {
    dom.resourceControls.innerHTML = `<p class="eyebrow">Resources</p><h2>Seasonal pool</h2><div class="empty-state">${state.status === "COMPLETE" ? "The game has ended. Resource payments are closed." : "Resource play begins after Sovereign selection."}</div>`;
    return;
  }
  const player = state.current_actor;
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase] ?? null;
  if (!suit) {
    dom.resourceControls.innerHTML = `<p class="eyebrow">Resources</p><h2>Seasonal pool</h2><p class="empty-state">No seasonal pool is active during ${state.harvest?.stage === "POKER" ? "Poker declarations" : title(state.phase)}.</p>`;
    return;
  }
  const pool = suit ? state.players[player].seasonal_pools[suit] : null;
  const allCards = sortResourceCards(state.players[player].resource_hand_ids.map((id) => state.resources_by_id[id]));
  const maySelect = onlinePlayerCanAct();
  const selectionMode = !maySelect ? "NONE"
    : state.phase === PHASE.HARVEST && state.harvest?.stage === "POKER" ? "POKER"
      : state.phase === PHASE.STOCKPILE ? "STOCKPILE"
        : suit ? "TAP" : "NONE";
  const cards = allCards.filter((card) => card.suit === suit);
  const emptyMessage = selectionMode === "TAP"
    ? `No ${SUIT_GLYPH[suit]} ${title(suit)} cards are available. Only ${title(suit)} may be tapped during ${seasonForPhase(state.phase)}.`
    : "No Resource Cards in hand.";
  const cardHtml = cards.length ? cards.map((card) => resourceCheckbox(card, selectionMode)).join("") : `<div class="empty-state">${emptyMessage}</div>`;
  const action = selectionMode === "TAP" ? `<button id="tap-selected" class="button primary" ${selectedResourceIds.size ? "" : "disabled"}>Tap selected</button><span id="tap-preview" class="payment-preview" aria-live="polite"></span>` : "";
  dom.resourceControls.innerHTML = `
    <p class="eyebrow">${playerName(player)} · ${seasonForPhase(state.phase)}</p>
    <h2>Seasonal pool</h2>
    ${suit ? `<div class="pool-readout"><span>Active pool · ${SUIT_GLYPH[suit]} ${title(suit)}</span><strong>${pool}</strong></div>` : ""}
    <div class="resource-row">${cardHtml}</div>
    ${cards.some((card) => card.has_counter || card.tapped || card.mandatory_spend_year === state.year_number) ? '<p class="card-state-key">* Counter +1 · tilted = tapped · ! spend or return this Year</p>' : ""}
    ${action ? `<div class="resource-actions">${action}</div>` : ""}
  `;
}

function resourceCheckbox(card, mode) {
  const red = [SUIT.DIAMONDS, SUIT.HEARTS].includes(card.suit);
  const activeSuit = ACTIVE_SUIT_BY_PHASE[state.phase];
  const disabled = mode === "NONE"
    || (mode === "TAP" && (card.tapped || card.suit !== activeSuit))
    || (mode === "STOCKPILE" && (card.tapped || card.mandatory_spend_year === state.year_number));
  const classes = ["card-token", red ? "red" : "", card.tapped ? "tapped" : "", card.mandatory_spend_year === state.year_number ? "mandatory" : ""].filter(Boolean).join(" ");
  return `
    <label class="card-choice" title="${card.tapped ? "Tapped" : card.mandatory_spend_year === state.year_number ? "Must be spent or returned this Year" : "Untapped"}">
      <input type="checkbox" aria-label="${formatResource(card)}, effective value ${card.face_value + Number(card.has_counter)}${card.tapped ? ', tapped' : ''}${card.mandatory_spend_year === state.year_number ? ', spend or return this Year' : ''}" data-resource-id="${card.card_id}" ${selectedResourceIds.has(card.card_id) ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span class="${classes}">${formatResource(card)}</span>
    </label>
  `;
}

function renderActionControls() {
  if (onlinePayload && (state.status !== "COMPLETE" || onlinePayload.viewer.waiting_for_pass)) {
    if (onlinePayload.viewer.role === "SPECTATOR") {
      dom.actionControls.innerHTML = `<p class="eyebrow">Spectator</p><h2>Watching ${playerName(state.current_actor)}</h2><div class="online-waiting">You have a live, read-only view of every committed action. Harvest offers are public. Private Court cards remain hidden.</div>`;
      return;
    }
    if (!onlinePayload.viewer.is_your_turn) {
      const actingName = onlinePayload.room.seats[state.current_actor]?.name ?? playerName(state.current_actor);
      dom.actionControls.innerHTML = `<p class="eyebrow">Online table</p><h2>Waiting for ${escapeHtml(actingName)}</h2><div class="online-waiting">${playerName(state.current_actor)} is deciding. Their unpublished actions will appear together when their turn ends.</div>`;
      return;
    }
    if (onlinePayload.viewer.waiting_for_pass) {
      dom.actionControls.innerHTML = `
        <p class="eyebrow">Private draft complete</p><h2>Publish your turn</h2>
        <div class="online-waiting">Other players still see the position from before your turn. Undo to revise it, or Pass to commit every action together.</div>
        <div class="choice-grid">
          <button id="online-undo" class="button" ${onlinePayload.viewer.can_undo ? "" : "disabled"}>Undo latest action</button>
          <button id="online-pass" class="button primary">Pass and publish</button>
        </div>`;
      return;
    }
  }
  if (state.status === "SETUP") {
    renderSovereignChoices();
    return;
  }
  if (state.status === "COMPLETE") {
    dom.actionControls.innerHTML = `
      <p class="eyebrow">Victory</p><h2>${playerName(state.winner)} wins</h2>
      <p>${state.victory_reason === "LAST_KING_STANDING" ? "Every rival King has been defeated. Captured Queens do not prevent victory." : "The opposing King was defeated in Combat."}</p>
      <button id="victory-new" class="button primary full">Begin another chronicle</button>
    `;
    return;
  }
  if (state.pending_conquest) {
    renderConquestChoice();
    return;
  }
  if (state.pending_combat) {
    const noble = state.nobles_by_id[state.pending_combat.noble_id];
    dom.actionControls.innerHTML = `
      <p class="eyebrow">Combat consequence</p><h2>Quarter for ${formatNoble(noble)}?</h2>
      <p>The victorious player may place this defeated Vassal in the empty Dungeon, or return the card to the Noble Deck immediately.</p>
      <div class="choice-grid">
        <button id="give-quarter" class="button primary">Offer Quarter</button>
        <button id="no-quarter" class="button danger">No Quarter</button>
      </div>
    `;
    return;
  }
  if (state.phase_notice) {
    dom.actionControls.innerHTML = onlinePayload
      ? `<p class="eyebrow">${title(state.phase)}</p><h2>Phase unavailable</h2><div class="empty-state">${escapeHtml(state.phase_notice.reason)}</div><button id="online-pass" class="button primary full">Pass ${title(state.phase)} and publish</button>`
      : `<p class="eyebrow">${title(state.phase)}</p><h2>Phase unavailable</h2><div class="empty-state">A short explanation is awaiting acknowledgement.</div>`;
    return;
  }
  switch (state.phase) {
    case PHASE.HARVEST: renderHarvestActions(); break;
    case PHASE.BUILD: renderBuildActions(); break;
    case PHASE.UPGRADE: renderUpgradeActions(); break;
    case PHASE.RANSOM: renderRansomActions(); break;
    case PHASE.RECRUIT: renderRecruitActions(); break;
    case PHASE.MOBILIZE: renderMobilizeActions(); break;
    case PHASE.SIEGE: renderSiegeActions(); break;
    case PHASE.VASSALIZE: renderVassalizeActions(); break;
    case PHASE.EXECUTE: renderExecuteActions(); break;
    case PHASE.STOCKPILE: renderStockpileActions(); break;
    default: dom.actionControls.innerHTML = `<div class="empty-state">No controls for this phase.</div>`;
  }
}

function renderConquestChoice() {
  const pending = state.pending_conquest;
  const sovereign = state.nobles_by_id[pending.sovereign_id];
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Realm defeated</p><h2>Choose the conquest reward</h2>
    <p>${playerName(pending.defeated_player)} has been eliminated. ${playerName(pending.victor)} must choose between the fallen Sovereign and the captured capital.</p>
    <div class="conquest-grid">
      <button id="take-conquest-card" class="button conquest-choice">
        <strong>Take the Card · ${formatNoble(sovereign)}</strong>
        <small>Add the Sovereign to your Court as an ordinary Noble. The victorious attacker advances if the defeated King was defending.</small>
      </button>
      <button id="take-conquest-holding" class="button conquest-choice">
        <strong>Take the Holding · ${playerName(pending.defeated_player)} Queen</strong>
        <small>Place an unassigned captured Queen on ${pending.king_square}. It may receive a Vassal, but can never be rebuilt after destruction.</small>
      </button>
    </div>
  `;
}

function renderSovereignChoices() {
  const candidates = state.sovereign_pool_ids.map((id) => state.nobles_by_id[id]);
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Turn 0</p><h2>Choose Sovereign</h2>
    <p>Your Sovereign is permanently assigned to your King, granting the Rx Combat bonus and a Counter on Harvest cards of the matching suit.</p>
    <div class="choice-grid">
      ${candidates.map((noble) => `<button class="button sovereign-choice" data-noble-id="${noble.noble_id}">${nobleToken(noble)}${matchPlayers(state).length === 4 ? ` · Set ${noble.copy}` : ""}</button>`).join("")}
    </div>
  `;
}

function renderHarvestActions() {
  const h = state.harvest;
  if (h.stage === "POKER") {
    const hands = availablePokerHands(state, activePlayer());
    const kinds = [...new Set(hands.map((hand) => title(hand.kind)))];
    const eligibleIds = new Set(hands.flatMap((hand) => hand.card_ids));
    const cards = sortResourceCards([...eligibleIds].map((id) => state.resources_by_id[id]));
    const selected = [...selectedResourceIds];
    const legal = hands.some((hand) => hand.card_ids.length === selected.length && hand.card_ids.every((id) => selected.includes(id)));
    dom.actionControls.innerHTML = `<p class="eyebrow">Harvest bonus</p><h2>Declare Poker Hands</h2>
      <p>Available: ${kinds.join(", ")}. Select by face value. Declared cards gain a Counter and must be spent or returned this Year.</p>
      <div class="resource-row">${cards.map((card) => resourceCheckbox(card, "POKER")).join("")}</div>
      <div class="choice-grid"><button id="declare-poker" class="button primary" ${legal ? "" : "disabled"}>Declare selected</button><button id="finish-poker" class="button">Finish declarations</button></div>`;
    return;
  }
  const guide = `<p class="rule-note">Harvest each piece in the numbered order: Holdings before Levies, then Level 1 → 2 → 3. ${HARVEST_COORDINATE_GUIDE[activePlayer()]} Click the deck button for each piece.</p>`;
  const rule = '<p class="rule-note harvest-general-rule">Pawns and Knights draw 1; Rooks and Bishops draw 2; Queens and Kings draw 3. Keep 1 card for each piece.</p>';
  let decision = "";
  if (h.failsafe_pending) {
    decision = `<h3>Forgo normal Harvest?</h3><p>You have no Units on black squares. You may forgo normal Harvest for a Black Resource Card.</p><div class="choice-grid"><button id="use-failsafe" class="button primary">Take the Black card · ♧ ♤</button><button id="decline-failsafe" class="button quiet">Harvest normally</button></div>`;
  } else if (h.offer_ids.length) {
    const unit = state.units_by_id[h.unit_id];
    decision = `<h3>Choose your Harvest card · ${unit.square}</h3><div class="choice-grid harvest-offer">${h.offer_ids.map((id) => {
      const details = harvestCardDetails(state.resources_by_id[id], unit, state);
      return `<button class="button harvest-keep ${[SUIT.DIAMONDS, SUIT.HEARTS].includes(details.card.suit) ? "red-card" : ""}" data-card-id="${id}"><strong>${formatResource(details.card)}</strong><span>Worth ${details.effective_value} ${SUIT_GLYPH[details.card.suit]}</span><small>${details.explanation}</small></button>`;
    }).join("")}</div>`;
  }
  dom.actionControls.innerHTML = `<p class="eyebrow">Harvest</p><h2>${playerName(state.current_actor)} Harvest</h2>${guide}${harvestListHtml(state)}${decision}${rule}`;
}

function renderBuildActions() {
  const player = activePlayer();
  const cost = actionCost(state, "BUILD", { actor: player });
  const targets = validBuildTargets(state, player);
  const reserve = state.players[player].reserve[UNIT_TYPE.PAWN];
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Winter · Build</p><h2>Build a Holding</h2>
    <p>Place a Pawn adjacent to a friendly Level 2 or 3 Unit. The ♧ base recalculates after every Build.</p>
    <div class="rule-note">${actionCostDescription(state, "BUILD")}</div>
    <div class="action-row"><div><strong>New Pawn</strong><small>${targets.length} legal square${targets.length === 1 ? "" : "s"} · ${reserve} in reserve</small></div><span class="cost">${cost} ${SUIT_GLYPH[SUIT.CLOVERS]}</span></div>
    <p class="payment-preview">${hasPool(cost) ? "Choose a marked square on the board." : fundingDescription(cost)}</p>
    ${passButton()}
  `;
}

function renderUpgradeActions() {
  const actions = suggestedPhaseActions(state);
  const rows = actions.length ? actions.map((item) => {
    const unit = state.units_by_id[item.unit_id];
    const hasReserve = state.players[activePlayer()].reserve[item.to_type] > 0;
    return `<div class="action-row"><div><strong>${formatUnit(unit, state)} → ${title(item.to_type)}</strong><small>${actionCostDescription(state, "UPGRADE", item)}<br>${fundingDescription(item.cost)}</small></div><button class="button tiny upgrade-action" data-unit-id="${item.unit_id}" data-to-type="${item.to_type}" ${hasReserve && hasPool(item.cost) ? "" : "disabled"}>${item.cost} ${SUIT_GLYPH[SUIT.CLOVERS]}</button></div>`;
  }).join("") : `<div class="empty-state">No supported Upgrade is currently legal.</div>`;
  dom.actionControls.innerHTML = `<p class="eyebrow">Winter · Upgrade</p><h2>Upgrade a Unit</h2><div class="action-list">${rows}</div>${passButton()}`;
}

function renderRansomActions() {
  const offer = state.active_ransom;
  const noble = state.nobles_by_id[offer.noble_id];
  const cost = actionCost(state, "RANSOM", { actor: activePlayer(), noble_id: noble.noble_id });
  const available = state.players[activePlayer()].seasonal_pools[SUIT.DIAMONDS];
  const role = offer.stage === "OWNER" ? "Original owner" : "Captor";
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Spring · Ransom</p><h2>${formatNoble(noble)} · ${role}</h2>
    <p>${offer.stage === "OWNER" ? "You have the first opportunity to return this Noble to your Court. The captor receives half, rounded up." : "The original owner declined. You may acquire the Hostage into your own Court."}</p>
    <div class="action-row"><div><strong>Ransom price</strong><small>${available} Diamonds in pool</small></div><span class="cost">${cost} ${SUIT_GLYPH[SUIT.DIAMONDS]}</span></div>
    <div class="rule-note">${actionCostDescription(state, "RANSOM", { noble_id: noble.noble_id })}<br>${fundingDescription(cost)}</div>
    <div class="choice-grid">
      <button id="pay-ransom" class="button primary" ${available < cost ? "disabled" : ""}>Pay Ransom</button>
      <button id="decline-ransom" class="button">Decline</button>
    </div>
  `;
}

function renderRecruitActions() {
  const cost = deckSize(state, DECK.NOBLE) ? actionCost(state, "RECRUIT", { actor: activePlayer() }) : null;
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Spring · Recruit</p><h2>Recruit a Noble</h2>
    <div class="action-row"><div><strong>Draw to Court</strong><small>${deckSize(state, DECK.NOBLE)} Nobles remain</small></div><span class="cost">${cost ?? "—"} ${SUIT_GLYPH[SUIT.DIAMONDS]}</span></div>
    ${cost === null ? "" : `<div class="rule-note">${actionCostDescription(state, "RECRUIT")}<br>${fundingDescription(cost)}</div>`}
    <button id="recruit-noble" class="button primary full" ${cost === null || !hasPool(cost) ? "disabled" : ""}>Recruit</button>
    ${passButton()}
  `;
}

function renderMobilizeActions() {
  const player = activePlayer();
  const levies = liveUnits(state, player).filter(isLevy);
  const rows = levies.length ? levies.map((unit) => {
    const cost = actionCost(state, "MOBILIZE", { actor: player, unit_id: unit.unit_id });
    const destinations = legalMovementDestinations(state, unit.unit_id);
    return `<div class="action-row"><div><strong>${formatUnit(unit, state)}</strong><small>${actionCostDescription(state, "MOBILIZE", { unit_id: unit.unit_id })}<br>${destinations.length} legal destination${destinations.length === 1 ? "" : "s"} · ${fundingDescription(cost)}</small></div><button class="button tiny select-move" data-unit-id="${unit.unit_id}" ${destinations.length ? "" : "disabled"}>Select · ${cost} ${SUIT_GLYPH[SUIT.SPADES]}</button></div>`;
  }).join("") : `<div class="empty-state">You control no Levies able to Mobilize.</div>`;
  dom.actionControls.innerHTML = `<p class="eyebrow">Summer · Mobilize</p><h2>Move Levies</h2><div class="action-list">${rows}</div>${passButton()}`;
}

function renderSiegeActions() {
  const player = activePlayer();
  const levies = liveUnits(state, player).filter(isLevy);
  const rows = levies.length ? levies.map((unit) => {
    const targets = legalSiegeTargets(state, unit.unit_id);
    const costs = targets.map((id) => actionCost(state, "SIEGE", { actor: player, defender_id: id }));
    return `<div class="action-row"><div><strong>${formatUnit(unit, state)}</strong><small>${targets.length ? targets.map((id, index) => `${formatUnit(state.units_by_id[id], state)}: ${costs[index]} ${SUIT_GLYPH[SUIT.SPADES]}`).join(" · ") : "No adjacent enemy"}</small></div><button class="button tiny select-siege" data-unit-id="${unit.unit_id}" ${targets.length ? "" : "disabled"}>Select</button></div>`;
  }).join("") : `<div class="empty-state">You control no Levies able to Lay Siege.</div>`;
  dom.actionControls.innerHTML = `<p class="eyebrow">Summer · Siege</p><h2>Lay Siege</h2><div class="rule-note">Cost = defending player's Unit count + target Level, paid in ${SUIT_GLYPH[SUIT.SPADES]}. Red-ringed targets can be paid for from your pool.</div><div class="action-list">${rows}</div>${passButton()}`;
}

function renderVassalizeActions() {
  const player = activePlayer();
  const nobles = courtNobles(state, player);
  const holdings = availableHoldingUnits(state, player);
  const disabled = !nobles.length || !holdings.length;
  if (!nobles.some((noble) => noble.noble_id === vassalSelection.nobleId)) vassalSelection.nobleId = nobles[0]?.noble_id;
  if (!holdings.some((unit) => unit.unit_id === vassalSelection.unitId)) vassalSelection.unitId = holdings[0]?.unit_id;
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Fall · Vassalize</p><h2>Assign a Noble</h2>
    <div class="control-stack">
      <label for="vassal-noble">Court Noble</label>
      <select id="vassal-noble" ${disabled ? "disabled" : ""}>${nobles.map((noble) => `<option value="${noble.noble_id}" ${noble.noble_id === vassalSelection.nobleId ? "selected" : ""}>${formatNoble(noble)}</option>`).join("")}</select>
      <label for="vassal-unit">Holding</label>
      <select id="vassal-unit" ${disabled ? "disabled" : ""}>${holdings.map((unit) => `<option value="${unit.unit_id}" ${unit.unit_id === vassalSelection.unitId ? "selected" : ""}>${formatUnit(unit, state)} · Level ${LEVEL_BY_TYPE[unit.unit_type]}</option>`).join("")}</select>
      <div id="vassal-cost" class="rule-note">${disabled ? "A Court Noble and an unassigned Holding are required." : "Cost uses the current ♡ base and the selected Noble’s title."}</div>
      <button id="vassalize" class="button primary" ${disabled ? "disabled" : ""}>Vassalize</button>
    </div>
    ${passButton()}
  `;
}

function renderExecuteActions() {
  const player = activePlayer();
  const nobleId = state.players[player].dungeon_noble_id;
  const noble = nobleId ? state.nobles_by_id[nobleId] : null;
  const cost = noble ? actionCost(state, "EXECUTE", { actor: player, noble_id: nobleId }) : null;
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Fall · Execute</p><h2>Dungeon</h2>
    ${noble ? `<div class="action-row"><div><strong>${formatNoble(noble)}</strong><small>${actionCostDescription(state, "EXECUTE", { noble_id: nobleId })}<br>${fundingDescription(cost)}</small></div><button id="execute-hostage" class="button danger" ${hasPool(cost) ? "" : "disabled"}>${cost} ${SUIT_GLYPH[SUIT.HEARTS]}</button></div>` : `<div class="empty-state">Your Dungeon is empty.</div>`}
    ${passButton()}
  `;
}

function renderStockpileActions() {
  const player = activePlayer();
  const bonus = storageBonusCount(state, player);
  const selectionError = validateStockpile(state, player, [...selectedResourceIds]);
  dom.actionControls.innerHTML = `
    <p class="eyebrow">Year end</p><h2>Stockpile / Discard</h2>
    <p>Select the Resource Cards to keep. Unselected cards return to their decks. Cards marked “!” must be spent or returned this Year.</p>
    <div class="rule-note">A legal selection favouring higher effective values is suggested. You may change every selection.</div>
    <div class="rule-note">One baseline slot per suit, plus ${bonus} bonus slot${bonus === 1 ? "" : "s"}. No more than two cards of a suit; each bonus slot must serve a different suit.</div>
    <div class="resource-row">${sortResourceCards(state.players[player].resource_hand_ids.map((id) => state.resources_by_id[id])).map((card) => resourceCheckbox(card, "STOCKPILE")).join("")}</div>
    ${selectionError ? `<p role="status" class="selection-error">${escapeHtml(selectionError)}</p>` : ""}
    <button id="commit-stockpile" class="button primary full" ${selectionError ? "disabled" : ""}>Keep ${selectedResourceIds.size} selected card${selectedResourceIds.size === 1 ? "" : "s"}</button>
  `;
}

function passButton() {
  return `<div class="choice-grid">${onlinePayload?.viewer.can_undo ? `<button id="online-undo" class="button quiet">Undo latest action</button>` : ""}<button id="pass-phase" class="button quiet full">Pass ${title(state.phase)}${onlinePayload ? " and publish" : ""}</button></div>`;
}

function renderPlayerSummary() {
  const viewer = onlinePayload ? onlinePayload.viewer.seat : activePlayer();
  const names = onlinePayload ? Object.fromEntries(Object.entries(onlinePayload.room.seats).filter(([, seat]) => seat).map(([player, seat]) => [player, seat.name])) : {};
  dom.playerSummary.innerHTML = `<p class="eyebrow">Resources</p><h2>Political order</h2>${realmComparisonHtml(state, viewer, names)}`;
}

function visibleChronicle() {
  const view = onlinePayload ? state : projectForPlayer(state, activePlayer());
  const playerNames = onlinePayload ? Object.fromEntries(Object.entries(onlinePayload.room.seats)
    .filter(([, seat]) => seat).map(([player, seat]) => [player, seat.name])) : {};
  return formatChronicle(view, { playerNames });
}

function renderHistory() {
  const nearBottom = dom.history.scrollHeight - dom.history.clientHeight - dom.history.scrollTop < 48;
  dom.history.textContent = visibleChronicle();
  if (nearBottom) dom.history.scrollTop = dom.history.scrollHeight;
  document.querySelector("#chronicle-visibility").textContent = (onlinePayload ? state.chronicle_complete : state.status === "COMPLETE")
    ? "Complete game record" : "Harvest cards are public · only private Court identities are concealed";
}

function bindDynamicControls() {
  document.querySelectorAll("[data-resource-id]").forEach((checkbox) => {
    checkbox.onchange = () => {
      if (checkbox.checked) selectedResourceIds.add(checkbox.dataset.resourceId);
      else selectedResourceIds.delete(checkbox.dataset.resourceId);
      renderActionControls();
      bindDynamicControls();
      updateTapPreview();
    };
  });
  bindActionControlsOnly();
  updateTapPreview();
}

function updateTapPreview() {
  const button = document.querySelector("#tap-selected");
  if (!button) return;
  const suit = ACTIVE_SUIT_BY_PHASE[state.phase];
  const cards = [...selectedResourceIds].map((id) => state.resources_by_id[id])
    .filter((card) => card && !card.tapped && card.suit === suit);
  const value = cards.reduce((total, card) => total + card.face_value + Number(card.has_counter), 0);
  const pool = state.players[activePlayer()].seasonal_pools[suit];
  button.disabled = cards.length === 0;
  button.textContent = cards.length ? `Tap ${value} ${SUIT_GLYPH[suit]}` : "Select cards to tap";
  const preview = document.querySelector("#tap-preview");
  if (preview) preview.textContent = cards.length ? `Pool: ${pool} → ${pool + value}. Unused points expire after ${seasonForPhase(state.phase)}.` : "You choose which cards to spend.";
}

function bindActionControlsOnly() {
  onClick("online-pass", passOnlineTurn);
  onClick("online-undo", undoLastAction);
  document.querySelectorAll(".sovereign-choice").forEach((button) => button.addEventListener("click", () => run({ type: "CHOOSE_SOVEREIGN", player: activePlayer(), noble_id: button.dataset.nobleId })));
  document.querySelectorAll(".harvest-draw").forEach((button) => button.addEventListener("click", () => run({ type: "DRAW_HARVEST", player: activePlayer(), unit_id: button.dataset.unitId, deck: button.dataset.deck, auto_harvest: true })));
  document.querySelectorAll(".harvest-keep").forEach((button) => button.addEventListener("click", () => run({ type: "KEEP_HARVEST_CARD", player: activePlayer(), card_id: button.dataset.cardId, auto_harvest: true })));
  document.querySelectorAll(".upgrade-action").forEach((button) => button.addEventListener("click", () => run({ type: "UPGRADE_UNIT", player: activePlayer(), unit_id: button.dataset.unitId, to_type: button.dataset.toType })));
  document.querySelectorAll(".select-move").forEach((button) => button.addEventListener("click", () => selectMovement(button.dataset.unitId)));
  document.querySelectorAll(".select-siege").forEach((button) => button.addEventListener("click", () => selectSiege(button.dataset.unitId)));
  onClick("tap-selected", () => run({ type: "TAP_RESOURCES", player: activePlayer(), card_ids: [...selectedResourceIds] }));
  onClick("use-failsafe", () => run({ type: "RESOLVE_HARVEST_FAILSAFE", player: activePlayer(), use: true }));
  onClick("decline-failsafe", () => run({ type: "RESOLVE_HARVEST_FAILSAFE", player: activePlayer(), use: false, auto_harvest: true }));
  onClick("declare-poker", () => run({ type: "DECLARE_POKER", player: activePlayer(), card_ids: [...selectedResourceIds] }));
  onClick("finish-poker", () => run({ type: "FINISH_POKER", player: activePlayer() }));
  onClick("activate-build", () => {
    interaction = { mode: "BUILD", unitId: null, legalSquares: new Set(validBuildTargets(state, activePlayer())), attackSquares: new Set() };
    renderBoard();
  });
  onClick("pay-ransom", () => run({ type: "RESPOND_RANSOM", player: activePlayer(), pay: true }));
  onClick("decline-ransom", () => run({ type: "RESPOND_RANSOM", player: activePlayer(), pay: false }));
  onClick("recruit-noble", () => run({ type: "RECRUIT_NOBLE", player: activePlayer() }));
  onClick("give-quarter", () => run({ type: "CHOOSE_QUARTER", player: activePlayer(), quarter: true }));
  onClick("no-quarter", () => run({ type: "CHOOSE_QUARTER", player: activePlayer(), quarter: false }));
  onClick("take-conquest-card", () => run({ type: "CHOOSE_CONQUEST", player: activePlayer(), choice: "CARD" }));
  onClick("take-conquest-holding", () => run({ type: "CHOOSE_CONQUEST", player: activePlayer(), choice: "HOLDING" }));
  onClick("execute-hostage", () => run({ type: "EXECUTE_HOSTAGE", player: activePlayer() }));
  onClick("pass-phase", () => onlineClient ? passOnlineTurn() : run({ type: "PASS_PHASE", player: activePlayer() }));
  onClick("commit-stockpile", () => run({ type: "CHOOSE_STOCKPILE", player: activePlayer(), card_ids: [...selectedResourceIds] }));
  onClick("victory-new", () => dom.newDialog.showModal());
  onClick("vassalize", () => {
    const nobleId = document.querySelector("#vassal-noble")?.value;
    const unitId = document.querySelector("#vassal-unit")?.value;
    if (nobleId && unitId) run({ type: "VASSALIZE_NOBLE", player: activePlayer(), noble_id: nobleId, unit_id: unitId });
  });
  const nobleSelect = document.querySelector("#vassal-noble");
  if (nobleSelect) {
    const updateCost = () => {
      const nobleId = nobleSelect.value;
      vassalSelection.nobleId = nobleId;
      const output = document.querySelector("#vassal-cost");
      if (nobleId && output) {
        const cost = actionCost(state, "VASSALIZE", { actor: activePlayer(), noble_id: nobleId });
        output.textContent = `${actionCostDescription(state, "VASSALIZE", { noble_id: nobleId })}. ${fundingDescription(cost)}.`;
        document.querySelector("#vassalize").disabled = !vassalSelection.unitId || !hasPool(cost);
      }
    };
    nobleSelect.addEventListener("change", updateCost);
    updateCost();
  }
  const unitSelect = document.querySelector("#vassal-unit");
  if (unitSelect) unitSelect.onchange = () => { vassalSelection.unitId = unitSelect.value; };
}

function onClick(id, callback) {
  const element = document.querySelector(`#${id}`);
  if (element) element.onclick = callback;
}

function commandLabel(command) {
  const labels = {
    ACKNOWLEDGE_PHASE_NOTICE: "the automatic phase pass",
    BUILD_UNIT: "the Build",
    CHOOSE_QUARTER: "the Quarter decision",
    CHOOSE_CONQUEST: "the Conquest choice",
    CHOOSE_SOVEREIGN: "the Sovereign choice",
    CHOOSE_STOCKPILE: "the Stockpile decision",
    DECLARE_POKER: "the Poker declaration",
    DRAW_HARVEST: "the Harvest draw",
    EXECUTE_HOSTAGE: "the Execution",
    FINISH_POKER: "finishing Poker declarations",
    KEEP_HARVEST_CARD: "the Harvest keep",
    LAY_SIEGE: "the Siege",
    MOBILIZE_UNIT: "the Mobilization",
    PASS_PHASE: "the phase pass",
    RECRUIT_NOBLE: "the Recruitment",
    RESPOND_RANSOM: "the Ransom decision",
    TAP_RESOURCES: "the Resource tap",
    UPGRADE_UNIT: "the Upgrade",
    VASSALIZE_NOBLE: "the Vassalization",
  };
  return labels[command?.type] ?? "the previous action";
}

async function passOnlineTurn() {
  if (!onlineClient || onlineRequestPending) return;
  if (pendingAutomaticNotices().length) { maybeShowPhaseNotice(); return; }
  onlineRequestPending = true;
  try {
    const payload = await onlineClient.pass();
    dismissedOnlineNotice = null;
    applyOnlinePayload(payload, { resetSelection: true, force: true });
    showToast("Turn published.", true);
  } catch (error) {
    showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
  } finally {
    onlineRequestPending = false;
  }
}

async function undoLastAction() {
  if (onlineClient) {
    if (!onlinePayload?.viewer.can_undo || onlineRequestPending) return;
    if (!window.confirm("Undo your latest unpublished action?")) return;
    onlineRequestPending = true;
    try {
      const payload = await onlineClient.undo();
      dismissedOnlineNotice = null;
      applyOnlinePayload(payload, { resetSelection: true, force: true });
      showToast("Unpublished action restored.", true);
    } catch (error) {
      showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
    } finally {
      onlineRequestPending = false;
    }
    return;
  }
  const snapshot = undoStack.at(-1);
  if (!snapshot) return;
  if (!window.confirm(`Undo ${commandLabel(snapshot.command)}?`)) return;
  const previousActor = state.current_actor;
  undoStack.pop();
  state = snapshot.state;
  selectedResourceIds = snapshot.selectedResourceIds;
  interaction = snapshot.interaction;
  stockpileSelectionKey = snapshot.stockpileSelectionKey;
  saveToBrowser(state);
  render();
  if (state.status !== "COMPLETE" && state.current_actor && state.current_actor !== previousActor) {
    showHandoff(state.current_actor);
  } else {
    maybeShowPhaseNotice();
  }
  showToast("Previous action restored.", true);
}

function onlineSeatOrder(playerCount) {
  return playerCount === 2
    ? [PLAYER.WHITE, PLAYER.BLACK]
    : [PLAYER.WHITE, PLAYER.GREEN, PLAYER.BLACK, PLAYER.RED];
}

function updateOnlineCreateSeats() {
  const current = dom.onlineCreateSeat.value;
  const seats = onlineSeatOrder(Number(dom.onlineCreateCount.value));
  dom.onlineCreateSeat.innerHTML = seats.map((seat) => `<option value="${seat}">${playerName(seat)}</option>`).join("");
  if (seats.includes(current)) dom.onlineCreateSeat.value = current;
}

function onlineRoomName(seat) {
  return onlinePayload?.room.seats[seat]?.name ?? playerName(seat);
}

function renderOnlineChrome() {
  if (!onlinePayload || !onlineClient) {
    dom.onlineStrip.hidden = true;
    dom.onlineLobby.hidden = true;
    return;
  }
  const { room, viewer } = onlinePayload;
  const identity = viewer.role === "PLAYER"
    ? `You are <strong>${playerName(viewer.seat)}</strong> · ${escapeHtml(onlineRoomName(viewer.seat))}`
    : "<strong>Spectator view</strong>";
  dom.onlineStripText.innerHTML = `<strong>BrezelPesk</strong> · Room <strong>${room.code}</strong> · ${identity} · ${room.spectator_count} spectator${room.spectator_count === 1 ? "" : "s"}`;
  dom.onlineStrip.hidden = false;
  if (room.status === "LOBBY") renderOnlineLobby();
  else dom.onlineLobby.hidden = true;
}

function renderOnlineLobby() {
  const { room, viewer } = onlinePayload;
  dom.onlineLobbyTitle.textContent = `Room ${room.code}`;
  const occupied = Object.values(room.seats).filter(Boolean).length;
  dom.onlineLobbyStatus.textContent = viewer.role === "PLAYER"
    ? `You have joined as ${playerName(viewer.seat)}. ${occupied} of ${room.player_count} player seats are occupied.`
    : `You are watching the lobby. ${occupied} of ${room.player_count} player seats are occupied; claim an open color to play.`;
  dom.onlineSeatList.innerHTML = onlineSeatOrder(room.player_count).map((seat) => {
    const occupant = room.seats[seat];
    const open = !occupant && viewer.role === "SPECTATOR";
    const tag = open ? "button" : "div";
    return `
      <${tag} class="online-seat ${open ? "open" : ""}" ${open ? `data-join-seat="${seat}"` : ""}>
        <span class="player-seal ${seat.toLowerCase()}">${playerCode(seat)}</span>
        <strong>${playerName(seat)}</strong>
        <small>${occupant ? `${escapeHtml(occupant.name)}${occupant.connected ? ` · <span class="presence-dot">connected</span>` : ""}` : open ? "Open · click to join" : "Open"}</small>
      </${tag}>`;
  }).join("");
  dom.onlineJoinControls.hidden = viewer.role === "PLAYER";
  dom.startOnlineMatch.hidden = !viewer.is_host;
  dom.startOnlineMatch.disabled = !viewer.can_start;
  dom.startOnlineMatch.textContent = viewer.can_start ? "Start match" : "Waiting for every seat";
  dom.onlineLobby.hidden = false;
  dom.onlineSeatList.querySelectorAll("[data-join-seat]").forEach((button) => {
    button.addEventListener("click", () => joinOnlineSeat(button.dataset.joinSeat));
  });
}

function rememberOnlineLocation(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", code);
  history.replaceState(null, "", url);
}

function beginOnlinePolling() {
  window.clearTimeout(onlinePollTimer);
  let delay = 3000;
  async function tick() {
    if (!onlineClient) return;
    const client = onlineClient;
    if (!document.hidden && !onlineRequestPending && !client.busy) {
      try {
        const before = client.lastView;
        const payload = await client.view();
        if (onlineClient !== client) return;
        delay = before === payload ? Math.min(delay * 1.5, 20000) : 3000;
        applyOnlinePayload(payload);
      } catch (error) {
        delay = Math.min(delay * 2, 30000);
        if (error.code !== "SERVER_UNREACHABLE") showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
      }
    }
    onlinePollTimer = window.setTimeout(tick, delay);
  }
  onlinePollTimer = window.setTimeout(tick, 3000);
}
document.addEventListener?.("visibilitychange", async () => {
  if (!document.hidden && onlineClient && !onlineRequestPending && !onlineClient.busy) {
    const client = onlineClient;
    try {
      const payload = await client.view();
      if (onlineClient === client) applyOnlinePayload(payload);
    } catch (error) { if (onlineClient === client) showToast(error.message); }
    if (onlineClient === client) beginOnlinePolling();
  }
});

async function enterOnlineRoom(code, { spectate = false } = {}) {
  const candidate = new OnlineClient(code, { spectate });
  if (!candidate.code) return showToast("Enter a six-character room code.");
  onlineRequestPending = true;
  try {
    const payload = await candidate.view();
    onlineClient = candidate;
    dismissedOnlineNotice = null;
    dom.handoff.hidden = true;
    dom.onlineDialog.close();
    rememberOnlineLocation(candidate.code);
    applyOnlinePayload(payload, { resetSelection: true, force: true });
    beginOnlinePolling();
  } catch (error) {
    showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
  } finally {
    onlineRequestPending = false;
  }
}

async function createOnlineRoom() {
  if (onlineRequestPending) return;
  const playerNameValue = dom.onlineCreateName.value.trim();
  onlineRequestPending = true;
  try {
    const { client, payload } = await OnlineClient.create({
      playerCount: Number(dom.onlineCreateCount.value),
      playerName: playerNameValue,
      seat: dom.onlineCreateSeat.value,
    });
    onlineClient = client;
    dismissedOnlineNotice = null;
    dom.onlineJoinName.value = playerNameValue;
    dom.onlineDialog.close();
    dom.handoff.hidden = true;
    rememberOnlineLocation(client.code);
    applyOnlinePayload(payload, { resetSelection: true, force: true });
    beginOnlinePolling();
  } catch (error) {
    showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
  } finally {
    onlineRequestPending = false;
  }
}

async function joinOnlineSeat(seat) {
  if (!onlineClient || onlineRequestPending) return;
  if (pendingAutomaticNotices().length) { maybeShowPhaseNotice(); return; }
  onlineRequestPending = true;
  try {
    const payload = await onlineClient.join({ playerName: dom.onlineJoinName.value.trim(), seat });
    applyOnlinePayload(payload, { resetSelection: true, force: true });
    showToast(`Joined as ${playerName(seat)}.`, true);
  } catch (error) {
    showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
  } finally {
    onlineRequestPending = false;
  }
}

async function startOnlineMatch() {
  if (!onlineClient || onlineRequestPending) return;
  if (pendingAutomaticNotices().length) { maybeShowPhaseNotice(); return; }
  onlineRequestPending = true;
  try {
    const payload = await onlineClient.start();
    applyOnlinePayload(payload, { resetSelection: true, force: true });
    showToast("Online match started.", true);
  } catch (error) {
    showToast(`${error.code ?? "ONLINE_ERROR"}: ${error.message}`);
  } finally {
    onlineRequestPending = false;
  }
}

function leaveOnlineMode({ updateLocation = true, restoreLocal = false } = {}) {
  window.clearTimeout(onlinePollTimer);
  onlinePollTimer = null;
  onlineClient = null;
  onlinePayload = null;
  dismissedOnlineNotice = null;
  dom.onlineStrip.hidden = true;
  dom.onlineLobby.hidden = true;
  dom.phaseNotice.hidden = true;
  if (updateLocation) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    history.replaceState(null, "", url);
  }
  if (restoreLocal) {
    state = loadInitialState();
    selectedResourceIds = new Set();
    interaction = emptyInteraction();
    stockpileSelectionKey = null;
    undoStack = [];
    render();
    showHandoff(activePlayer());
  }
}

async function copyOnlineRoomLink() {
  if (!onlineClient) return;
  try {
    await navigator.clipboard.writeText(onlineShareUrl(onlineClient.code));
    showToast("Spectator and invitation link copied.", true);
  } catch {
    showToast(`Room code: ${onlineClient.code}`);
  }
}

document.querySelector("#accept-handoff").addEventListener("click", hideHandoff);
document.querySelector("#new-game").addEventListener("click", () => dom.newDialog.showModal());
document.querySelector("#online-game").addEventListener("click", () => {
  dom.onlineCreateName.value = OnlineClient.rememberedName();
  dom.onlineJoinName.value = OnlineClient.rememberedName();
  dom.onlineDialog.showModal();
});
document.querySelector("#create-online-room").addEventListener("click", createOnlineRoom);
document.querySelector("#open-online-room").addEventListener("click", () => enterOnlineRoom(dom.onlineRoomCode.value));
dom.onlineCreateCount.addEventListener("change", updateOnlineCreateSeats);
dom.onlineRoomCode.addEventListener("input", () => { dom.onlineRoomCode.value = dom.onlineRoomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
dom.startOnlineMatch.addEventListener("click", startOnlineMatch);
async function copyRecoveryCode() {
  const code = onlineClient?.recoveryCode();
  if (!code || onlinePayload?.viewer.role !== "PLAYER") return showToast("Recover or join a seat first.");
  try { await navigator.clipboard.writeText(code); showToast("Private recovery code copied. Keep it somewhere safe.", true); }
  catch { showToast("Clipboard access failed. Allow clipboard access and try again."); }
}
document.querySelector("#copy-recovery-code").addEventListener("click", copyRecoveryCode);
document.querySelector("#lobby-copy-recovery").addEventListener("click", copyRecoveryCode);
document.querySelector("#recover-online-seat").addEventListener("click", async () => {
  if (onlineRequestPending) return;
  const codeInput = document.querySelector("#online-recovery-code");
  const candidate = new OnlineClient(dom.onlineRoomCode.value);
  onlineRequestPending = true;
  try {
    const payload = await candidate.recover(codeInput.value);
    codeInput.value = ""; onlineClient = candidate; dom.onlineDialog.close(); dom.handoff.hidden = true;
    rememberOnlineLocation(candidate.code); applyOnlinePayload(payload, { resetSelection: true, force: true }); beginOnlinePolling();
  } catch (error) { showToast(error.message); }
  finally { onlineRequestPending = false; }
});
document.querySelector("#copy-room-link").addEventListener("click", copyOnlineRoomLink);
document.querySelector("#lobby-copy-link").addEventListener("click", copyOnlineRoomLink);
document.querySelector("#leave-online").addEventListener("click", () => leaveOnlineMode({ restoreLocal: true }));
document.querySelector("#lobby-close").addEventListener("click", () => leaveOnlineMode({ restoreLocal: true }));
dom.undoAction.addEventListener("click", undoLastAction);
document.querySelector("#dismiss-phase-notice").addEventListener("click", acknowledgeCurrentPhaseNotice);
document.querySelector("#load-autosave").addEventListener("click", () => {
  try {
    if (onlineClient) leaveOnlineMode();
    const loaded = loadFromBrowser();
    if (!loaded) return showToast("No browser autosave exists yet.");
    state = upgradeToV15(loaded);
    selectedResourceIds = new Set();
    interaction = emptyInteraction();
    stockpileSelectionKey = null;
    undoStack = [];
    render();
    showHandoff(activePlayer());
    showToast("Autosave loaded.", true);
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#export-save").addEventListener("click", async () => {
  let contents;
  try { contents = onlineClient ? JSON.stringify(await onlineClient.export(), null, 2) : serializeMatch(state); }
  catch (error) { return showToast(error.message); }
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dendarv-${state.match_id}-year-${state.year_number}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("Save exported.", true);
});
document.querySelector("#import-save").addEventListener("click", () => dom.importFile.click());
dom.importFile.addEventListener("change", async () => {
  const file = dom.importFile.files?.[0];
  if (!file) return;
  try {
    if (onlineClient) leaveOnlineMode();
    state = upgradeToV15(deserializeMatch(await file.text()));
    saveToBrowser(state);
    selectedResourceIds = new Set();
    interaction = emptyInteraction();
    stockpileSelectionKey = null;
    undoStack = [];
    render();
    showHandoff(activePlayer());
    showToast("Match imported.", true);
  } catch (error) {
    showToast(error.message);
  } finally {
    dom.importFile.value = "";
  }
});
document.querySelector("#copy-log").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(onlineClient ? formatChronicle((await onlineClient.export()).state) : visibleChronicle());
    showToast("Standard chronicle copied.", true);
  } catch {
    showToast("Clipboard access is unavailable in this browser.");
  }
});
document.querySelector("#download-log").addEventListener("click", async () => {
  let text;
  try { text = onlineClient ? formatChronicle((await onlineClient.export()).state) : visibleChronicle(); }
  catch (error) { return showToast(error.message); }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `Dendarv-Chronicle-${state.match_id}-Year-${state.year_number}.txt`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});
dom.newForm.addEventListener("submit", (event) => {
  const submitter = event.submitter?.value;
  if (submitter !== "start") return;
  event.preventDefault();
  dom.newDialog.close();
  newLocalMatch(dom.seed.value.trim(), Number(dom.playerCount.value));
});

updateOnlineCreateSeats();
dom.onlineCreateName.value = OnlineClient.rememberedName();
dom.onlineJoinName.value = OnlineClient.rememberedName();

render();
const initialRoomCode = roomCodeFromLocation();
if (initialRoomCode) {
  dom.handoff.hidden = true;
  enterOnlineRoom(initialRoomCode);
} else {
  showHandoff(activePlayer());
}
