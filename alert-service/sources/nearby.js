// What is around a point: places from OpenStreetMap (Overpass) and the rain
// forecast from Open-Meteo. Both are keyless public services, so answers are
// cached by rounded coordinate and every failure degrades to "unknown".
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const PLACES_RADIUS_M = 3000;
// Places to eat are far denser than hospitals, so they get a shorter reach.
const FOOD_RADIUS_M = 1500;
// A gauge's own river or canal: search this far, accept a line passing this
// close, and keep the stretch of it within this reach.
const RIVER_SEARCH_M = 1200;
const RIVER_NEAR_M = 400;
const RIVER_REACH_M = 4000;
const PLACES_TTL_MS = 30 * 86400_000;
const RAIN_TTL_MS = 30 * 60_000;

/** category id → how many of the nearest to keep */
const CATEGORIES = Object.freeze({
  hospital: 3,
  convenience: 3,
  supermarket: 3,
  school: 2,
  pharmacy: 2,
  fuel: 2,
  police: 1,
});
/** Where food is sold. Asked for separately, so one failing does not cost the other. */
const FOOD_CATEGORIES = Object.freeze({
  marketplace: 3,
  convenience: 3,
  supermarket: 2,
  restaurant: 5,
  fast_food: 2,
  food_court: 1,
});

function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) *
      Math.cos(bLat * rad) *
      Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

/** Overpass elements → { category: [{ name, lat, lon, distM, hours }] } */
export function groupPlaces(elements, lat, lon, categories = CATEGORIES) {
  const out = Object.fromEntries(Object.keys(categories).map((k) => [k, []]));
  for (const el of elements || []) {
    const tags = el.tags || {};
    const category = tags.shop || tags.amenity;
    const at = el.center || el;
    if (!out[category] || !Number.isFinite(at.lat)) continue;
    const name = String(tags.name || tags.brand || '').trim();
    if (!name) continue;
    out[category].push({
      name,
      lat: at.lat,
      lon: at.lon,
      distM: Math.round(distanceM(lat, lon, at.lat, at.lon)),
      hours: tags.opening_hours || null,
    });
  }
  for (const [category, keep] of Object.entries(categories))
    out[category] = out[category]
      .sort((a, b) => a.distM - b.distM)
      .slice(0, keep);
  return out;
}

/** The same grouping for places that sell food. */
export const groupFood = (elements, lat, lon) =>
  groupPlaces(elements, lat, lon, FOOD_CATEGORIES);

/** Metres from a point to the segment a→b, on a local flat grid. */
function segmentDistanceM(lat, lon, a, b) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ax = (a.lon - lon) * kx;
  const ay = (a.lat - lat) * 110_540;
  const bx = (b.lon - lon) * kx;
  const by = (b.lat - lat) * 110_540;
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = len2
    ? Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / len2))
    : 0;
  return Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
}

/**
 * Overpass waterways (`out geom`) → the lines a gauge at this point stands
 * on: the nearest way, plus other ways of the same name within RIVER_NEAR_M,
 * each cut to the stretch within RIVER_REACH_M. Points keep the
 * way's own order, which OpenStreetMap draws in the direction of flow.
 * @returns {Array<{ name: string|null, kind: string, points: Array<[number, number]> }>}
 *          points are [lon, lat]
 */
export function pickRivers(elements, lat, lon) {
  const ways = (elements || [])
    .filter((w) => w.geometry?.length > 1)
    .map((w) => {
      let nearest = Infinity;
      let at = 0;
      for (let i = 1; i < w.geometry.length; i++) {
        const d = segmentDistanceM(lat, lon, w.geometry[i - 1], w.geometry[i]);
        if (d < nearest) {
          nearest = d;
          at = i;
        }
      }
      return { w, nearest, at };
    })
    .sort((a, b) => a.nearest - b.nearest);
  // The nearest way is the gauge's water. Others count only as more of the
  // same river (OpenStreetMap splits one into many ways); a different canal
  // that happens to pass close by is not what this gauge measures.
  const own = ways[0]?.w.tags?.name;
  return ways
    .filter(
      (x, i) =>
        i === 0 || (own && x.w.tags?.name === own && x.nearest <= RIVER_NEAR_M),
    )
    .slice(0, 3)
    .map(({ w, at }) => {
      const within = (p) => distanceM(lat, lon, p.lat, p.lon) <= RIVER_REACH_M;
      let from = at - 1;
      let to = at;
      while (from > 0 && within(w.geometry[from - 1])) from--;
      while (to < w.geometry.length - 1 && within(w.geometry[to + 1])) to++;
      return {
        name: w.tags?.name || null,
        kind: w.tags?.waterway || 'river',
        points: w.geometry
          .slice(from, to + 1)
          .map((p) => [+p.lon.toFixed(5), +p.lat.toFixed(5)]),
      };
    });
}

