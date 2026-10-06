import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FOUR_PLAYER_COUNTERCLOCKWISE, PLAYER, TWO_PLAYER_ORDER, V2_RULES } from "./constants.js";
import { dispatch, newMatch, preserveStockpileInstructions, reversibleAction, turnBoundaryCrossed, upgradeToV15 } from "./engine.js";
import { deepClone } from "./model.js";
import { projectForPlayer, projectSpectator } from "./projection.js";
import { validateInvariants } from "./rules.js";

const ROOM_SCHEMA_VERSION = 2;
const NAME_LIMIT = 40;

export class RoomError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RoomError";
    this.code = code;
    this.status = status;
  }
}

function roomFail(code, message, status = 400) {
  throw new RoomError(code, message, status);
}

function cleanName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name) roomFail("NAME_REQUIRED", "Enter a player name");
  if (name.length > NAME_LIMIT) roomFail("NAME_TOO_LONG", `Player names may contain at most ${NAME_LIMIT} characters`);
  return name;
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function newToken() {
  return randomBytes(24).toString("base64url");
}

function seatsForCount(playerCount) {
  if (playerCount === 2) return [...TWO_PLAYER_ORDER];
  if (playerCount === 4) return [...FOUR_PLAYER_COUNTERCLOCKWISE];
  roomFail("INVALID_PLAYER_COUNT", "Dendarv supports two or four players");
}

function publicSeats(room, now = Date.now()) {
  return Object.fromEntries(room.seat_order.map((seat) => {
    const occupant = room.seats[seat];
    return [seat, occupant ? {
      name: occupant.name,
      connected: Boolean(occupant.last_seen_at && now - Date.parse(occupant.last_seen_at) < 60_000),
    } : null];
  }));
}

export function identifySeat(room, token) {
  if (!token) return null;
  const hash = tokenHash(token);
  return room.seat_order.find((seat) => room.seats[seat]?.token_hash === hash) ?? null;
}

function makeCode(existing) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = Array.from(randomBytes(6), (value) => alphabet[value & 31]).join("");
    if (!existing[code]) return code;
  }
  roomFail("ROOM_CODE_FAILURE", "Could not allocate a room code", 500);
}

export function cloneForStorage(room) {
  const stored = deepClone(room);
  for (const seat of stored.seat_order) delete stored.seats[seat]?.last_seen_at;
  return stored;
}

function browserProjection(state, seat, revealComplete = false) {
  const view = projectForPlayer(state, seat, { revealComplete });
  for (const [id, noble] of Object.entries(view.nobles_by_id)) {
    if (noble.location === "NOBLE_DECK") delete view.nobles_by_id[id];
  }
  for (const [id, resource] of Object.entries(view.resources_by_id)) {
    if (resource.location === "BLACK_DECK" || resource.location === "RED_DECK") delete view.resources_by_id[id];
  }
  view.deck_counts = Object.fromEntries(Object.entries(view.decks).map(([deck, summary]) => [deck, summary.count]));
  view.decks = Object.fromEntries(Object.entries(view.decks).map(([deck, summary]) => (
    [deck, Array.from({ length: summary.count }, () => null)]
  )));
  return view;
}

function undoSnapshot(base, result, metadata) {
  const snapshot = { state: deepClone(base), ...metadata };
  const logs = ["event_log", "command_log"];
  // Ordinary actions usually append to these histories. Store exact prefix lengths,
  // not another copy of the entire match record for every reversible action.
  // If a handler rewrites an older entry, retain a full snapshot instead.
  if (logs.every(key => JSON.stringify(base[key]) === JSON.stringify(result[key].slice(0, base[key].length)))) {
    snapshot.history_prefix_lengths = Object.fromEntries(logs.map(key => [key, base[key].length]));
    for (const key of logs) delete snapshot.state[key];
  }
  return snapshot;
}

function restoreUndoSnapshot(snapshot, current) {
  const state = deepClone(snapshot.state);
  for (const [key, length] of Object.entries(snapshot.history_prefix_lengths ?? {})) {
    if (!["event_log", "command_log"].includes(key) || !Number.isSafeInteger(length)
      || length < 0 || !Array.isArray(current?.[key]) || length > current[key].length) {
      roomFail("INVALID_UNDO_HISTORY", "The saved Undo history needs administrator attention", 409);
    }
    state[key] = deepClone(current[key].slice(0, length));
  }
  return state;
}

