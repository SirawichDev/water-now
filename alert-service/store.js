// One async interface over the service's database: SQLite (node:sqlite) for a
// local run, Postgres when DATABASE_URL is set (Vercel). Statements are
// written in the subset both accept: `?` placeholders, ON CONFLICT upserts,
// BIGINT for millisecond times and DOUBLE PRECISION for coordinates.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** `?` → `$1, $2, …` for Postgres. No statement here has `?` in a literal. */
export function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/** Tables shared by every module. Per-module tables are created there. */
const SCHEMA = (pg) => `
  CREATE TABLE IF NOT EXISTS subscribers (
    chat_id    TEXT PRIMARY KEY,
    lat        DOUBLE PRECISION,
    lon        DOUBLE PRECISION,
    radius_m   BIGINT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS keywords (
    chat_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    PRIMARY KEY (chat_id, keyword)
  );
  CREATE TABLE IF NOT EXISTS geocache (
    query      TEXT PRIMARY KEY,
    lat        DOUBLE PRECISION,
    lon        DOUBLE PRECISION,
    display    TEXT,
    fetched_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sent (
    key     TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sent_at BIGINT NOT NULL,
    PRIMARY KEY (key, chat_id)
  );
  CREATE TABLE IF NOT EXISTS water_state (
    station_id  TEXT PRIMARY KEY,
    level       INTEGER,
    observed_at BIGINT
  );
  CREATE TABLE IF NOT EXISTS outages (
    id         TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    first_seen BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS news (
    video_id   TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    first_seen BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id         ${pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    level      TEXT NOT NULL,
    sender     TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'depth',
    batch      TEXT
  );
  CREATE TABLE IF NOT EXISTS places_cache (
    key        TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS water_hourly (
    station_id TEXT NOT NULL,
    t          BIGINT NOT NULL,
    percent    DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (station_id, t)
  );
  CREATE TABLE IF NOT EXISTS water_backfill (
    station_id TEXT PRIMARY KEY,
    at         BIGINT NOT NULL
  );
  -- The latest result of each poll, so any process can serve it.
  CREATE TABLE IF NOT EXISTS snapshots (
    kind       TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  -- Who is running a poll, so two invocations never run the same one.
  CREATE TABLE IF NOT EXISTS locks (
    name  TEXT PRIMARY KEY,
    until BIGINT NOT NULL
  );
`;

function sqliteStore(path) {
  // Imported lazily: node:sqlite is not needed (or wanted) on Vercel.
  return import('node:sqlite').then(({ DatabaseSync }) => {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL;');
    const stmts = new Map();
    const prep = (sql) => {
      let s = stmts.get(sql);
      if (!s) stmts.set(sql, (s = db.prepare(sql)));
      return s;
    };
    const store = {
      kind: 'sqlite',
      raw: db,
      async get(sql, ...p) {
        return prep(sql).get(...p);
      },
      async all(sql, ...p) {
        return prep(sql).all(...p);
      },
      async run(sql, ...p) {
        const info = prep(sql).run(...p);
        return { changes: Number(info.changes) };
      },
      async exec(sql) {
        db.exec(sql);
      },
      /** Run `fn(tx)` in one transaction; `tx` has the same methods. */
      async tx(fn) {
        db.exec('BEGIN');
        try {
          const out = await fn(store);
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
      async close() {
        db.close();
      },
    };
    return store;
  });
}

async function pgStore(url) {
  const { default: pg } = await import('pg');
  // BIGINT and NUMERIC arrive as strings by default; every value here fits a
  // JS number (millisecond times, counts).
  pg.types.setTypeParser(20, Number);
  pg.types.setTypeParser(1700, Number);
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
  });
  const on = (client) => ({
    kind: 'pg',
    async get(sql, ...p) {
      return (await client.query(toPg(sql), p)).rows[0];
    },
    async all(sql, ...p) {
      return (await client.query(toPg(sql), p)).rows;
    },
    async run(sql, ...p) {
      const r = await client.query(toPg(sql), p);
      return { changes: r.rowCount ?? 0, rows: r.rows };
    },
    async exec(sql) {
      await client.query(sql);
    },
  });
  const store = {
    ...on(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(on(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return store;
}

/**
 * Open the database and create every shared table.
 * @param {{ url?: string, path?: string }} opts  Postgres URL, else SQLite path
 */
export async function openStore({ url, path } = {}) {
  const store = url ? await pgStore(url) : await sqliteStore(path);
  if (store.kind === 'sqlite') {
    // Databases from before trash, food and hail reports: add the columns.
    const columns = new Set(
      (await store.all('PRAGMA table_info(reports)')).map((c) => c.name),
    );
    if (columns.size && !columns.has('kind'))
      await store.exec(
        "ALTER TABLE reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'depth'",
      );
    if (columns.size && !columns.has('batch'))
      await store.exec('ALTER TABLE reports ADD COLUMN batch TEXT');
  }
  await store.exec(SCHEMA(store.kind === 'pg'));
  return store;
}

/** The latest saved result of a poll ("water", "news", …), or null. */
export async function loadSnapshot(store, kind) {
  const row = await store.get(
    'SELECT json, updated_at FROM snapshots WHERE kind = ?',
    kind,
  );
  return row ? { ...JSON.parse(row.json), savedAt: row.updated_at } : null;
}

export async function saveSnapshot(store, kind, value, at = Date.now()) {
  await store.run(
    'INSERT INTO snapshots (kind, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (kind) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    kind,
    JSON.stringify(value),
    at,
  );
}

/** When each snapshot last changed: what browsers poll for. */
export async function snapshotTimes(store) {
  const rows = await store.all('SELECT kind, updated_at FROM snapshots');
  return Object.fromEntries(rows.map((r) => [r.kind, r.updated_at]));
}

/**
 * Take a named lock for `ms` unless someone else holds it. Returns true when
 * this caller got it. Expired locks are taken over.
 */
export async function tryLock(store, name, ms, now = Date.now()) {
  const r = await store.run(
    'INSERT INTO locks (name, until) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET until = excluded.until WHERE locks.until < ?',
    name,
    now + ms,
    now,
  );
  return r.changes > 0;
}

export async function unlock(store, name) {
  await store.run('DELETE FROM locks WHERE name = ?', name);
}
