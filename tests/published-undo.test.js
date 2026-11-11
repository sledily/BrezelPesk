import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore, cloneForStorage } from '../src/rooms.js';
import { PersistentRooms } from '../src/persistent-rooms.js';
import { FileRoomStorage, PostgresRoomStorage } from '../src/room-storage.js';
import { PHASE, SUIT } from '../src/constants.js';
import { validateInvariants } from '../src/rules.js';
import { publishedUndoFixture } from '../test-support/published-undo.js';

const id = () => randomBytes(24).toString('hex');

for (const count of [2, 4]) test(`${count} players: a pre-patch save can undo a publication, move and tap after restart`, t => {
  const f = publishedUndoFixture(count), code = f.host.code, token = f.host.token;
  const directory = mkdtempSync(join(tmpdir(), 'dendarv-published-undo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'rooms.json');
  const original = cloneForStorage(f.core.get(code));
  assert.equal(original.schema_version, 2);
  assert.equal(original.draft_state, null);
  assert.deepEqual(original.draft_history, []);
  assert.equal(original.last_published_undo, undefined);
  const bytes = JSON.stringify({ schema_version: 2, rooms: { [code]: original } });
  writeFileSync(filePath, bytes);
  let core = new RoomStore({ filePath });
  assert.equal(core.view(code, token).viewer.undo_scope, 'PUBLISHED');
  assert.equal(readFileSync(filePath, 'utf8'), bytes, 'loading and viewing do not migrate or rewrite the save');
  assert.throws(() => core.undo(code, token), e => e.code === 'NOTHING_TO_UNDO', 'old clients cannot take back published work without explicit consent');
  assert.equal(readFileSync(filePath, 'utf8'), bytes);
  let revision = original.revision;
  for (const expected of [f.beforePass, f.beforeMove, f.beforeTap]) {
    const view = core.undo(code, token, { published: true });
    assert.deepEqual(core.get(code).committed_state, expected);
    assert.ok(view.room.revision > revision);
    assert.equal(view.viewer.private_revision, view.room.revision);
    assert.equal(view.room.last_published_undo.actor, 'WHITE');
    revision = view.room.revision;
    assert.deepEqual(validateInvariants(core.get(code).committed_state), []);
    core = new RoomStore({ filePath });
    assert.deepEqual(core.get(code).committed_state, expected);
    assert.deepEqual(cloneForStorage(core.get(code)).seats, original.seats, 'credentials, seats and participant identities survive');
    const spectator = core.view(code);
    assert.equal(spectator.viewer.can_undo, false);
    assert.equal(spectator.game.seed, undefined);
    assert.equal(spectator.game.command_log, undefined);
    assert.equal(spectator.game.rng_state, undefined);
  }
});

test('taking back a season finish preserves the already drawn Noble and reproduces the exact hidden shuffle', () => {
  const f = publishedUndoFixture(2, { phase: PHASE.RECRUIT });
  const before = structuredClone(f.core.get(f.host.code).committed_state);
  assert.notDeepEqual(before.rng_state, f.beforePass.rng_state);
  f.core.undo(f.host.code, f.host.token, { published: true });
  assert.deepEqual(f.core.get(f.host.code).committed_state, f.beforePass);
  assert.equal(f.core.view(f.host.code, f.host.token).viewer.can_undo, false, 'Recruit cannot be undone to try another Noble');
  assert.throws(() => f.core.undo(f.host.code, f.host.token, { published: true }), e => e.code === 'NOTHING_TO_UNDO');
  f.core.pass(f.host.code, f.host.token);
  assert.deepEqual(f.core.get(f.host.code).committed_state, before, 'finishing again changes no card, deck, result or log entry');
});

test('a participant cannot take back someone else’s publication or erase another player’s accepted draft', () => {
  const f = publishedUndoFixture(4), code = f.host.code, room = f.core.get(code);
  const actor = room.committed_state.current_actor;
  assert.notEqual(actor, 'WHITE');
  const before = cloneForStorage(room);
  assert.throws(() => f.core.undo(code, f.players[actor].token, { published: true }), e => e.code === 'NOTHING_TO_UNDO');
  assert.throws(() => f.core.undo(code, null, { published: true }), e => e.code === 'NOTHING_TO_UNDO');
  assert.deepEqual(cloneForStorage(f.core.get(code)), before);
  const cards = room.committed_state.players[actor].resource_hand_ids
    .filter(id => room.committed_state.resources_by_id[id].suit === SUIT.SPADES);
  f.core.command(code, f.players[actor].token, { type: 'TAP_RESOURCES', card_ids: cards });
  const draft = cloneForStorage(f.core.get(code));
  assert.equal(f.core.view(code, f.host.token).viewer.can_undo, false);
  assert.throws(() => f.core.undo(code, f.host.token, { published: true }), e => e.code === 'NOTHING_TO_UNDO');
  assert.deepEqual(cloneForStorage(f.core.get(code)), draft);
});

test('unverifiable old history fails closed without changing a playable saved position', () => {
  const f = publishedUndoFixture(), code = f.host.code;
  f.core.get(code).committed_state.units_by_id['U-W-001'].square = 'd4';
  assert.deepEqual(validateInvariants(f.core.get(code).committed_state), []);
  const before = cloneForStorage(f.core.get(code));
  const view = f.core.view(code, f.host.token);
  assert.equal(view.viewer.can_undo, false);
  assert.match(view.viewer.undo_unavailable_reason, /could not be verified/);
  assert.throws(() => f.core.undo(code, f.host.token, { published: true }), e => e.code === 'PUBLISHED_UNDO_UNVERIFIED');
  assert.deepEqual(cloneForStorage(f.core.get(code)), before);
});

const limits = { maxGames: 5, totalBytes: 32 * 1024 * 1024, reserveBytes: 1024 * 1024 };
async function storage(t, backend) {
  if (backend === 'file') {
    const directory = await mkdtemp(join(tmpdir(), 'dendarv-published-durable-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const db = new FileRoomStorage(directory, limits); await db.init(); return db;
  }
  let pool;
  if (process.env.DENDARV_TEST_DATABASE_URL) {
    const { Pool } = await import('pg');
    const schema = 'published_undo_' + randomBytes(12).toString('hex');
    const bootstrap = new Pool({ connectionString: process.env.DENDARV_TEST_DATABASE_URL });
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: process.env.DENDARV_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    t.after(async () => { await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); await bootstrap.end(); });
  } else {
    const { PGlite } = await import('@electric-sql/pglite'); const pg = new PGlite();
    let tail = Promise.resolve();
    const query = async (sql, params) => sql.includes('CREATE TABLE') ? (await pg.exec(sql)).at(-1) : pg.query(sql, params);
    pool = { query, end: () => pg.close(), connect: async () => {
      const previous = tail; let release; tail = new Promise(r => release = r); await previous;
      return { query, release };
    } };
  }
  const db = new PostgresRoomStorage(pool, limits); await db.init(); t.after(() => db.close()); return db;
}

for (const backend of ['file', 'postgres']) test(`${backend}: publication Undo survives write failure, lost acknowledgement, restart and old publish retries`, async t => {
  const db = await storage(t, backend), f = publishedUndoFixture(), code = f.host.code, token = f.host.token;
  await db.transact(code, async () => ({ write: { room: f.unpublished, receipts: {}, audit: [], archive: null } }));
  let service = new PersistentRooms(db);
  const view = await service.view(code, token);
  const publishId = id(), publishBody = { expectedRevision: view.viewer.private_revision };
  const published = await service.mutate('pass', code, token, publishBody, publishId);
  const before = await db.read(code);
  const undoId = id(), body = { published: true, expectedRevision: published.viewer.private_revision };
  const transact = db.transact.bind(db);
  db.transact = (code, fn) => transact(code, async data => { await fn(data); throw new Error('injected save failure'); });
  await assert.rejects(() => service.mutate('undo', code, token, body, undoId), e => e.code === 'SAVE_UNAVAILABLE');
  assert.deepEqual(await db.read(code), before);
  db.transact = async (...args) => { await transact(...args); throw new Error('lost COMMIT acknowledgement'); };
  await assert.rejects(() => service.mutate('undo', code, token, body, undoId), e => e.code === 'SAVE_UNAVAILABLE');
  db.transact = transact;
  const accepted = await db.read(code);
  assert.deepEqual(accepted.room.committed_state, f.beforePass);
  assert.equal(accepted.audit.filter(e => e.action === 'UNDO_PUBLICATION').length, 1);
  service = new PersistentRooms(db);
  await service.mutate('undo', code, token, body, undoId);
  await service.mutate('pass', code, token, publishBody, publishId);
  assert.deepEqual(await db.read(code), accepted, 'old request receipts cannot reapply or undo a step twice');
  await assert.rejects(() => service.mutate('undo', code, token, body, id()), e => e.code === 'STALE_VIEW');
  assert.deepEqual(await db.read(code), accepted);

  // Both clients may have read the same revision. Only one incompatible action wins.
  const now = await service.view(code, token);
  const again = await service.mutate('pass', code, token, { expectedRevision: now.viewer.private_revision }, id());
  const actor = (await db.read(code)).room.committed_state.current_actor;
  const otherToken = f.players[actor].token;
  const other = await service.view(code, otherToken);
  const cards = other.game.players[actor].resource_hand_ids
    .filter(id => other.game.resources_by_id[id].suit === SUIT.SPADES);
  const outcomes = await Promise.allSettled([
    service.mutate('command', code, otherToken, { expectedRevision: other.viewer.private_revision,
      command: { type: 'TAP_RESOURCES', card_ids: cards } }, id()),
    new PersistentRooms(db).mutate('undo', code, token, { published: true, expectedRevision: again.viewer.private_revision }, id()),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const stored = await db.read(code);
  assert.deepEqual(validateInvariants(stored.room.draft_state ?? stored.room.committed_state), []);
  if (stored.room.draft_state) {
    assert.equal(stored.room.draft_owner, actor);
    assert.deepEqual(stored.room.committed_state, before.room.committed_state);
  } else assert.deepEqual(stored.room.committed_state, f.beforePass);
});
