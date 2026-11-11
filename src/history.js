import { dispatch, newMatch } from "./engine.js";
import { deepClone } from "./model.js";
import { validateInvariants } from "./rules.js";

const gameUndoCache = new Map();
function historyFingerprint(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

// The cache is bounded; Undo depth is not. Older saves need no new checkpoints.
export function gameUndoStep(current) {
  if (!current?.command_log?.length) return { state: null };
  const key = historyFingerprint(current);
  if (gameUndoCache.has(key)) return gameUndoCache.get(key);
  let entry;
  try {
    const creation = current.event_log?.find(event => event.type === "MatchCreated");
    if (!creation?.payload.rules || creation.payload.seed !== current.seed) throw new Error("Missing match history");
    let replay = newMatch({
      seed: current.seed, rules: creation.payload.rules, matchId: current.match_id,
      playerCount: creation.payload.player_count ?? current.player_order?.length,
    });
    let previous, events;
    for (const command of current.command_log) {
      previous = replay;
      const result = dispatch(replay, command);
      if (!result.ok) throw new Error("Command history cannot be reproduced");
      replay = result.state; events = result.events;
    }
    if (!previous || historyFingerprint(replay) !== key || validateInvariants(previous).length) {
      throw new Error("Saved position does not match its history");
    }
    entry = { state: previous, command: deepClone(current.command_log.at(-1)), events };
  } catch {
    entry = { state: null, error: "UNDO_HISTORY_UNVERIFIED",
      message: "The saved history could not be verified. Nothing was changed." };
  }
  if (gameUndoCache.size >= 8) gameUndoCache.delete(gameUndoCache.keys().next().value);
  gameUndoCache.set(key, entry);
  return entry;
}
