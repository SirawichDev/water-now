// Hail (ลูกเห็บ): short, local storms that no water gauge sees. A zone opens
// where a headline names a Bangkok place together with "ลูกเห็บ", or where a
// resident reports hail. It counts as confirmed once a second kind of evidence
// agrees: residents, a Meteorological Department warning that names hail
// around Bangkok, or a weather model with an explicit hail forecast. Zones
// fade after an hour and close after three (the map does the fading).
import { distanceM } from './engine.js';
import { fetchTmdWarnings, hailWarning } from './sources/tmd.js';
import { loadSnapshot, saveSnapshot } from './store.js';

export const HAIL_WORD = /ลูกเห็บ/;
export const HAIL_ACTIVE_MS = 3 * 3600_000;
const MERGE_M = 6000; // evidence this close to a zone joins it
const MIN_RADIUS_M = 2000;
const MAX_RADIUS_M = 3500;
const CONFIRM_SOURCES = 2;
const TMD_EVERY_MS = 15 * 60_000;
const MODEL_TTL_MS = 20 * 60_000;
// DWD ICON forecasts hail explicitly (WMO codes 96/99); most other models only
// ever report thunderstorms (95/97), so Open-Meteo is asked for ICON by name.
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const MODEL = 'icon_global';
const HAIL_CODES = new Set([96, 99]);
const STORM_CODES = new Set([95, 96, 97, 99]);

const clampRadius = (m) =>
  Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, Number(m) || 0));
/** "ถนนลาดพร้าว" → "ลาดพร้าว": the name a person says. */
export const shortPlace = (name) =>
  name ? String(name).replace(/^(ถนน|เขต|แขวง|ซอย)\s*/, '') : null;
const keyOf = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

/**
 * What the model says around one zone: hail from an hour before the first
 * report until an hour from now, and the next hail or thunderstorm hour.
 * @param {{ time: string[], weather_code: number[], cape?: number[] }} hourly
 *   Open-Meteo hourly data in Bangkok time.
 */
export function readModel(hourly, { since, now }) {
  const rows = (hourly?.time || []).map((t, i) => ({
    at: Date.parse(`${t}:00+07:00`),
    code: Number(hourly.weather_code?.[i]),
    cape: Number(hourly.cape?.[i]) || 0,
  }));
  const during = rows.filter(
    (r) => r.at >= since - 3600_000 && r.at <= now + 3600_000,
  );
  const ahead = rows.filter((r) => r.at > now && r.at <= now + 6 * 3600_000);
  return {
    model: 'DWD ICON',
    hail: during.some((r) => HAIL_CODES.has(r.code)),
    hailAhead: ahead.find((r) => HAIL_CODES.has(r.code))?.at ?? null,
    stormAhead: ahead.find((r) => STORM_CODES.has(r.code))?.at ?? null,
    cape: Math.round(Math.max(0, ...during.map((r) => r.cape))),
  };
}

/**
 * The hail zones from all evidence at `now`, strongest first.
 * @param {object} p
 * @param {object[]} p.news     news items: { id, channel, title, url, lat, lon, extentM, zone, publishedAt, firstSeen }
 * @param {object[]} p.reports  hail reports: { lat, lon, level: 'seen'|'none', sender, created_at }
 * @param {object|null} p.warning  the TMD warning naming hail around Bangkok
 * @param {Map<string, object>} p.models  zone id → Open-Meteo hourly data
 */
