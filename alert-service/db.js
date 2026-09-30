import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id    TEXT PRIMARY KEY,
      lat        REAL,
      lon        REAL,
      radius_m   INTEGER NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keywords (
      chat_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      PRIMARY KEY (chat_id, keyword)
    );
    CREATE TABLE IF NOT EXISTS geocache (
      query      TEXT PRIMARY KEY,
      lat        REAL,
      lon        REAL,
      display    TEXT,
      fetched_at INTEGER NOT NULL
    );
    -- One row per (alert, recipient): the dedupe that stops repeat pings.
    CREATE TABLE IF NOT EXISTS sent (
      key     TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (key, chat_id)
    );
    CREATE TABLE IF NOT EXISTS water_state (
      station_id  TEXT PRIMARY KEY,
      level       INTEGER,
      observed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS outages (
      id         TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      first_seen INTEGER NOT NULL
    );
  `);
  return db;
}