export class RoomStore {
  constructor({ filePath = null, now = () => new Date(), codeFactory = null } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.codeFactory = codeFactory;
    this.rooms = {};
    this.spectators = new Map();
    this.load();
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    if (parsed.schema_version !== ROOM_SCHEMA_VERSION || typeof parsed.rooms !== "object") {
      throw new Error("Unsupported Dendarv room-store schema");
    }
    for (const [code, room] of Object.entries(parsed.rooms)) {
      for (const candidate of [room.committed_state, room.draft_state, ...(room.draft_history ?? []).map((entry) => entry.state)]) {
        if (!candidate) continue;
        const errors = validateInvariants(candidate);
        if (errors.length) throw new Error(`Room ${code} invariant failure: ${errors.join("; ")}`);
      }
    }
    this.rooms = parsed.rooms;
    for (const room of Object.values(this.rooms)) {
      if (room.committed_state && !room.draft_state) room.committed_state = upgradeToV15(room.committed_state);
    }
  }

  persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const payload = {
      schema_version: ROOM_SCHEMA_VERSION,
      saved_at: this.now().toISOString(),
      rooms: Object.fromEntries(Object.entries(this.rooms).map(([code, room]) => [code, cloneForStorage(room)])),
    };
    writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  get(code) {
    const normalized = String(code ?? "").trim().toUpperCase();
    const room = this.rooms[normalized];
    if (!room) roomFail("ROOM_NOT_FOUND", "No online room has that code", 404);
    return room;
  }

  create({ playerCount = 4, playerName, seat = PLAYER.WHITE, seed = null, credentials = {} } = {}) {
    const count = Number(playerCount);
    const seatOrder = seatsForCount(count);
    if (!seatOrder.includes(seat)) roomFail("INVALID_SEAT", `${seat} is not used in a ${count}-player game`);
    const token = credentials.token ?? newToken();
    const recoveryCode = credentials.recoveryCode ?? newToken();
    const code = this.codeFactory ? this.codeFactory(this.rooms) : makeCode(this.rooms);
    const createdAt = this.now().toISOString();
    const room = {
      schema_version: ROOM_SCHEMA_VERSION,
      code,
      player_count: count,
      seat_order: seatOrder,
      status: "LOBBY",
      seed: String(seed || randomBytes(12).toString("hex")),
      created_at: createdAt,
      updated_at: createdAt,
      host_seat: seat,
      seats: Object.fromEntries(seatOrder.map((player) => [player, null])),
      committed_state: null,
      draft_state: null,
      draft_owner: null,
      draft_history: [],
      draft_turn_complete: false,
      revision: 0,
      draft_revision: 0,
    };
    room.seats[seat] = { name: cleanName(playerName), token_hash: tokenHash(token), recovery_hash: tokenHash(recoveryCode), joined_at: createdAt, last_seen_at: createdAt };
    this.rooms[code] = room;
    this.persist();
    return { code, token, recoveryCode, seat, view: this.view(code, token) };
  }

  join(code, { playerName, seat, credentials = {} } = {}) {
    const room = this.get(code);
    if (room.status !== "LOBBY") roomFail("MATCH_ALREADY_STARTED", "This match has already started", 409);
    if (!room.seat_order.includes(seat)) roomFail("INVALID_SEAT", "Choose an available player color");
    if (room.seats[seat]) roomFail("SEAT_TAKEN", `${seat} is already occupied`, 409);
    const token = credentials.token ?? newToken();
    const recoveryCode = credentials.recoveryCode ?? newToken();
    const joinedAt = this.now().toISOString();
    room.seats[seat] = { name: cleanName(playerName), token_hash: tokenHash(token), recovery_hash: tokenHash(recoveryCode), joined_at: joinedAt, last_seen_at: joinedAt };
    room.revision += 1;
    room.updated_at = joinedAt;
    this.persist();
    return { code: room.code, token, recoveryCode, seat, view: this.view(room.code, token) };
  }

  start(code, token) {
    const room = this.get(code);
    if (identifySeat(room, token) !== room.host_seat) roomFail("HOST_REQUIRED", "Only the room host can start the match", 403);
    if (room.status !== "LOBBY") roomFail("MATCH_ALREADY_STARTED", "This match has already started", 409);
    const empty = room.seat_order.filter((seat) => !room.seats[seat]);
    if (empty.length) roomFail("EMPTY_SEATS", `Waiting for ${empty.join(", ")}`, 409);
    room.committed_state = newMatch({
      seed: room.seed,
      playerCount: room.player_count,
      matchId: `DENDARV-${room.code}`,
      rules: V2_RULES,
    });
    room.status = "ACTIVE";
    room.revision += 1;
    room.updated_at = this.now().toISOString();
    this.persist();
    return this.view(room.code, token);
  }

