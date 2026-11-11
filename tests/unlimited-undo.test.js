import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore, cloneForStorage } from '../src/rooms.js';
import { PersistentRooms } from '../src/persistent-rooms.js';
import { FileRoomStorage, PostgresRoomStorage } from '../src/room-storage.js';
import { newMatch, dispatch } from '../src/engine.js';
import { gameUndoStep } from '../src/history.js';
import { stockpileInstructions, validateInvariants } from '../src/rules.js';
import { PHASE } from '../src/constants.js';
import { publishedUndoFixture } from '../test-support/published-undo.js';

const id = () => randomBytes(24).toString('hex');
const limits = { maxGames: 5, totalBytes: 32 * 1024 * 1024, reserveBytes: 1024 * 1024 };
function timeline(state) {
  const creation = state.event_log.find(event => event.type === 'MatchCreated');
  let replay = newMatch({ seed: state.seed, matchId: state.match_id,
    rules: creation.payload.rules, playerCount: creation.payload.player_count });
  const states = [replay];
  for (const command of state.command_log) {
    const result = dispatch(replay, command); assert.equal(result.ok, true);
    replay = result.state; states.push(replay);
  }
  assert.deepEqual(replay, state);
  return states;
}

for (const count of [2, 4]) test(`${count} players: any seated player can rewind an existing save all the way through other turns and draws to setup`, () => {
  const f = publishedUndoFixture(count), code = f.host.code;
  const original = cloneForStorage(f.core.get(code));
  const states = timeline(original.committed_state);
  let core = new RoomStore(); core.rooms[code] = JSON.parse(JSON.stringify(original));
  const seats = Object.keys(f.players);
  for (let index = states.length - 2; index >= 0; index -= 1) {
    const actor = seats[index % seats.length], before = core.get(code).revision;
    assert.equal(core.view(code, f.players[actor].token).viewer.can_undo_game, true);
    core.undo(code, f.players[actor].token, { unlimited: true });
    assert.deepEqual(core.get(code).committed_state, states[index]);
    assert.deepEqual(validateInvariants(core.get(code).committed_state), []);
    assert.ok(core.get(code).revision > before);
    const stored = cloneForStorage(core.get(code));
    assert.deepEqual(stored.seats, original.seats);
    core = new RoomStore(); core.rooms[code] = JSON.parse(JSON.stringify(stored));
  }
  assert.equal(core.view(code, f.host.token).viewer.can_undo_game, false);
  assert.equal(core.get(code).committed_state.status, 'SETUP');
  assert.throws(() => core.undo(code, f.host.token, { unlimited: true }), e => e.code === 'NOTHING_TO_UNDO');
});

test('unlimited Undo can rewind Recruit, a season transition and an already revealed Noble', () => {
  const f = publishedUndoFixture(2, { phase: PHASE.RECRUIT }), code = f.host.code;
  const other = f.players.BLACK.token;
  f.core.undo(code, other, { unlimited: true });
  assert.deepEqual(f.core.get(code).committed_state, f.beforePass);
  f.core.undo(code, other, { unlimited: true });
  assert.deepEqual(f.core.get(code).committed_state, f.beforeMove);
  f.core.undo(code, other, { unlimited: true });
  assert.deepEqual(f.core.get(code).committed_state, f.beforeTap);
});

function battleFixture() {
  const f = publishedUndoFixture(2, { seed: 'unlimited-combat-6' }), code = f.host.code;
  let state = f.core.get(code).committed_state;
  const cards = state.players.BLACK.resource_hand_ids.filter(id => state.resources_by_id[id].suit === 'SPADES');
  f.core.command(code, f.players.BLACK.token, { type: 'TAP_RESOURCES', card_ids: cards });
  for (const destination of ['f6', 'd4']) f.core.command(code, f.players.BLACK.token,
    { type: 'MOBILIZE_UNIT', unit_id: 'U-B-001', destination });
  f.core.pass(code, f.players.BLACK.token);
  state = f.core.get(code).committed_state;
  assert.equal(state.phase, PHASE.SIEGE); assert.equal(state.current_actor, 'WHITE');
  const before = structuredClone(state);
  const command = { type: 'LAY_SIEGE', attacker_id: 'U-W-001', defender_id: 'U-B-001' };
  f.core.command(code, f.host.token, command);
  return { ...f, beforeBattle: before, battleCommand: command };
}

