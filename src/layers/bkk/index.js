import * as Cesium from 'cesium';
import { createBkkPointLayer } from './pointLayer.js';
import { createNewsPanel } from './newsPanel.js';
import { createCamPanel } from './camPanel.js';
export {
  createBkkWaterSource,
  createBkkOutageSource,
  createBkkNewsSource,
  createBkkCamsSource,
  subscribeBkkUpdates,
} from './source.js';

const STALE_COLOR = '#9ca3af';

/** Near the bank, rounding hides the distinction that matters (99.8 vs 100). */
const formatPercent = (p) =>
  p >= 95 && p < 105 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;

/** Simple mode draws its own light callouts, so GEV's dark labels stay off. */
const simpleMode = () =>
  globalThis.document?.documentElement.classList.contains('th-simple') ?? false;
/** Simple mode's dark theme: pale specks and white rims would be noise. */
const darkTheme = () =>
  simpleMode() &&
  globalThis.document.documentElement.dataset.thTheme === 'dark';

export function createBkkWaterLayer({ source, overlayHost }) {
  return createBkkPointLayer({
    id: 'bkk-water',
    name: 'Thailand Water Levels',
    icon: '💧',
    sourceLabel: 'HII ThaiWater · LIVE',
    kind: 'water',
    source,
    overlayHost,
    listKey: 'stations',
    // ~800 stations nationwide: the eye should land on the ones in trouble.
    // Over-bank is a red dot with a halo, near-bank a small amber dot, the
    // rest are faint specks.
    toPoint: (st) => {
      const over = !st.stale && st.level >= 5;
      const near = !st.stale && st.level === 4;
      const dark = darkTheme();
      return {
        id: st.id,
        lat: st.lat,
        lon: st.lon,
        color: over
          ? dark
            ? '#FF4D42'
            : '#D92D20'
          : near
            ? dark
              ? '#FFB020'
              : '#F79009'
            : dark
              ? '#36405A'
              : STALE_COLOR,
        size: over ? 11 : near ? 7 : 4,
        halo: over ? 3 : undefined,
        edge: near && !dark ? 1 : over ? undefined : 0,
        label:
          over && !simpleMode()
            ? `${st.name} · ${st.levelText} ${formatPercent(st.storagePercent)}`
            : null,
        priority: over ? 5000 + Math.min(999, st.storagePercent) : 0,
        properties: { ...st },
      };
    },
    // The summary panel listens for this to open the station's detail.
    onPick: (st) =>
      globalThis.dispatchEvent?.(
        new CustomEvent('bkk:station', { detail: { id: st.id } }),
      ),
  });
}

// Uncertainty drawn as a ring: a road-level geocode can be kilometres off.
const PRECISION_RING_M = { soi: 0, road: 1500, approx: 2500 };
const LABEL_WINDOW_MS = 48 * 3600_000;

export function createBkkOutageLayer({ source, overlayHost }) {
  return createBkkPointLayer({
    id: 'bkk-outages',
    name: 'Bangkok Planned Outages',
    icon: '🔌',
    sourceLabel: 'MEA announcements',
    kind: 'outages',
    source,
    overlayHost,
    listKey: 'outages',
    toPoint: (o, now) => {
      if (o.lat == null || o.lon == null) return null;
      const active = o.startsAt <= now && now < o.endsAt;
      // Dots for everything, labels only for what is on or near: dozens of
      // future outages would otherwise crowd out the water stations.
      const soon = o.startsAt - now < LABEL_WINDOW_MS;
      const color = active ? '#a855f7' : '#facc15';
      const when = new Date(o.startsAt).toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const ringM = PRECISION_RING_M[o.precision] ?? 2500;
      return {
        id: o.id,
        lat: o.lat,
        lon: o.lon,
        color,
        size: active ? 15 : 11,
        label: soon
          ? `${active ? 'กำลังดับไฟ' : `ดับไฟ ${when}`} · ${o.area.length > 32 ? `${o.area.slice(0, 32)}…` : o.area}`
          : null,
        priority: active ? 900 : 300,
        ring: ringM ? { radiusM: ringM, color } : null,
        properties: { ...o, active },
      };
    },
  });
}

const NEWS_TOPIC_COLOR = {
  flood: '#38bdf8',
  outage: '#a855f7',
  fire: '#f43f5e',
  traffic: '#f59e0b',
};
const NEWS_TOPIC_LABEL = {
  flood: 'น้ำท่วม',
  outage: 'ไฟดับ',
  fire: 'ไฟไหม้',
  traffic: 'จราจร',
};

/** One dot per zone: many clips cover the same flooded estate. */
export function groupNewsByZone(items) {
  const zones = new Map();
  for (const item of items) {
    if (item.lat == null || item.lon == null) continue;
    const z = zones.get(item.zone) || {
      zone: item.zone,
      lat: item.lat,
      lon: item.lon,
      extentM: item.extentM,
      items: [],
      topics: {},
      live: false,
    };
    z.items.push(item);
    z.live ||= item.live;
    for (const t of item.topics) z.topics[t] = (z.topics[t] || 0) + 1;
    zones.set(item.zone, z);
  }
  return [...zones.values()];
}