  view(code, token = null, spectatorId = null) {
    const room = this.get(code);
    const seat = identifySeat(room, token);
    const now = this.now();
    if (room.ended_at && now.getTime() >= Date.parse(room.ended_at) + 30 * 86400000) {
      roomFail("ROOM_ACCESS_EXPIRED", "The ordinary access window for this game has ended", 410);
    }
    const nowIso = now.toISOString();
    if (seat) room.seats[seat].last_seen_at = nowIso;
    if (!seat && spectatorId) {
      if (!this.spectators.has(room.code)) this.spectators.set(room.code, new Map());
      this.spectators.get(room.code).set(spectatorId, now.getTime());
    }
    const recentSpectators = this.spectators.get(room.code);
    if (recentSpectators) {
      for (const [id, seen] of recentSpectators) if (now.getTime() - seen >= 60_000) recentSpectators.delete(id);
    }
    const isHost = Boolean(seat && seat === room.host_seat);
    const canonical = seat && room.draft_state && (room.draft_owner === seat || room.draft_state.current_actor === seat)
      ? room.draft_state
      : room.committed_state;
    const game = canonical ? browserProjection(canonical, seat, Boolean(seat) && ["COMPLETE", "ABANDONED"].includes(room.status)) : null;
    const publicActor = room.committed_state?.current_actor ?? null;
    const draftAdvanced = Boolean(seat && room.draft_owner === seat && room.draft_turn_complete);
    return {
      room: {
        code: room.code,
        status: room.status,
        player_count: room.player_count,
        seats: publicSeats(room, now.getTime()),
        spectator_count: recentSpectators?.size ?? 0,
        revision: room.revision,
      },
      viewer: {
        role: seat ? "PLAYER" : "SPECTATOR",
        seat,
        is_host: isHost,
        can_start: isHost && room.status === "LOBBY" && room.seat_order.every((player) => room.seats[player]),
        is_your_turn: Boolean(seat && room.status === "ACTIVE" && (room.draft_state?.current_actor ?? publicActor) === seat),
        waiting_for_pass: draftAdvanced,
        can_undo: Boolean(room.status === "ACTIVE" && seat && room.draft_owner === seat && room.draft_history.length),
        private_revision: seat && room.draft_state && (room.draft_owner === seat || room.draft_state.current_actor === seat) ? room.draft_revision : room.revision,
      },
      game,
    };
  }

  command(code, token, command) {
    const room = this.get(code);
    if (room.status !== "ACTIVE") roomFail("MATCH_NOT_ACTIVE", "The online match is not active", 409);
    const seat = identifySeat(room, token);
    if (!seat) roomFail("PLAYER_TOKEN_REQUIRED", "A player seat is required", 403);
    if (command?.type === "SET_STOCKPILE_INSTRUCTIONS") return this.saveStockpileInstructions(room, token, seat, command);
    const owner = room.draft_state?.current_actor ?? room.committed_state.current_actor;
    if (seat !== owner) roomFail("NOT_YOUR_TURN", `It is ${owner}'s turn`, 409);
    if (room.draft_state && room.draft_turn_complete) roomFail("PASS_REQUIRED", "Your decisions are complete; press Pass to publish them", 409);
    if (["PASS_PHASE", "ACKNOWLEDGE_PHASE_NOTICE", "APPLY_V15_USABILITY"].includes(command?.type)) {
      roomFail("USE_PASS", "Use the online Pass control to end and publish the turn");
    }
    const base = room.draft_state ?? room.committed_state;
    const safeCommand = { ...deepClone(command), player: seat };
    const result = dispatch(base, safeCommand);
    if (!result.ok) roomFail(result.error.code, result.error.message, 409);
    if (reversibleAction(base, result.state, command)) {
      room.draft_history.push(undoSnapshot(base, result.state, { command: safeCommand,
        owner: room.draft_owner, had_draft: Boolean(room.draft_state), turn_complete: room.draft_turn_complete }));
    } else {
      room.draft_history = [];
    }
    room.draft_state = result.state;
    room.draft_owner ??= seat;
    room.draft_turn_complete = turnBoundaryCrossed(base, result.state, result.events);
    if (result.state.pending_combat || result.state.pending_conquest) room.draft_turn_complete = false;
    const pendingResponse = result.state.pending_combat || result.state.pending_conquest;
    const defenderHandover = result.state.pending_combat && result.state.current_actor !== seat;
    if (result.state.status === "COMPLETE" || defenderHandover || (!pendingResponse && room.draft_turn_complete)
      || ["CHOOSE_QUARTER", "CHOOSE_CONQUEST", "RESPOND_RANSOM"].includes(command.type)) {
      this.commit(room, result.state);
      return this.view(room.code, token);
    }
    room.draft_revision = Math.max(room.draft_revision, room.revision) + 1;
    room.updated_at = this.now().toISOString();
    this.persist();
    return this.view(room.code, token);
  }

