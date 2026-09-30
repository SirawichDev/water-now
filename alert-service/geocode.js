// Nominatim geocoding with a permanent SQLite cache (misses included) and the
// public instance's 1 request/second limit enforced by a serial queue.
import { geocodeCandidates } from './sources/mea.js';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const GAP_MS = 1100;
const squash = (s) => String(s || '').replace(/\s+/g, '');

export function createGeocoder({ db, userAgent, fetchImpl = fetch }) {
  const getCached = db.prepare(
    'SELECT lat, lon, display FROM geocache WHERE query = ?',
  );
  const putCached = db.prepare(
    'INSERT OR REPLACE INTO geocache (query, lat, lon, display, fetched_at) VALUES (?, ?, ?, ?, ?)',
  );
  let queue = Promise.resolve();
  let lastCall = 0;

  async function lookup(query) {
    const hit = getCached.get(query);
    if (hit) return hit.lat == null ? null : hit;
    const run = async () => {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      const url = `${ENDPOINT}?${new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '1',
        countrycodes: 'th',
      })}`;
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent },
      });
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
      const [first] = await res.json();
      const row = first
        ? {
            lat: Number(first.lat),
            lon: Number(first.lon),
            display: first.display_name,
          }
        : { lat: null, lon: null, display: null };
      putCached.run(query, row.lat, row.lon, row.display, Date.now());
      return row.lat == null ? null : row;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  /**
   * Resolve an MEA area to a point plus how far to trust it:
   * 'soi'  – the geocoder returned the named soi itself,
   * 'road' – only the road matched (a long road: kilometres of error),
   * 'approx' – something was returned but its name did not match.
   */
  async function locateArea(area) {
    let fallback = null;
    for (const c of geocodeCandidates(area)) {
      const hit = await lookup(c.query);
      if (!hit) continue;
      // The feature's own name is the first display component; it must equal
      // the query name, or "ซอยX 2" would accept "ซอยX 2 ซอย 32".
      if (squash(hit.display.split(',')[0]) === squash(c.name))
        return {
          lat: hit.lat,
          lon: hit.lon,
          precision: c.kind,
          matched: hit.display,
        };
      fallback ??= {
        lat: hit.lat,
        lon: hit.lon,
        precision: 'approx',
        matched: hit.display,
      };
    }
    return fallback;
  }

  return { lookup, locateArea };
}
