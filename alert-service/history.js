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
// An hour with fewer real readings than this share of a typical hour was not
// recorded (the service was not running), not an hour without floods.
const GAP_SHARE = 0.25;

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
  // Tables are created by store.js.
  const SQL = {
    put: 'INSERT INTO water_hourly (station_id, t, percent) VALUES (?, ?, ?) ON CONFLICT (station_id, t) DO UPDATE SET percent = excluded.percent',
    // A live reading outranks a backfilled one for the same hour.
    putIfNew:
      'INSERT INTO water_hourly (station_id, t, percent) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    range:
      'SELECT station_id, t, percent FROM water_hourly WHERE t >= ? AND t <= ? ORDER BY station_id, t',
    prune: 'DELETE FROM water_hourly WHERE t < ?',
    filled: 'SELECT at FROM water_backfill WHERE station_id = ?',
    markFilled:
      'INSERT INTO water_backfill (station_id, at) VALUES (?, ?) ON CONFLICT (station_id) DO UPDATE SET at = excluded.at',
  };
  let backfilling = false;
  let cached = null; // { at, hours, data }

  /** Store each fresh station's reading under the hour it was observed. */
  async function record(stations) {
    await db.tx(async (tx) => {
      for (const s of stations) {
        if (s.stale || s.observedAt == null) continue;
        if (!Number.isFinite(s.storagePercent)) continue;
        await tx.run(
          SQL.put,
          String(s.id),
          hourOf(s.observedAt),
          s.storagePercent,
        );
      }
      await tx.run(SQL.prune, now() - KEEP_MS);
    });
    cached = null;
  }

  /**
   * Fetch three days of history for at-risk stations not yet backfilled, at
   * most `limit` of them (a serverless run has a time budget).
   */
  async function backfill(stations, { signal, limit = Infinity } = {}) {
    if (backfilling) return 0;
    backfilling = true;
    let done = 0;
    try {
      const wanted = [];
      for (const s of stations) {
        if (s.stale || s.level < 4) continue;
        const hit = await db.get(SQL.filled, String(s.id));
        if (!hit || now() - hit.at > BACKFILL_AGAIN_MS) wanted.push(s);
        if (wanted.length >= limit) break;
      }
      for (const s of wanted) {
        if (signal?.aborted) break;
        try {
          const h = await fetchHistory(s.id, { userAgent, signal });
          const bank = Number.isFinite(h.bankMsl) ? h.bankMsl : s.bankMsl;
          const ground = Number.isFinite(h.groundMsl)
            ? h.groundMsl
            : s.groundMsl;
          await db.tx(async (tx) => {
            for (const p of h.points) {
              const percent = percentOf(p.v, bank, ground);
              if (percent != null)
                await tx.run(SQL.putIfNew, String(s.id), hourOf(p.t), percent);
            }
            await tx.run(SQL.markFilled, String(s.id), now());
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
   * the window: { hours, series: { id: [percent|null] }, over, near, gap }.
   * `gap[i]` is true for an hour the service did not record.
   */
  async function timeline({ hours = 72 } = {}) {
    if (cached && cached.hours === hours && now() - cached.at < TIMELINE_TTL_MS)
      return cached.data;
    const end = hourOf(now());
    const start = end - hours * HOUR_MS;
    const slots = hours + 1;
    const byStation = new Map();
    // Read a little before the window so its first hours can be carried into.
    const rows = await db.all(SQL.range, start - CARRY_HOURS * HOUR_MS, end);
    for (const row of rows) {
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
    const readings = new Array(slots).fill(0);
    for (const padded of byStation.values())
      padded.slice(CARRY_HOURS).forEach((v, i) => {
        if (v != null) readings[i]++;
      });
    // Compared with a typical recorded hour, not the busiest: backfilled
    // hours hold only the at-risk stations, live hours hold every station.
    const recorded = readings.filter((n) => n > 0).sort((a, b) => a - b);
    const typical = recorded[Math.floor(recorded.length / 2)] || 0;
    const gap = readings.map((n) => n < typical * GAP_SHARE);
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
      gap,
    };
    cached = { at: now(), hours, data };
    return data;
  }

  return { record, backfill, timeline };
}
