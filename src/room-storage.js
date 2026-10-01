import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { RoomError } from './rooms.js';

export const defaultLimits = { maxGames: 5, totalBytes: 64 * 1024 * 1024, reserveBytes: 8 * 1024 * 1024 };
export function validateLimits(limits) {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid storage limit: ${key}`);
  }
  if (limits.reserveBytes > limits.totalBytes) throw new Error('A game reservation exceeds the storage budget');
  return limits;
}
export function allocatedBytes(data, limits) {
  const bytes = Buffer.byteLength(JSON.stringify(data));
  // Do not release a terminal game's reserve before the archive text is saved.
  const archiveReady = ['COMPLETE', 'ABANDONED'].includes(data.room.status) && data.archive?.status === 'ready';
  return archiveReady ? bytes : Math.max(bytes, limits.reserveBytes);
}
function checkCapacity(inventory, code, data, limits) {
  const others = inventory.filter(row => row.code !== code);
  if (others.length + 1 > limits.maxGames || others.reduce((n, row) => n + Number(row.bytes), 0) + allocatedBytes(data, limits) > limits.totalBytes) {
    throw new RoomError('STORAGE_CAPACITY', 'Game storage is full. No new state was accepted. Ask the administrator to review capacity.', 507);
  }
}

// Development fallback only: one writer process, atomic per-room files. Never use on ephemeral hosting.
export class FileRoomStorage {
  constructor(directory, limits = defaultLimits) {
    this.directory = directory; this.limits = validateLimits(limits); this.tail = Promise.resolve();
  }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  async read(code) {
    try { return JSON.parse(await readFile(join(this.directory, `${code}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async inventory() {
    const { readdir } = await import('node:fs/promises');
    const rows = [];
    for (const file of await readdir(this.directory)) {
      if (!/^[A-Z2-9]{6}\.json$/.test(file)) continue;
      const code = file.slice(0, -5), data = await this.read(code);
      rows.push({ code, bytes: allocatedBytes(data, this.limits) });
    }
    return rows;
  }
  async transact(code, fn) {
    const task = this.tail.then(async () => {
      const data = await this.read(code);
      const change = await fn(data);
      if (!change.write) return change.result;
      checkCapacity(await this.inventory(), code, change.write, this.limits);
      const temporary = join(this.directory, `${code}.tmp`);
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(change.write)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, `${code}.json`));
      const dir = await open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      return change.result;
    });
    this.tail = task.catch(() => {}); return task;
  }
  async pendingArchives() {
    const rows = await this.inventory(), pending = [];
    for (const row of rows) if ((await this.read(row.code)).archive?.status === 'pending') pending.push(row);
    return pending;
  }
  async close() { await this.tail; }
}

export const schemaSQL = `
CREATE TABLE IF NOT EXISTS dendarv_capacity (
  id integer PRIMARY KEY CHECK (id=1), max_games integer NOT NULL,
  total_bytes bigint NOT NULL, reserve_bytes bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS dendarv_rooms (
  code text PRIMARY KEY, data jsonb NOT NULL, allocated_bytes bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1
);`;

export class PostgresRoomStorage {
  constructor(pool, limits = defaultLimits) { this.pool = pool; this.limits = validateLimits(limits); }
  async init() {
    await this.pool.query(schemaSQL);
    const l = this.limits;
    await this.pool.query('INSERT INTO dendarv_capacity VALUES (1,$1,$2,$3) ON CONFLICT DO NOTHING', [l.maxGames,l.totalBytes,l.reserveBytes]);
    const { rows } = await this.pool.query('SELECT * FROM dendarv_capacity WHERE id=1');
    const stored = rows[0];
    if (+stored.max_games !== l.maxGames || +stored.total_bytes !== l.totalBytes || +stored.reserve_bytes !== l.reserveBytes) {
      throw new Error('Storage limits differ from the database. Review/update the capacity row deliberately before changing configuration.');
    }
  }
  async read(code) { return (await this.pool.query('SELECT data FROM dendarv_rooms WHERE code=$1', [code])).rows[0]?.data ?? null; }
  async snapshot(code, version = null) {
    return (await this.pool.query('SELECT version, CASE WHEN version=$2 THEN NULL ELSE data END AS data FROM dendarv_rooms WHERE code=$1', [code, version])).rows[0] ?? null;
  }
  async inventory() { return (await this.pool.query('SELECT code, allocated_bytes AS bytes FROM dendarv_rooms')).rows; }
  async transact(code, fn) {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      // Very small V2 workload: this short global lock protects admission and storage accounting
      // across all application processes. Only the changed room is written.
      await client.query('SELECT id FROM dendarv_capacity WHERE id=1 FOR UPDATE');
      const current = (await client.query('SELECT data FROM dendarv_rooms WHERE code=$1 FOR UPDATE', [code])).rows[0]?.data ?? null;
      const change = await fn(current);
      if (change.write) {
        const inventory = (await client.query('SELECT code, allocated_bytes AS bytes FROM dendarv_rooms')).rows;
        checkCapacity(inventory, code, change.write, this.limits);
        const physical = Number((await client.query('SELECT pg_database_size(current_database()) AS bytes')).rows[0].bytes);
        if (physical + allocatedBytes(change.write, this.limits) > this.limits.totalBytes * 4) {
          throw new RoomError('STORAGE_CAPACITY','Database storage needs administrator attention; no new state was accepted',507);
        }
        await client.query(`INSERT INTO dendarv_rooms(code,data,allocated_bytes) VALUES ($1,$2,$3)
          ON CONFLICT(code) DO UPDATE SET data=EXCLUDED.data, allocated_bytes=EXCLUDED.allocated_bytes, version=dendarv_rooms.version+1`,
          [code, JSON.stringify(change.write), allocatedBytes(change.write,this.limits)]);
      }
      await client.query('COMMIT');
      return change.result;
    } catch (error) {
      // COMMIT errors can have an unknown outcome. The caller retries the SAME receipt identity,
      // after storage is reachable again, instead of exposing or regenerating a random result.
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  async pendingArchives() { return (await this.pool.query("SELECT code FROM dendarv_rooms WHERE data->'archive'->>'status'='pending'")).rows; }
  async close() { await this.pool.end(); }
}

export async function openRoomStorage(env = process.env) {
  const limits = validateLimits({
    maxGames: Number(env.DENDARV_MAX_GAMES ?? defaultLimits.maxGames),
    totalBytes: Number(env.DENDARV_STORAGE_BUDGET_BYTES ?? defaultLimits.totalBytes),
    reserveBytes: Number(env.DENDARV_GAME_RESERVE_BYTES ?? defaultLimits.reserveBytes),
  });
  let storage;
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const url = new URL(env.DATABASE_URL);
    if ((env.NODE_ENV === 'production' || env.RENDER) && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.delete('uselibpqcompat');
    }
    storage = new PostgresRoomStorage(new Pool({ connectionString: url.toString(),
      max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 }), limits);
  } else {
    if (env.NODE_ENV === 'production' || env.RENDER) throw new Error('Hosted online play requires DATABASE_URL; ephemeral file saves are disabled');
    storage = new FileRoomStorage(env.DENDARV_DATA_DIR ?? '.dendarv-data/v2', limits);
  }
  await storage.init(); return storage;
}