test('Undo can reverse combat and victory; replaying the same attack retains the exact recorded rolls', () => {
  const f = battleFixture(), code = f.host.code;
  const outcome = structuredClone(f.core.get(code).committed_state);
  assert.equal(f.core.get(code).status, 'COMPLETE');
  f.core.undo(code, f.players.BLACK.token, { unlimited: true });
  assert.equal(f.core.get(code).status, 'ACTIVE'); assert.equal(f.core.get(code).ended_at, undefined);
  assert.deepEqual(f.core.get(code).committed_state, f.beforeBattle);
  f.core.command(code, f.host.token, f.battleCommand);
  assert.deepEqual(f.core.get(code).committed_state, outcome);
});

test('rewinding another player’s unfinished turn does not publish private actions or Court identities', () => {
  const f = publishedUndoFixture(2, { publish: false }), code = f.host.code;
  const published = structuredClone(f.core.get(code).committed_state);
  f.core.undo(code, f.players.BLACK.token, { unlimited: true });
  assert.deepEqual(f.core.get(code).committed_state, published);
  assert.deepEqual(f.core.get(code).draft_state, f.beforeMove);
  assert.equal(f.core.get(code).draft_owner, 'WHITE');
  const other = f.core.view(code, f.players.BLACK.token);
  assert.equal(other.game.units_by_id['U-W-001'].square, published.units_by_id['U-W-001'].square);
  assert.equal(other.game.command_log, undefined); assert.equal(other.game.seed, undefined);
  f.core.undo(code, f.players.BLACK.token, { unlimited: true });
  assert.equal(f.core.get(code).draft_state, null);
  assert.deepEqual(f.core.get(code).committed_state, published);
});

test('shared Stockpile planning rewinds in both copies while another player’s draft stays private', () => {
  const f = publishedUndoFixture(2, { publish: false }), code = f.host.code;
  const room = f.core.get(code), published = structuredClone(room.committed_state), draft = structuredClone(room.draft_state);
  const instructions = stockpileInstructions(room.draft_state, 'BLACK');
  instructions.suit_order = [...instructions.suit_order].reverse();
  f.core.command(code, f.players.BLACK.token, { type: 'SET_STOCKPILE_INSTRUCTIONS', instructions });
  f.core.undo(code, f.host.token, { unlimited: true });
  assert.deepEqual(f.core.get(code).committed_state, published);
  assert.deepEqual(f.core.get(code).draft_state, draft);
});

test('spectators and replaced sessions cannot use game Undo; unverifiable history remains unchanged', () => {
  const f = publishedUndoFixture(), code = f.host.code;
  assert.equal(f.core.view(code).viewer.can_undo_game, false);
  assert.throws(() => f.core.undo(code, null, { unlimited: true }), e => e.code === 'PLAYER_TOKEN_REQUIRED');
  f.core.get(code).committed_state.units_by_id['U-W-001'].square = 'd4';
  const before = cloneForStorage(f.core.get(code));
  assert.equal(f.core.view(code, f.host.token).viewer.can_undo_game, false);
  assert.throws(() => f.core.undo(code, f.host.token, { unlimited: true }), e => e.code === 'UNDO_HISTORY_UNVERIFIED');
  assert.deepEqual(cloneForStorage(f.core.get(code)), before);
});

