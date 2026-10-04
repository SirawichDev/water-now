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
  // Hail is not a spot: hail.js turns these into zones with other evidence.
  hail: Object.freeze([
    { id: 'seen', label: 'เห็นลูกเห็บตก' },
    { id: 'none', label: 'ไม่มีลูกเห็บ' },
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

/**
 * @param {object} opts
 * @param {object} opts.db    a store from store.js (it creates the table)
 * @param {string} [opts.salt] keeps sender hashes stable across processes
 */
export function createReports({ db, now = () => Date.now(), salt: secret }) {
  const SQL = {
    add: 'INSERT INTO reports (lat, lon, kind, level, sender, batch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    depthSince:
      "SELECT id, lat, lon, level, created_at FROM reports WHERE kind = 'depth' AND created_at > ? ORDER BY created_at DESC, id DESC",
    spotsSince:
      "SELECT id, kind, lat, lon, level, sender, created_at FROM reports WHERE kind NOT IN ('depth', 'hail') AND created_at > ? ORDER BY created_at DESC, id DESC",
    hailSince:
      "SELECT lat, lon, level, sender, created_at FROM reports WHERE kind = 'hail' AND created_at > ? ORDER BY created_at",
    // One submission may answer several questions; it counts once.
    countBy:
      'SELECT COUNT(DISTINCT COALESCE(batch, CAST(id AS TEXT))) AS n FROM reports WHERE sender = ? AND created_at > ?',
    latest: 'SELECT MAX(created_at) AS at FROM reports',
  };
  // Senders are stored as a salted hash: enough to rate-limit, not to
  // identify. Serverless instances share one secret salt, or a sender would
  // get a new hash (and a fresh limit) on every instance.
  const salt =
    secret ||
    createHash('sha256')
      .update(`bkk-watch:${process.pid}:${now()}`)
      .digest('hex');
  const senderOf = (ip) =>
    createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);

  /** Street-depth reports still on the map. */
  async function list() {
    const t = now();
    return (await db.all(SQL.depthSince, t - ACTIVE_MS)).map((r) => ({
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
  async function spots() {
    return groupSpots(await db.all(SQL.spotsSince, now() - ACTIVE_MS));
  }

  /** Hail reports since `t`, oldest first, for hail.js. */
  const hailRows = (t) => db.all(SQL.hailSince, t);

  /** When the newest report was filed (what browsers poll for). */
  const latestAt = async () => (await db.get(SQL.latest))?.at ?? null;

  /**
   * `{ lat, lon, answers: { depth?, trash?, food?, hail? } }`, or the older
   * `{ lat, lon, level }` for a depth report alone.
   * @returns {{ ok: true, reports: object[] } | { ok: false, status: number, error: string }}
   */
  async function add({ lat, lon, level, answers }, ip) {
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
    if ((await db.get(SQL.countBy, sender, t - WINDOW_MS)).n >= MAX_PER_WINDOW)
      return {
        ok: false,
        status: 429,
        error: 'รายงานถี่เกินไป ลองใหม่ในอีกสักครู่',
      };
    if ((await db.get(SQL.countBy, sender, t - 86400_000)).n >= MAX_PER_DAY)
      return { ok: false, status: 429, error: 'รายงานครบจำนวนของวันนี้แล้ว' };
    const batch = randomUUID();
    const reports = [];
    for (const [kind, choice] of given) {
      const { id } = await db.get(
        SQL.add,
        lat,
        lon,
        kind,
        choice,
        sender,
        batch,
        t,
      );
      const picked = CHOICE[kind].get(choice);
      reports.push({
        id: Number(id),
        kind,
        lat,
        lon,
        level: choice,
        ...(kind === 'depth' ? { cm: picked.cm } : {}),
        label: picked.label,
        createdAt: t,
      });
    }
    return { ok: true, reports };
  }

  return {
    list,
    spots,
    hailRows,
    latestAt,
    add,
    levels: DEPTH_LEVELS,
    choices: REPORT_CHOICES,
  };
}
