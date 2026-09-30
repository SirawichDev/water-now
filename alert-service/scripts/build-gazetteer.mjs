#!/usr/bin/env node
// Build alert-service/gazetteer/bangkok.json from OpenStreetMap (Overpass).
// Data © OpenStreetMap contributors, ODbL 1.0.
//
//   node alert-service/scripts/build-gazetteer.mjs [overpass.json ...]
//
// Each entry: { name, kind, lat, lon, extentM }. extentM is how far the named
// feature spreads from its centre — a 20 km road is not a place you can pin.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(
  new URL('../gazetteer/bangkok.json', import.meta.url),
);
const QUERY = `[out:json][timeout:180];
area["name:en"="Bangkok"]["admin_level"="4"]->.bkk;
(
  relation["boundary"="administrative"]["admin_level"~"^(6|8)$"](area.bkk);
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"]["name"~"^(ถนน|ซอย|ทาง)"](area.bkk);
  way["waterway"~"^(canal|river|stream|drain)$"]["name"~"^(คลอง|แม่น้ำ)"](area.bkk);
  nwr["place"~"^(suburb|quarter|neighbourhood|village|hamlet)$"]["name"](area.bkk);
  nwr["landuse"="residential"]["name"](area.bkk);
  nwr["building"~"^(apartments|residential)$"]["name"~"เคหะ|แฟลต|อาคารสงเคราะห์|ชุมชน"](area.bkk);
);
out tags center;`;

function kindOf(tags) {
  // Named neighbourhoods, housing estates and flats: "แฟลตการเคหะคลองจั่น".
  if (tags.place || tags.landuse || tags.building) return 'place';
  if (tags.boundary === 'administrative')
    return tags.admin_level === '6' ? 'district' : 'subdistrict';
  if (tags.waterway) return 'canal';
  if (/^ซอย/.test(tags.name)) return 'soi';
  return 'road';
}

function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) *
      Math.cos(bLat * rad) *
      Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

async function loadOverpass() {
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'User-Agent': 'bkk-watch/0.1 (local dev)' },
    body: new URLSearchParams({ data: QUERY }),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

const files = process.argv.slice(2);
const elements = files.length
  ? files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).elements || [])
  : (await loadOverpass()).elements || [];
const groups = new Map();
for (const el of elements) {
  const tags = el.tags || {};
  const name = String(tags.name || '').trim();
  const center = el.center || (el.lat != null ? el : null);
  if (!name || !center) continue;
  // "เขตบางนา" / "แขวงบางนา" are one feature each; strip the admin prefix
  // so the name matches how news writes it.
  const kind = kindOf(tags);
  const key = `${kind}|${name}`;
  const g = groups.get(key) || { name, kind, points: [] };
  g.points.push([center.lat, center.lon]);
  groups.set(key, g);
}

const entries = [];
for (const g of groups.values()) {
  const lat = g.points.reduce((s, p) => s + p[0], 0) / g.points.length;
  const lon = g.points.reduce((s, p) => s + p[1], 0) / g.points.length;
  let extentM = Math.max(
    0,
    ...g.points.map(([a, b]) => distanceM(lat, lon, a, b)),
  );
  // Admin areas come as a single centre; give them a typical radius.
  if (g.kind === 'district') extentM = 3500;
  if (g.kind === 'subdistrict') extentM = 1500;
  if (g.kind === 'place') extentM = Math.max(extentM, 500);
  entries.push({
    name: g.name,
    kind: g.kind,
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
    extentM: Math.round(extentM),
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name, 'th'));
mkdirSync(fileURLToPath(new URL('../gazetteer/', import.meta.url)), {
  recursive: true,
});
writeFileSync(
  OUT,
  JSON.stringify({
    source: 'OpenStreetMap contributors (ODbL 1.0) via Overpass',
    builtAt: new Date().toISOString(),
    entries,
  }),
);
const byKind = {};
for (const e of entries) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log(`wrote ${entries.length} names to ${OUT}`, byKind);