async function storage(t, backend) {
  if (backend === 'file') {
    const directory = await mkdtemp(join(tmpdir(), 'dendarv-unlimited-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const db = new FileRoomStorage(directory, limits); await db.init(); return db;
  }
  let pool;
  if (process.env.DENDARV_TEST_DATABASE_URL) {
    const { Pool } = await import('pg'); const schema = 'unlimited_' + randomBytes(12).toString('hex');
    const bootstrap = new Pool({ connectionString: process.env.DENDARV_TEST_DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.DENDARV_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    t.after(async () => { await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); await bootstrap.end(); });
  } else {
    const { PGlite } = await import('@electric-sql/pglite'); const pg = new PGlite(); let tail = Promise.resolve();
    const query = async (sql, params) => sql.includes('CREATE TABLE') ? (await pg.exec(sql)).at(-1) : pg.query(sql, params);
    pool = { query, end: () => pg.close(), connect: async () => {
      const previous = tail; let release; tail = new Promise(r => release = r); await previous;
      return { query, release };
    } };
  }
  const db = new PostgresRoomStorage(pool, limits); await db.init(); t.after(() => db.close()); return db;
}

for (const backend of ['file', 'postgres']) test(`${backend}: unlimited Undo survives failures and retries, and rejects a stale view of someone else's private work`, async t => {
  const db = await storage(t, backend), f = publishedUndoFixture(2, { publish: false }), code = f.host.code;
  await db.transact(code, async () => ({ write: { room: cloneForStorage(f.core.get(code)), receipts: {}, audit: [], archive: null } }));
  let service = new PersistentRooms(db);
  const token = f.players.BLACK.token;
  const view = await service.view(code, token), body = { unlimited: true,
    expectedRevision: view.viewer.private_revision, expectedGameRevision: view.viewer.game_revision }, request = id();
  const before = await db.read(code), transact = db.transact.bind(db);
  db.transact = (code, fn) => transact(code, async data => { await fn(data); throw new Error('injected save failure'); });
  await assert.rejects(() => service.mutate('undo', code, token, body, request), e => e.code === 'SAVE_UNAVAILABLE');
  assert.deepEqual(await db.read(code), before);
  db.transact = async (...args) => { await transact(...args); throw new Error('lost acknowledgement'); };
  await assert.rejects(() => service.mutate('undo', code, token, body, request), e => e.code === 'SAVE_UNAVAILABLE');
  db.transact = transact;
  const accepted = await db.read(code);
  assert.deepEqual(accepted.room.draft_state, f.beforeMove);
  assert.deepEqual(accepted.room.committed_state, before.room.committed_state);
  service = new PersistentRooms(db);
  await service.mutate('undo', code, token, body, request);
  assert.deepEqual(await db.read(code), accepted);
  await assert.rejects(() => service.mutate('undo', code, token, body, id()), e => e.code === 'STALE_VIEW');
  const fresh = await service.view(code, token);
  await service.mutate('undo', code, token, { unlimited: true, expectedRevision: fresh.viewer.private_revision,
    expectedGameRevision: fresh.viewer.game_revision }, id());
  const waiting = await service.view(code, token), white = await service.view(code, f.host.token);
  const state = (await db.read(code)).room.committed_state;
  const cards = state.players.WHITE.resource_hand_ids.filter(id => state.resources_by_id[id].suit === 'SPADES');
  await service.mutate('command', code, f.host.token, { expectedRevision: white.viewer.private_revision,
    command: { type: 'TAP_RESOURCES', card_ids: cards } }, id());
  const privateWork = await db.read(code);
  await assert.rejects(() => service.mutate('undo', code, token, { unlimited: true,
    expectedRevision: waiting.viewer.private_revision, expectedGameRevision: waiting.viewer.game_revision }, id()), e => e.code === 'STALE_VIEW');
  assert.deepEqual(await db.read(code), privateWork);
  await service.mutate('recover', code, null, { recoveryCode: f.players.BLACK.recoveryCode, token: id() }, id());
  await assert.rejects(() => service.mutate('undo', code, token, body, request), e => e.code === 'SESSION_REPLACED');
});

test('Undo reopens a completed game without retaining its obsolete terminal archive', async t => {
  const db = await storage(t, 'file'), f = battleFixture(), code = f.host.code;
  await db.transact(code, async () => ({ write: { room: cloneForStorage(f.core.get(code)), receipts: {}, audit: [],
    archive: { status: 'ready', record: { state: f.core.get(code).committed_state }, text: 'old terminal record' } } }));
  const service = new PersistentRooms(db), view = await service.view(code, f.host.token);
  await service.mutate('undo', code, f.host.token, { unlimited: true,
    expectedRevision: view.viewer.private_revision, expectedGameRevision: view.viewer.game_revision }, id());
  const saved = await db.read(code);
  assert.equal(saved.room.status, 'ACTIVE'); assert.equal(saved.archive, null); assert.equal(saved.room.ended_at, undefined);
  assert.deepEqual(saved.room.committed_state, f.beforeBattle);
  assert.equal((await service.view(code, f.host.token)).terminal_record, null);
});