export function createNearby({ userAgent, db = null, fetchImpl = fetch }) {
  const rain = new Map();
  const remember = (map, key, data) => {
    if (map.size > 500) map.clear();
    map.set(key, { at: Date.now(), data });
    return data;
  };
  // Places are kept in the database (table from store.js): shops and
  // hospitals rarely move, and the public Overpass servers are too unreliable
  // to ask on every click.
  const getCached = (key) =>
    db?.get('SELECT json, fetched_at FROM places_cache WHERE key = ?', key);
  const putCached = (key, json, at) =>
    db?.run(
      'INSERT INTO places_cache (key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at',
      key,
      json,
      at,
    );
  const placeKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const foodKey = (lat, lon) => `food:${placeKey(lat, lon)}`;
  // A river line belongs to one gauge, so it is keyed more finely.
  // "river2": earlier answers could include a neighbouring canal.
  const riverKey = (lat, lon) => `river2:${lat.toFixed(3)},${lon.toFixed(3)}`;

  async function cached(key) {
    const row = await getCached(key);
    if (!row || Date.now() - row.fetched_at > PLACES_TTL_MS) return null;
    return JSON.parse(row.json);
  }

  async function overpass(query) {
    // The public instance sheds load with 429/504 (and 406 for some client
    // strings), so identify plainly and try a mirror before giving up.
    let res = null;
    let failure = 'no endpoint';
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': 'bkk-watch/0.1', Accept: '*/*' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(25_000),
        });
        if (res.ok) break;
        failure = `Overpass HTTP ${res.status}`;
      } catch (e) {
        failure = e.message;
      }
      res = null;
    }
    if (!res) throw new Error(failure);
    return (await res.json()).elements;
  }

  async function lookup(key, radiusM, query, group, field = 'places') {
    const hit = await cached(key);
    if (hit) return hit;
    const data = {
      radiusM,
      source: 'OpenStreetMap',
      fetchedAt: Date.now(),
      [field]: group(await overpass(query)),
    };
    await putCached(key, JSON.stringify(data), data.fetchedAt);
    return data;
  }

  function getPlaces(lat, lon) {
    const around = `(around:${PLACES_RADIUS_M},${lat},${lon})`;
    return lookup(
      placeKey(lat, lon),
      PLACES_RADIUS_M,
      `[out:json][timeout:20];(nw["shop"~"^(convenience|supermarket)$"]${around};nw["amenity"~"^(hospital|police|school|fuel|pharmacy)$"]${around};);out tags center;`,
      (elements) => groupPlaces(elements, lat, lon),
    );
  }

  function getFood(lat, lon) {
    const around = `(around:${FOOD_RADIUS_M},${lat},${lon})`;
    return lookup(
      foodKey(lat, lon),
      FOOD_RADIUS_M,
      `[out:json][timeout:20];(nw["amenity"~"^(marketplace|restaurant|fast_food|food_court)$"]${around};nw["shop"~"^(convenience|supermarket)$"]${around};);out tags center;`,
      (elements) => groupFood(elements, lat, lon),
    );
  }

  /**
   * The river or canal a gauge stands on, for the map's flow lines. With
   * `cachedOnly` it answers from the cache or not at all, so drawing many
   * gauges never sends a burst of requests to Overpass.
   */
  function getRiver(lat, lon, { cachedOnly = false } = {}) {
    if (cachedOnly)
      return cached(riverKey(lat, lon)).then((hit) => hit || { rivers: null });
    return lookup(
      riverKey(lat, lon),
      RIVER_SEARCH_M,
      `[out:json][timeout:20];way["waterway"~"^(river|canal)$"](around:${RIVER_SEARCH_M},${lat},${lon});out geom;`,
      (elements) => pickRivers(elements, lat, lon),
      'rivers',
    );
  }

  /**
   * Fetch the river, places and food for the given points in the background,
   * one request at a time with a pause, so a flooded gauge's detail opens
   * from the cache.
   */
  let warming = false;
  async function warm(points, { gapMs = 20_000, signal } = {}) {
    if (warming) return;
    warming = true;
    try {
      for (const { lat, lon } of points) {
        if (signal?.aborted) break;
        for (const [key, get] of [
          [riverKey(lat, lon), getRiver],
          [placeKey(lat, lon), getPlaces],
          [foodKey(lat, lon), getFood],
        ]) {
          if (await cached(key)) continue;
          try {
            await get(lat, lon);
          } catch {
            /* try again on the next round */
          }
          await new Promise((r) => setTimeout(r, gapMs));
        }
      }
    } finally {
      warming = false;
    }
  }

  async function getRain(lat, lon) {
    const key = `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lon * 20) / 20).toFixed(2)}`;
    const hit = rain.get(key);
    if (hit && Date.now() - hit.at < RAIN_TTL_MS) return hit.data;
    const url = `${OPEN_METEO}?${new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: 'precipitation,precipitation_probability',
      forecast_hours: '6',
      timezone: 'Asia/Bangkok',
    })}`;
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const h = (await res.json()).hourly || {};
    const hours = (h.time || []).map((t, i) => ({
      time: t,
      mm: Number(h.precipitation?.[i]) || 0,
      prob: Number(h.precipitation_probability?.[i]) || 0,
    }));
    return remember(rain, key, {
      source: 'Open-Meteo',
      hours,
      totalMm: +hours.reduce((s, x) => s + x.mm, 0).toFixed(1),
      maxProb: Math.max(0, ...hours.map((x) => x.prob)),
    });
  }

  return { getPlaces, getFood, getRiver, getRain, warm };
}
