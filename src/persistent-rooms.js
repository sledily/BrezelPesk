import { createHash } from 'node:crypto';
import { RoomStore, RoomError, tokenHash, identifySeat, cloneForStorage } from './rooms.js';
import { formatChronicle } from './notation.js';
import { validateInvariants } from './rules.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, status = 400) => { throw new RoomError(code, message, status); };
const codeOf = code => {
  const value = String(code).toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(value)) fail('INVALID_ROOM_CODE', 'Enter a valid room code');
  return value;
};
function secret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) fail('INVALID_CREDENTIAL', 'A fresh random credential is required');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(value)) fail('REQUEST_ID_REQUIRED', 'A unique request identity is required');
  return value;
}
function makeCode(key) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(Buffer.from(hash(key), 'hex').subarray(0,6), value => alphabet[value & 31]).join('');
}
export function gameRecord(room) {
  return { file_type: 'DENDARV_GAME_RECORD', schema_version: 2, code: room.code, status: room.status,
    name: room.name ?? `Game ${room.code}`,
    ended_at: room.ended_at ?? null,
    seats: Object.fromEntries(room.seat_order.map(seat => [seat, { name: room.seats[seat]?.name }])),
    state: room.draft_state ?? room.committed_state, published_state: room.committed_state };
}

export class PersistentRooms {
  constructor(storage, { now = () => new Date() } = {}) {
    this.storage = storage; this.now = now; this.paused = false;
    this.presence = new Map(); this.spectators = new Map(); this.archiveFailures = new Map();
    this.cache = new Map();
  }
  reducer(data) {
    const core = new RoomStore({ now: this.now });
    if (data) {
      if (data.room.schema_version !== 2 || !data.receipts || !Array.isArray(data.audit)) throw new Error('Unsupported room storage schema');
      for (const state of [data.room.committed_state, data.room.draft_state]) {
        if (state && validateInvariants(state).length) throw new Error('Stored game invariant failure');
      }
      core.rooms[data.room.code] = structuredClone(data.room);
    }
    core.spectators = this.spectators;
    return core;
  }
  project(data, token, spectatorId) {
    const core = this.reducer(data), room = core.get(data.room.code);
    const seat = identifySeat(room, token);
    if (seat) this.presence.set(`${room.code}:${seat}`, this.now().toISOString());
    for (const s of room.seat_order) if (room.seats[s]) room.seats[s].last_seen_at = this.presence.get(`${room.code}:${s}`);
    const result = core.view(room.code, token, spectatorId);
    result.viewer.saving_paused = this.paused;
    return result;
  }
  async view(code, token, spectatorId) {
    code = codeOf(code);
    let data;
    if (this.storage.snapshot) {
      const cached = this.cache.get(code);
      const current = await this.storage.snapshot(code, cached?.version ?? null);
      if (current) {
        data = current.data ?? cached?.data;
        this.cache.set(code, { version: current.version, data });
      } else this.cache.delete(code);
    } else data = await this.storage.read(code);
    if (!data) fail('ROOM_NOT_FOUND', 'No online room has that code', 404);
    return this.project(data, token, spectatorId);
  }
  async summary(code, token) {
    // Listing remembered games must not announce presence or fetch private game
    // contents into the browser merely to render a link.
    const data = await this.storage.read(codeOf(code));
    if (!data) fail('ROOM_NOT_FOUND', 'No online room has that code', 404);
    const view = this.reducer(data).view(data.room.code, token);
    return { code: view.room.code, name: view.room.name, status: view.room.status,
      players: Object.entries(view.room.seats).filter(([, p]) => p).map(([seat, p]) => ({ seat, name: p.name })),
      ...view.room.summary, seat: view.viewer.seat,
      is_your_turn: view.viewer.is_your_turn, needs_recovery: view.viewer.role !== 'PLAYER' };
  }
  async mutate(action, code, token, body = {}, id) {
    requestId(id);
    const credentials = body.credentials;
    if (['create','join'].includes(action)) { secret(credentials?.token); secret(credentials?.recoveryCode); }
    if (action === 'recover') { secret(body.recoveryCode); secret(body.token); }
    const principal = ['create','join'].includes(action) ? credentials.token : action === 'recover' ? body.recoveryCode : token;
    secret(principal);
    const receiptId = hash([tokenHash(principal), id]);
    const fingerprint = hash([action, code, body]);
    code = action === 'create' ? makeCode([credentials.token, id]) : codeOf(code);
    try {
      const result = await this.storage.transact(code, async stored => {
        let data = stored ? structuredClone(stored) : null;
        if (!data && action !== 'create') fail('ROOM_NOT_FOUND', 'No online room has that code', 404);
        const core = this.reducer(data);
        // Revalidate current control BEFORE replaying an earlier receipt.
        if (data && !['create','join','recover'].includes(action) && !identifySeat(data.room, token)) {
          fail('SESSION_REPLACED', 'This seat is controlled by another session. Recover it to take control.', 403);
        }
        if (data && action === 'recover' && !data.room.seat_order.some(s => data.room.seats[s]?.recovery_hash === tokenHash(body.recoveryCode))) {
          fail('RECOVERY_DENIED', 'The recovery code does not match a seat', 403);
        }
        const old = data?.receipts[receiptId];
        if (old && old.fingerprint !== fingerprint) fail('REQUEST_REUSED', 'A request identity cannot be reused for different data', 409);
        if (!old) {
          if (action !== 'create' && !['join','recover'].includes(action)) {
            const view = core.view(code, token);
            if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== view.viewer.private_revision) {
              fail('STALE_VIEW', 'The game changed. Refresh before acting.', 409);
            }
          }
          if (action === 'create') {
            if (data) fail('ROOM_CODE_COLLISION', 'Please create the room again with a fresh request', 409);
            core.codeFactory = () => code;
            core.create({ ...body, seed: undefined }); // online outcomes are never seeded by a player
          } else if (action === 'join') core.join(code, body);
          else if (action === 'recover') core.recover(code, body);
          else if (action === 'command') core.command(code, token, body.command);
          else if (action === 'abandon') {
            const room = core.get(code);
            if (identifySeat(room, token) !== room.host_seat) fail('HOST_REQUIRED','Only the host or administrator may abandon a game',403);
            if (body.confirmed !== true || room.status !== 'ACTIVE') fail('CONFIRM_REQUIRED','Confirm abandonment of a started game',409);
            room.status = 'ABANDONED'; room.ended_at = this.now().toISOString(); room.revision += 1;
          }
          else if (action === 'rename') core.rename(code, token, body);
          else if (['start','undo','pass'].includes(action)) core[action](code, token);
          else fail('UNKNOWN_ACTION', 'Unknown room action', 404);
          const room = cloneForStorage(core.get(code));
          data ??= { room, receipts: {}, archive: null, audit: [] };
          data.room = room;
          if (action === 'abandon') data.audit.push({ action: 'ABANDON', actor: 'HOST', at: room.ended_at });
          data.receipts[receiptId] = { fingerprint, accepted_at: this.now().toISOString() };
          if (['COMPLETE','ABANDONED'].includes(room.status) && !data.archive) {
            data.archive = { status: 'pending', record: gameRecord(room), attempts: 0, next_attempt: 0 };
          }
        }
        let responseToken = token;
        if (['create','join'].includes(action)) responseToken = credentials.token;
        if (action === 'recover') responseToken = body.token;
        // A lost recovery response may be retried, but never restores a superseded session.
        if (!identifySeat(data.room, responseToken)) fail('SESSION_REPLACED', 'This session has been replaced; recover the seat again', 403);
        const view = this.project(data, responseToken);
        const result = ['create','join','recover'].includes(action)
          ? { code, token: responseToken, recoveryCode: credentials?.recoveryCode ?? body.recoveryCode,
              seat: view.viewer.seat, view }
          : view;
        return { write: old ? null : data, result };
      });
      this.paused = false;
      this.cache.delete(code);
      (result.view ?? result).viewer.saving_paused = false;
      return result;
    } catch (error) {
      if (error instanceof RoomError) { if (error.code === 'STORAGE_CAPACITY' && action !== 'create') this.paused = true; throw error; }
      this.paused = true;
      throw new RoomError('SAVE_UNAVAILABLE', 'Saving is unavailable. The request may have been saved; retry the same request after reconnecting.', 503);
    }
  }
  async export(code, token) {
    const data = await this.storage.read(codeOf(code));
    if (!data) fail('ROOM_NOT_FOUND','No online room has that code',404);
    if (!identifySeat(data.room, token)) fail('PARTICIPANT_REQUIRED','An authenticated participant is required',403);
    this.project(data, token); // includes terminal access expiry
    return gameRecord(data.room);
  }
  async admin(code, action, body = {}) {
    code = codeOf(code);
    if (action === 'inspect') {
      const data = await this.storage.read(code);
      if (!data) fail('ROOM_NOT_FOUND','No online room has that code',404);
      return { record: gameRecord(data.room), audit: data.audit, archive: data.archive,
        archive_failure: this.archiveFailures.get(code) ?? null };
    }
    requestId(body.requestId);
    return this.storage.transact(code, async stored => {
      if (!stored) fail('ROOM_NOT_FOUND','No online room has that code',404);
      if (body.confirmed !== true) fail('CONFIRM_REQUIRED','Explicit confirmation is required',409);
      const next = structuredClone(stored), receipt = `admin:${body.requestId}`;
      const fingerprint = hash([action, body]);
      if (next.receipts[receipt]) {
        if (next.receipts[receipt].fingerprint !== fingerprint) fail('REQUEST_REUSED','Request identity was reused',409);
        return { result: { ok: true } };
      }
      if (action === 'recover') {
        if (!next.room.seats[body.seat]) fail('INVALID_SEAT','No participant occupies this seat');
        secret(body.token); secret(body.recoveryCode);
        next.room.seats[body.seat].token_hash = tokenHash(body.token);
        next.room.seats[body.seat].recovery_hash = tokenHash(body.recoveryCode);
      } else if (action === 'abandon') {
        if (next.room.status !== 'ACTIVE') fail('MATCH_NOT_ACTIVE','Only a started unfinished game can be abandoned',409);
        next.room.status = 'ABANDONED'; next.room.ended_at = this.now().toISOString(); next.room.revision += 1;
        next.archive = { status: 'pending', record: gameRecord(next.room), attempts: 0, next_attempt: 0 };
      } else fail('UNKNOWN_ACTION','Unsupported administrator action',404);
      next.audit.push({ action: action.toUpperCase(), actor: 'ADMIN', seat: body.seat ?? null, at: this.now().toISOString() });
      next.receipts[receipt] = { fingerprint };
      return { write: next, result: { ok: true } };
    });
  }
  async processArchives() {
    // Durable per-record status; one failure never blocks later games. No paid worker needed.
    const rows = await this.storage.pendingArchives();
    let pending = false;
    for (const row of rows) {
      try {
        await this.storage.transact(row.code, async current => {
          const archive = current?.archive;
          if (archive?.status !== 'pending') return { result: null };
          if (archive.next_attempt > this.now().getTime()) { pending = true; return { result: null }; }
          const next = structuredClone(current);
          try {
            next.archive.text = formatChronicle(archive.record.state);
            next.archive.status = 'ready';
            next.archive.completed_at = this.now().toISOString();
          } catch {
            pending = true;
            next.archive.attempts += 1;
            next.archive.next_attempt = this.now().getTime() + Math.min(3600000, 1000 * 2 ** Math.min(next.archive.attempts,12));
          }
          return { write: next, result: null };
        });
        this.archiveFailures.delete(row.code);
      } catch { pending = true; this.archiveFailures.set(row.code, this.now().toISOString()); }
    }
    return pending;
  }
}