export function createBkkNewsLayer({ source, overlayHost }) {
  let viewer = null;
  let panel = null;
  const flyTo = (zone) =>
    viewer?.camera.flyTo({
      // Stand off to the south and look north at the zone.
      destination: Cesium.Cartesian3.fromDegrees(
        zone.lon,
        zone.lat - 0.035,
        5500,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-50), roll: 0 },
      duration: 1.5,
    });
  const layer = createBkkPointLayer({
    id: 'bkk-news',
    name: 'Bangkok News by Zone',
    icon: '📰',
    sourceLabel: 'YouTube news channels',
    kind: 'news',
    source,
    overlayHost,
    listKey: 'items',
    prepare: groupNewsByZone,
    toPoint: (z) => {
      const top = Object.entries(z.topics).sort((a, b) => b[1] - a[1])[0]?.[0];
      const color = NEWS_TOPIC_COLOR[top] || '#e5e7eb';
      const name = z.zone.replace(/^(แขวง|เขต)/, '');
      return {
        id: z.zone,
        lat: z.lat,
        lon: z.lon,
        color,
        size: simpleMode() ? 8 : Math.min(20, 10 + z.items.length),
        label: simpleMode()
          ? null
          : `ข่าว: ${name} · ${z.items.length} คลิป${top ? ` · ${NEWS_TOPIC_LABEL[top]}` : ''}${z.live ? ' · LIVE' : ''}`,
        priority: 600 + z.items.length,
        // Simple mode marks zones with pills only; the ring is for GEV mode.
        ring:
          z.extentM > 1500 && !simpleMode()
            ? { radiusM: Math.min(z.extentM, 4000), color }
            : null,
        properties: { zone: z.zone, count: z.items.length },
      };
    },
    onPick: (zone) => openZone(zone.zone),
    onData: () => {
      panel?.refresh();
      if (wanted && hasZone(wanted)) openZone(wanted);
    },
  });
  // A zone asked for before the layer has its data opens when the data lands.
  let wanted = null;
  const hasZone = (zone) => layer.getRecords().some((z) => z.zone === zone);
  function openZone(zone) {
    wanted = null;
    panel ??= createNewsPanel({ getZones: () => layer.getRecords(), flyTo });
    panel.open(zone);
  }
  // Simple mode's news pills and gauge detail (HTML, outside the scene) open
  // the same player.
  globalThis.addEventListener?.('bkk:open-news', (e) => {
    const zone = e.detail?.zone;
    if (!zone) return;
    if (hasZone(zone)) openZone(zone);
    else wanted = zone;
  });
  // Keep the viewer for camera moves; close the player with the layer.
  const { init, disable, destroy } = layer;
  layer.init = (v, ...rest) => {
    viewer = v;
    // Dev-only QA handle: lets browser tests click a zone by its position.
    if (import.meta.env?.DEV) globalThis.__bkkNewsQa = { layer, viewer: v };
    return init(v, ...rest);
  };
  layer.disable = (...args) => {
    panel?.close();
    return disable(...args);
  };
  layer.destroy = (...args) => {
    panel?.destroy();
    panel = null;
    viewer = null;
    return destroy(...args);
  };
  return layer;
}

/** Live cameras as plain dots; a click opens the stream (simple mode). */
export function createBkkCamsLayer({ source, overlayHost }) {
  let viewer = null;
  let panel = null;
  const flyTo = (camera) =>
    viewer?.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, 4000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.2,
    });
  const layer = createBkkPointLayer({
    id: 'bkk-cams',
    name: 'Thailand Live Cameras',
    icon: '📹',
    sourceLabel: 'iTIC Foundation · LIVE',
    kind: 'cams',
    source,
    overlayHost,
    listKey: 'sources',
    updateInterval: 5 * 60_000,
    // Live streams, plus the still-image cameras that point at water.
    prepare: (cameras) =>
      cameras.filter(
        (c) => c.feedType === 'hls' || c.sourceKind === 'egat-dam',
      ),
    toPoint: (c) => ({
      id: c.id,
      lat: c.lat,
      lon: c.lon,
      color: c.sourceKind === 'egat-dam' ? '#175CD3' : '#475467',
      size: 8,
      label: null,
      properties: { name: c.name },
    }),
    onPick: (camera) => openCamera(camera),
  });
  function openCamera(camera) {
    panel ??= createCamPanel({ getCameras: () => layer.getRecords(), flyTo });
    panel.open(camera);
  }
  // Simple mode's gauge detail opens a camera by its record, with no map
  // click; the caller moves the map.
  globalThis.addEventListener?.('bkk:open-camera', (e) => {
    if (e.detail?.camera?.id) openCamera(e.detail.camera);
  });
  const { init, disable, destroy } = layer;
  layer.init = (v, ...rest) => {
    viewer = v;
    return init(v, ...rest);
  };
  layer.disable = (...args) => {
    panel?.close();
    return disable(...args);
  };
  layer.destroy = (...args) => {
    panel?.destroy();
    panel = null;
    viewer = null;
    return destroy(...args);
  };
  return layer;
}