  saveStockpileInstructions(room, token, seat, command) {
    const safeCommand = { type: "SET_STOCKPILE_INSTRUCTIONS", player: seat, instructions: deepClone(command.instructions) };
    const base = room.draft_state ?? room.committed_state;
    const result = dispatch(base, safeCommand);
    if (!result.ok) roomFail(result.error.code, result.error.message, 409);
    if (result.events.some(event => event.type === "ResourceStockpileCommitted")) {
      this.commit(room, result.state);
      return this.view(room.code, token);
    }
    if (room.draft_state) {
      const committed = dispatch(room.committed_state, safeCommand);
      if (!committed.ok) roomFail(committed.error.code, committed.error.message, 409);
      room.committed_state = committed.state;
      room.draft_state = result.state;
    } else room.committed_state = result.state;
    // Keep gameplay draft ownership and Undo history. Projections disclose only
    // the requesting player's instructions, even when another turn is in flight.
    room.revision = Math.max(room.revision, room.draft_revision) + 1;
    room.draft_revision = room.revision;
    room.updated_at = this.now().toISOString();
    this.persist();
    return this.view(room.code, token);
  }

  undo(code, token) {
    const room = this.get(code);
    if (room.status !== "ACTIVE") roomFail("MATCH_NOT_ACTIVE", "The online match is not active", 409);
    const seat = identifySeat(room, token);
    if (!seat || room.draft_owner !== seat) roomFail("NOTHING_TO_UNDO", "There is no unpublished action to undo", 409);
    const snapshot = room.draft_history.pop();
    if (!snapshot) roomFail("NOTHING_TO_UNDO", "There is no unpublished action to undo", 409);
    const restored = preserveStockpileInstructions(restoreUndoSnapshot(snapshot, room.draft_state), room.draft_state);
    if (snapshot.had_draft) {
      room.draft_state = restored;
      room.draft_owner = snapshot.owner;
      room.draft_turn_complete = snapshot.turn_complete;
    } else {
      // Keep a private revision even when Undo returns to the published position.
      // A stale command from before the action/Undo pair must not become valid again.
      room.draft_state = restored;
      room.draft_owner = seat;
      room.draft_turn_complete = false;
    }
    room.draft_revision = Math.max(room.draft_revision, room.revision) + 1;
    room.updated_at = this.now().toISOString();
    this.persist();
    return this.view(room.code, token);
  }

  pass(code, token) {
    const room = this.get(code);
    if (room.status !== "ACTIVE") roomFail("MATCH_NOT_ACTIVE", "The online match is not active", 409);
    const seat = identifySeat(room, token);
    const owner = room.draft_state?.current_actor ?? room.committed_state.current_actor;
    if (!seat || seat !== owner) roomFail("NOT_YOUR_TURN", `It is ${owner}'s turn`, 409);
    let finalState = room.draft_state ?? room.committed_state;
    if (!room.draft_turn_complete && finalState.status !== "COMPLETE") {
      const type = finalState.phase_notice ? "ACKNOWLEDGE_PHASE_NOTICE" : "PASS_PHASE";
      const result = dispatch(finalState, { type, player: seat });
      if (!result.ok) roomFail(result.error.code, result.error.message, 409);
      finalState = result.state;
    }
    this.commit(room, upgradeToV15(finalState));
    return this.view(room.code, token);
  }

  recover(code, { recoveryCode, token = newToken() }) {
    const room = this.get(code);
    const seat = room.seat_order.find((seat) => room.seats[seat]?.recovery_hash === tokenHash(recoveryCode));
    if (!seat) roomFail("RECOVERY_DENIED", "The recovery code does not match a seat", 403);
    room.seats[seat].token_hash = tokenHash(token);
    // Normal recovery preserves the recovery verifier and host/seat identity.
    this.persist();
    return { code: room.code, token, seat, view: this.view(code, token) };
  }

  commit(room, finalState) {
    room.committed_state = finalState;
    room.draft_state = null;
    room.draft_owner = null;
    room.draft_history = [];
    room.draft_turn_complete = false;
    room.revision = Math.max(room.revision, room.draft_revision) + 1;
    room.draft_revision = room.revision;
    room.status = finalState.status === "COMPLETE" ? "COMPLETE" : "ACTIVE";
    if (room.status === "COMPLETE") room.ended_at ??= this.now().toISOString();
    room.updated_at = this.now().toISOString();
    this.persist();
  }
}

// The synchronous reducer must never retain an unaccepted mutation after an error.
// PersistentRooms stages this reducer inside a database transaction for online use.
for (const method of ["create", "join", "start", "command", "undo", "pass", "recover"]) {
  const original = RoomStore.prototype[method];
  RoomStore.prototype[method] = function (...args) {
    const before = deepClone(this.rooms);
    try { return original.apply(this, args); }
    catch (error) { this.rooms = before; throw error; }
  };
}
