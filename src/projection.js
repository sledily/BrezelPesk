import { PLAYER } from "./constants.js";
import { deepClone, matchPlayers } from "./model.js";
import { chronicleEvents } from "./notation.js";

function hiddenCards(count) {
  return Array.from({ length: count }, (_, index) => ({ hidden: true, index }));
}

export function projectForPlayer(state, viewer, { revealComplete = state.status === "COMPLETE" } = {}) {
  const view = deepClone(state);
  view.chronicle_complete = revealComplete && state.status === "COMPLETE";
  delete view.seed;
  delete view.rng_state;
  delete view.command_log;
  view.automatic_notices = (state.automatic_notices ?? []).filter((notice) => notice.player === viewer);
  for (const player of matchPlayers(state)) {
    const ownsView = player === viewer || revealComplete;
    const courtIds = state.players[player].court_noble_ids;
    if (!ownsView) {
      delete view.players[player].stockpile_instructions;
      view.players[player].court_noble_ids = hiddenCards(courtIds.length);
      for (const nobleId of courtIds) delete view.nobles_by_id[nobleId];
    }
    if (!state.rules.resource_hands_public && !ownsView) {
      const resourceIds = state.players[player].resource_hand_ids;
      view.players[player].resource_hand_ids = hiddenCards(resourceIds.length);
      for (const resourceId of resourceIds) delete view.resources_by_id[resourceId];
    }
  }
  view.decks = {
    BLACK: { count: state.decks.BLACK.length },
    RED: { count: state.decks.RED.length },
    NOBLE: { count: state.decks.NOBLE.length },
  };
  view.event_log = chronicleEvents(state).map((event) => {
    if (event.type === "MatchCreated") {
      return {
        ...event,
        payload: {
          player_count: event.payload.player_count ?? matchPlayers(state).length,
        },
      };
    }
    if (event.type === 'ResignedNoblesReturned' && !revealComplete) return {...event,payload:{player:event.payload.player,returned_count:event.payload.noble_ids.length}};
    if (event.type === 'DefeatedCourtClaimed' && event.payload.victor !== viewer && !revealComplete) {
      const {captured_ids,...payload}=event.payload;
      if(payload.chronicle) payload.chronicle={...payload.chronicle,text:payload.chronicle.public_text};
      return {...event,payload};
    }
    if (event.type === "DefeatedCourtDispersed" && event.payload.defeated_player !== viewer && !revealComplete) {
      return { ...event, payload: { defeated_player: event.payload.defeated_player,
        returned_count: event.payload.noble_ids?.length ?? event.payload.returned_count ?? 0 } };
    }
    if (["HarvestCardsDrawn", "HarvestCardKept", "HarvestFailsafeUsed", "HarvestFailsafeDeclined"].includes(event.type)) return { ...event, visibility: "PUBLIC" };
    if (event.visibility === "PUBLIC" || event.visibility === viewer || revealComplete) return event;
    const entry = event.payload.chronicle;
    const chronicle = entry?.public_text ? { player: entry.player, section: entry.section, text: entry.public_text } : null;
    return { ...event, payload: { hidden: true, ...(chronicle ? { chronicle } : {}) } };
  });
  return view;
}

export function projectSpectator(state) {
  return projectForPlayer(state, null, { revealComplete: false });
}

export function playerName(player) {
  return {
    [PLAYER.WHITE]: "White",
    [PLAYER.GREEN]: "Green",
    [PLAYER.BLACK]: "Black",
    [PLAYER.RED]: "Red",
  }[player] ?? "Unknown";
}