export function hailZones({
  news = [],
  reports = [],
  warning = null,
  models = new Map(),
  now,
}) {
  const zones = [];
  const near = (lat, lon) =>
    zones.find((z) => distanceM(z.lat, z.lon, lat, lon) <= MERGE_M);
  const zoneAt = (lat, lon, radiusM, place) => {
    let z = near(lat, lon);
    if (!z) {
      z = {
        lat,
        lon,
        radiusM,
        place,
        news: [],
        seen: new Map(),
        none: new Set(),
      };
      zones.push(z);
    }
    if (!z.place && place) Object.assign(z, { lat, lon, radiusM, place });
    return z;
  };
  const at = (n) => n.publishedAt || n.firstSeen;
  const clips = news
    .filter(
      (n) =>
        n.lat != null &&
        HAIL_WORD.test(n.title || '') &&
        now - at(n) < HAIL_ACTIVE_MS,
    )
    .sort((a, b) => at(a) - at(b));
  for (const n of clips)
    zoneAt(n.lat, n.lon, clampRadius(n.extentM), shortPlace(n.zone)).news.push({
      id: n.id,
      channel: n.channel,
      title: n.title,
      url: n.url,
      at: at(n),
    });
  const recent = reports
    .filter((r) => now - r.created_at < HAIL_ACTIVE_MS)
    .sort((a, b) => a.created_at - b.created_at);
  for (const r of recent)
    if (r.level === 'seen')
      zoneAt(r.lat, r.lon, MIN_RADIUS_M, null).seen.set(r.sender, r.created_at);
  for (const r of recent)
    if (r.level === 'none') {
      const z = zones.find(
        (z) => distanceM(z.lat, z.lon, r.lat, r.lon) <= z.radiusM,
      );
      if (z) z.none.add(r.sender);
    }

  return zones
    .map((z) => {
      const id = keyOf(z.lat, z.lon);
      const times = [...z.news.map((n) => n.at), ...z.seen.values()];
      const firstAt = Math.min(...times);
      const lastAt = Math.max(...times);
      const hourly = models.get(id);
      const model = hourly ? readModel(hourly, { since: firstAt, now }) : null;
      const sources = {
        news: z.news.length > 0,
        residents: z.seen.size > 0,
        tmd: Boolean(warning),
        model: Boolean(model?.hail),
      };
      const count = Object.values(sources).filter(Boolean).length;
      return {
        id,
        lat: z.lat,
        lon: z.lon,
        radiusM: z.radiusM,
        place: z.place,
        firstAt,
        lastAt,
        news: z.news.sort((a, b) => b.at - a.at),
        residents: { seen: z.seen.size, none: z.none.size },
        warning,
        model,
        sources,
        count,
        confirmed: count >= CONFIRM_SOURCES,
      };
    })
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/**
 * @param {object} opts
 * @param {() => Promise<object[]>} opts.getNews  placed clips (news engine)
 * @param {object} [opts.reports]  reports.js, for hailRows
 * @param {object} [opts.db]  a store: the state is saved there, so a
 *   serverless instance picks up where another one stopped
 */
export function createHail({
  engine,
  getNews = async () => [],
  reports = null,
  db = null,
  userAgent = 'bkk-watch',
  fetchImpl = fetch,
  getWarnings = () => fetchTmdWarnings({ userAgent }),
  now = () => Date.now(),
}) {
  const state = {
    updatedAt: null,
    zones: [],
    tmd: { checkedAt: null, error: null, latest: null, hail: null },
  };
  const models = new Map(); // zone id → { at, hourly }
  let last = '';
  let restored = !db;

  /** Pick up the TMD check and model answers another process saved. */
  async function restore() {
    if (restored) return;
    restored = true;
    const saved = await loadSnapshot(db, 'hail');
    if (!saved) return;
    if (saved.tmd) state.tmd = saved.tmd;
    for (const [id, m] of saved.models || []) models.set(id, m);
    last = JSON.stringify([saved.zones || [], state.tmd]);
  }

  async function pollTmd() {
    const t = now();
    if (state.tmd.checkedAt && t - state.tmd.checkedAt < TMD_EVERY_MS) return;
    try {
      const list = await getWarnings();
      const pick = (w) =>
        w && { title: w.title, url: w.url, date: w.date, dateText: w.dateText };
      state.tmd = {
        checkedAt: t,
        error: null,
        latest: pick(list[0]),
        hail: pick(hailWarning(list, t)),
      };
    } catch (e) {
      state.tmd = { ...state.tmd, checkedAt: t, error: e.message };
    }
  }

  async function fetchModel(z) {
    const hit = models.get(z.id);
    if (hit && now() - hit.at < MODEL_TTL_MS) return;
    const url = `${OPEN_METEO}?${new URLSearchParams({
      latitude: String(z.lat),
      longitude: String(z.lon),
      hourly: 'weather_code,cape',
      models: MODEL,
      past_hours: '4',
      forecast_hours: '7',
      timezone: 'Asia/Bangkok',
    })}`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    models.set(z.id, { at: now(), hourly: (await res.json()).hourly || {} });
  }

  const zonesNow = async () =>
    hailZones({
      news: await getNews(),
      reports: reports ? await reports.hailRows(now() - HAIL_ACTIVE_MS) : [],
      warning: state.tmd.hail,
      models: new Map([...models].map(([id, m]) => [id, m.hourly])),
      now: now(),
    });

  /** Recompute from what is already known; with `fresh`, ask the model too. */
  async function refresh({ fresh = false } = {}) {
    await restore();
    let zones = await zonesNow();
    if (fresh && zones.length) {
      for (const z of zones)
        await fetchModel(z).catch((e) =>
          console.warn(`[hail] model ${z.id}: ${e.message}`),
        );
      zones = await zonesNow();
    }
    for (const id of models.keys())
      if (!zones.some((z) => z.id === id)) models.delete(id);
    state.zones = zones;
    state.updatedAt = now();
    const next = JSON.stringify([zones, state.tmd]);
    const changed = next !== last;
    last = next;
    if (db)
      await saveSnapshot(
        db,
        'hail',
        { ...state, models: [...models] },
        // The saved time moves only when zones or the TMD check change, so
        // browsers polling for changes do not refetch for nothing.
        changed ? now() : ((await loadSnapshot(db, 'hail'))?.savedAt ?? now()),
      );
    if (changed) engine.events.emit('update', 'hail');
  }

  async function poll() {
    await restore();
    await pollTmd();
    await refresh({ fresh: true });
  }

  /** What /api/bkk/hail serves, from any process. */
  async function current() {
    if (!db) return state;
    const saved = await loadSnapshot(db, 'hail');
    if (!saved) return state;
    const { models: _, savedAt: __, ...out } = saved;
    return out;
  }

  return { state, poll, refresh, current };
}
