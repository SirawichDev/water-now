// Reports from people on the spot — the data no sensor provides: how deep the
// street is, whether trash is riding the water, whether food is still on sale.
// Deliberately narrow: fixed choices at a point, no free text, so there is
// nothing to moderate. Reports expire, are rate-limited per sender, and are
// always shown as unconfirmed.
import { createHash, randomUUID } from 'node:crypto';
import { DEPTH_LEVELS } from './news/depth.js';
import { distanceM } from './engine.js';

const ACTIVE_MS = 6 * 3600_000;
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 3;
const MAX_PER_DAY = 20;
const SPOT_RADIUS_M = 60;

/** What a report can say, per kind. One submission answers any of them. */
export const REPORT_CHOICES = Object.freeze({
  depth: DEPTH_LEVELS,
  trash: Object.freeze([
    { id: 'floating', label: 'ขยะลอยมากับน้ำ' },
    { id: 'blocking', label: 'ขยะอุดทางระบายน้ำ' },
    { id: 'clear', label: 'ไม่มีขยะ' },
  ]),
  food: Object.freeze([
    { id: 'open', label: 'ยังเปิดขาย' },
    { id: 'closed', label: 'ปิดแล้ว' },
  ]),
});
const CHOICE = Object.fromEntries(
  Object.entries(REPORT_CHOICES).map(([kind, list]) => [
    kind,
    new Map(list.map((c) => [c.id, c])),
  ]),
);
// Thailand's bounding box.
const inThailand = (lat, lon) =>
  lat >= 5.5 && lat <= 20.6 && lon >= 97.3 && lon <= 105.7;

/**
 * Trash and food reports, newest first, merged into one spot per place: the
 * newest report sets the status and `count` is how many senders said the same
 * since anyone last said otherwise. A trash spot reported clear drops out.
 * @param {Array<{ id, kind, lat, lon, level, sender, created_at }>} rows
 */
export function groupSpots(rows) {
  const spots = [];
  for (const r of rows) {
    let spot = spots.find(
      (s) =>
        s.kind === r.kind &&
        distanceM(s.lat, s.lon, r.lat, r.lon) <= SPOT_RADIUS_M,
    );
    if (!spot) {
      spot = {
        id: r.id,
        kind: r.kind,
        lat: r.lat,
        lon: r.lon,
        status: r.level,
        createdAt: r.created_at,
        senders: new Set(),
        settled: false,
      };
      spots.push(spot);
    }
    if (spot.settled) continue;
    if (r.level === spot.status) spot.senders.add(r.sender);
    else spot.settled = true;
  }
  return spots
    .filter((s) => !(s.kind === 'trash' && s.status === 'clear'))
    .map(({ senders, settled, ...s }) => ({
      ...s,
      label: CHOICE[s.kind].get(s.status)?.label ?? s.status,
      count: senders.size,
    }));
}

export function createReports({ db, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    level      TEXT NOT NULL,
    sender     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // Tables from before trash and food reports hold depth levels only.
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(reports)')
      .all()
      .map((c) => c.name),
  );
  if (!columns.has('kind'))
    db.exec(
      "ALTER TABLE reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'depth'",
    );
  if (!columns.has('batch'))
    db.exec('ALTER TABLE reports ADD COLUMN batch TEXT');
  const q = {
    add: db.prepare(
      'INSERT INTO reports (lat, lon, kind, level, sender, batch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    depthSince: db.prepare(
      "SELECT id, lat, lon, level, created_at FROM reports WHERE kind = 'depth' AND created_at > ? ORDER BY created_at DESC, id DESC",
    ),
    spotsSince: db.prepare(
      "SELECT id, kind, lat, lon, level, sender, created_at FROM reports WHERE kind != 'depth' AND created_at > ? ORDER BY created_at DESC, id DESC",
    ),
    // One submission may answer several questions; it counts once.
    countBy: db.prepare(
      'SELECT COUNT(DISTINCT COALESCE(batch, id)) AS n FROM reports WHERE sender = ? AND created_at > ?',
    ),
  };
  // Senders are stored as a salted hash: enough to rate-limit, not to identify.
  const salt = createHash('sha256')
    .update(`bkk-watch:${process.pid}:${now()}`)
    .digest('hex');
  const senderOf = (ip) =>
    createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);

  /** Street-depth reports still on the map. */
  function list() {
    const t = now();
    return q.depthSince.all(t - ACTIVE_MS).map((r) => ({
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      level: r.level,
      cm: CHOICE.depth.get(r.level)?.cm ?? null,
      label: CHOICE.depth.get(r.level)?.label ?? r.level,
      createdAt: r.created_at,
    }));
  }

  /** Trash and food spots still on the map. */
  function spots() {
    return groupSpots(q.spotsSince.all(now() - ACTIVE_MS));
  }

  /**
   * `{ lat, lon, answers: { depth?, trash?, food? } }`, or the older
   * `{ lat, lon, level }` for a depth report alone.
   * @returns {{ ok: true, reports: object[] } | { ok: false, status: number, error: string }}
   */
  function add({ lat, lon, level, answers }, ip) {
    lat = Number(lat);
    lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inThailand(lat, lon))
      return { ok: false, status: 400, error: 'ตำแหน่งต้องอยู่ในประเทศไทย' };
    const given = Object.entries(
      answers && typeof answers === 'object' ? answers : { depth: level },
    ).filter(([, choice]) => choice != null);
    if (
      !given.length ||
      given.some(([kind, choice]) => !CHOICE[kind]?.has(choice))
    )
      return { ok: false, status: 400, error: 'ตัวเลือกไม่ถูกต้อง' };
    const sender = senderOf(String(ip || 'unknown'));
    const t = now();
    if (q.countBy.get(sender, t - WINDOW_MS).n >= MAX_PER_WINDOW)
      return {
        ok: false,
        status: 429,
        error: 'รายงานถี่เกินไป ลองใหม่ในอีกสักครู่',
      };
    if (q.countBy.get(sender, t - 86400_000).n >= MAX_PER_DAY)
      return { ok: false, status: 429, error: 'รายงานครบจำนวนของวันนี้แล้ว' };
    const batch = randomUUID();
    return {
      ok: true,
      reports: given.map(([kind, choice]) => {
        const info = q.add.run(lat, lon, kind, choice, sender, batch, t);
        const picked = CHOICE[kind].get(choice);
        return {
          id: Number(info.lastInsertRowid),
          kind,
          lat,
          lon,
          level: choice,
          ...(kind === 'depth' ? { cm: picked.cm } : {}),
          label: picked.label,
          createdAt: t,
        };
      }),
    };
  }

  return { list, spots, add, levels: DEPTH_LEVELS, choices: REPORT_CHOICES };
}
