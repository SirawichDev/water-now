// Hourly water history behind the map's 72-hour replay. ThaiWater only serves
// history one station at a time, so the service keeps its own table: every
// poll records the current hour for all stations, and stations that are at or
// near the bank get their last three days backfilled once, slowly.
import { fetchWaterHistory } from './sources/thaiwater.js';

const HOUR_MS = 3600_000;
const KEEP_MS = 7 * 86400_000;
const BACKFILL_GAP_MS = 400;
const BACKFILL_AGAIN_MS = 3 * 86400_000;
// A missing hour is filled from the reading before it, up to this far back.
const CARRY_HOURS = 3;
const NEAR_BANK_PERCENT = 70;
const TIMELINE_TTL_MS = 60_000;

export const hourOf = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/** ThaiWater's storage_percent: depth as a percentage of bank-full depth. */
export function percentOf(levelMsl, bankMsl, groundMsl) {
  const full = bankMsl - groundMsl;
  if (!Number.isFinite(full) || full <= 0 || !Number.isFinite(levelMsl))
    return null;
  return ((levelMsl - groundMsl) / full) * 100;
}

export function createHistory({
  db,
  fetchHistory = fetchWaterHistory,
  userAgent = 'bkk-watch',
  now = () => Date.now(),
  gapMs = BACKFILL_GAP_MS,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS water_hourly (
    station_id TEXT NOT NULL,
    t          INTEGER NOT NULL,
    percent    REAL NOT NULL,
    PRIMARY KEY (station_id, t)
  ) WITHOUT ROWID`);
  db.exec(`CREATE TABLE IF NOT EXISTS water_backfill (
    station_id TEXT PRIMARY KEY,
    at         INTEGER NOT NULL
  )`);
  const q = {
    put: db.prepare(
      'INSERT INTO water_hourly (station_id, t, percent) VALUES (?, ?, ?) ON CONFLICT(station_id, t) DO UPDATE SET percent = excluded.percent',
    ),
    // A live reading outranks a backfilled one for the same hour.
    putIfNew: db.prepare(
      'INSERT OR IGNORE INTO water_hourly (station_id, t, percent) VALUES (?, ?, ?)',
    ),
    range: db.prepare(
      'SELECT station_id, t, percent FROM water_hourly WHERE t >= ? AND t <= ? ORDER BY station_id, t',
    ),
    prune: db.prepare('DELETE FROM water_hourly WHERE t < ?'),
    filled: db.prepare('SELECT at FROM water_backfill WHERE station_id = ?'),
    markFilled: db.prepare(
      'INSERT INTO water_backfill (station_id, at) VALUES (?, ?) ON CONFLICT(station_id) DO UPDATE SET at = excluded.at',
    ),
  };
  let backfilling = false;
  let cached = null; // { at, hours, data }

  const inTransaction = (fn) => {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  /** Store each fresh station's reading under the hour it was observed. */
  function record(stations) {
    inTransaction(() => {
      for (const s of stations) {
        if (s.stale || s.observedAt == null) continue;
        if (!Number.isFinite(s.storagePercent)) continue;
        q.put.run(String(s.id), hourOf(s.observedAt), s.storagePercent);
      }
      q.prune.run(now() - KEEP_MS);
    });
    cached = null;
  }

  /** Fetch three days of history for at-risk stations not yet backfilled. */
  async function backfill(stations, { signal } = {}) {
    if (backfilling) return 0;
    backfilling = true;
    let done = 0;
    try {
      const wanted = stations.filter((s) => {
        if (s.stale || s.level < 4) return false;
        const hit = q.filled.get(String(s.id));
        return !hit || now() - hit.at > BACKFILL_AGAIN_MS;
      });
      for (const s of wanted) {
        if (signal?.aborted) break;
        try {
          const h = await fetchHistory(s.id, { userAgent, signal });
          const bank = Number.isFinite(h.bankMsl) ? h.bankMsl : s.bankMsl;
          const ground = Number.isFinite(h.groundMsl)
            ? h.groundMsl
            : s.groundMsl;
          inTransaction(() => {
            for (const p of h.points) {
              const percent = percentOf(p.v, bank, ground);
              if (percent != null)
                q.putIfNew.run(String(s.id), hourOf(p.t), percent);
            }
            q.markFilled.run(String(s.id), now());
          });
          done++;
          cached = null;
        } catch (e) {
          if (signal?.aborted) break;
          console.warn(`[history] ${s.id}: ${e.message}`);
        }
        if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      }
    } finally {
      backfilling = false;
    }
    return done;
  }

  /**
   * Hour-by-hour percent for every station that reached the near-bank band in
   * the window: { hours, series: { id: [percent|null] }, over, near }.
   */
  function timeline({ hours = 72 } = {}) {
    if (cached && cached.hours === hours && now() - cached.at < TIMELINE_TTL_MS)
      return cached.data;
    const end = hourOf(now());
    const start = end - hours * HOUR_MS;
    const slots = hours + 1;
    const byStation = new Map();
    // Read a little before the window so its first hours can be carried into.
    for (const row of q.range.all(start - CARRY_HOURS * HOUR_MS, end)) {
      let values = byStation.get(row.station_id);
      if (!values) {
        values = new Array(slots + CARRY_HOURS).fill(null);
        byStation.set(row.station_id, values);
      }
      values[(row.t - start) / HOUR_MS + CARRY_HOURS] = row.percent;
    }
    const series = {};
    const over = new Array(slots).fill(0);
    const near = new Array(slots).fill(0);
    for (const [id, padded] of byStation) {
      let last = null;
      let age = Infinity;
      const values = padded.map((v) => {
        if (v != null) {
          last = v;
          age = 0;
          return v;
        }
        age++;
        return age <= CARRY_HOURS ? last : null;
      });
      const inWindow = values.slice(CARRY_HOURS);
      if (!inWindow.some((v) => v != null && v > NEAR_BANK_PERCENT)) continue;
      series[id] = inWindow.map((v) =>
        v == null ? null : Math.round(v * 10) / 10,
      );
      inWindow.forEach((v, i) => {
        if (v == null) return;
        if (v > 100) over[i]++;
        else if (v > NEAR_BANK_PERCENT) near[i]++;
      });
    }
    const data = {
      hours: Array.from({ length: slots }, (_, i) => start + i * HOUR_MS),
      series,
      over,
      near,
    };
    cached = { at: now(), hours, data };
    return data;
  }

  return { record, backfill, timeline };
}
