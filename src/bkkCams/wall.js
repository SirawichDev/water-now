// bkk-watch camera wall: Thailand cameras through the same /api/cctv proxy and
// decoder the map's CCTV panel uses. Only tiles on screen hold a live stream,
// so a 200-camera province list costs what one screenful costs.
import { attachCctvVideo } from '../layers/cctv/videoPlayback.js';

const FLOOD_RADIUS_M = 6000; // cameras this close to a high-water station
const FLOOD_LEVEL = 4; // ThaiWater situation_level: 4 near bank, 5 over bank
const START_STAGGER_MS = 300;
const RETRY_MS = 60_000;
const IMAGE_REFRESH_MS = 60_000;

const grid = document.getElementById('grid');
const summary = document.getElementById('summary');
const note = document.getElementById('note');
const modeSelect = document.getElementById('mode');

let cameras = [];
let stations = [];
let tiles = [];
let startQueue = Promise.resolve();

function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) *
      Math.cos(bLat * rad) *
      Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

function renderSummary() {
  const counts = { live: 0, wait: 0, fail: 0, idle: 0, still: 0 };
  for (const t of tiles) counts[t.state]++;
  summary.textContent = `${tiles.length} กล้อง · ถ่ายทอดสด ${counts.live} · ภาพนิ่ง ${counts.still} · กำลังเชื่อมต่อ ${counts.wait} · ใช้ไม่ได้ ${counts.fail}`;
}

function setState(tile, state, text) {
  tile.state = state;
  const badge = tile.el.querySelector('.state');
  badge.className = `state ${state === 'still' ? 'wait' : state}`;
  badge.textContent = text;
  renderSummary();
}

/** Live HLS starts when a tile scrolls into view and stops when it leaves. */
function activate(tile) {
  if (tile.active) return;
  tile.active = true;
  const cam = tile.camera;
  if (cam.feedType !== 'hls') {
    const img = tile.el.querySelector('img');
    const load = () => {
      img.src = `/api/cctv/frame/${encodeURIComponent(cam.id)}?t=${Date.now()}`;
    };
    load();
    tile.timer = setInterval(load, IMAGE_REFRESH_MS);
    setState(tile, 'still', 'ภาพนิ่ง');
    return;
  }
  const video = tile.el.querySelector('video');
  const start = () => {
    if (!tile.active) return;
    setState(tile, 'wait', 'กำลังเชื่อมต่อ');
    tile.playback = attachCctvVideo(
      video,
      `/api/cctv/media/${encodeURIComponent(cam.id)}`,
      'hls',
      {
        onFailure: () => {
          tile.playback = null;
          setState(tile, 'fail', 'ใช้ไม่ได้ · จะลองใหม่');
          tile.timer = setTimeout(start, RETRY_MS);
        },
      },
    );
  };
  // Serialize start-ups a little so session creation does not queue behind
  // the browser's per-host connection limit all at once.
  startQueue = startQueue.then(
    () =>
      new Promise((r) => setTimeout(() => (start(), r()), START_STAGGER_MS)),
  );
}

function deactivate(tile) {
  if (!tile.active) return;
  tile.active = false;
  clearInterval(tile.timer);
  clearTimeout(tile.timer);
  tile.playback?.dispose();
  tile.playback = null;
  setState(tile, 'idle', 'หยุด (อยู่นอกจอ)');
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const tile = entry.target.__tile;
      if (entry.isIntersecting) activate(tile);
      else deactivate(tile);
    }
  },
  { rootMargin: '200px' },
);

function mountTile(camera) {
  const el = document.createElement('figure');
  el.className = 'tile';
  el.innerHTML =
    camera.feedType === 'hls'
      ? '<video muted playsinline autoplay></video>'
      : '<img alt="">';
  el.insertAdjacentHTML(
    'beforeend',
    '<span class="state"></span><figcaption class="label"><span class="name"></span></figcaption>',
  );
  el.querySelector('.name').textContent = camera.name;
  if (camera.near) {
    const near = document.createElement('span');
    near.className = 'near';
    near.textContent = camera.near;
    el.querySelector('.label').append(near);
  }
  el.addEventListener('click', () => el.classList.toggle('zoomed'));
  const video = el.querySelector('video');
  const tile = { el, camera, state: 'idle', active: false };
  video?.addEventListener('playing', () => setState(tile, 'live', '● LIVE'));
  el.__tile = tile;
  grid.append(el);
  observer.observe(el);
  return tile;
}

/** Cameras near stations at level 4+, plus BMA's canal-gauge cameras. */
function floodZoneCameras() {
  const high = stations.filter((s) => !s.stale && s.level >= FLOOD_LEVEL);
  const picked = new Map();
  for (const cam of cameras) {
    if (cam.provider?.startsWith('BMA DDS')) {
      picked.set(cam.id, { ...cam, near: 'กล้องวัดระดับน้ำของ กทม.', rank: 0 });
      continue;
    }
    for (const st of high) {
      const d = distanceM(st.lat, st.lon, cam.lat, cam.lon);
      if (d > FLOOD_RADIUS_M) continue;
      const prev = picked.get(cam.id);
      if (prev && prev.rank <= d) continue;
      picked.set(cam.id, {
        ...cam,
        rank: d,
        near: `ห่าง ${st.name} ${(d / 1000).toFixed(1)} กม. · ${st.levelText} ${Math.round(st.storagePercent)}%`,
      });
    }
  }
  return [...picked.values()].sort((a, b) => a.rank - b.rank);
}

function render() {
  for (const t of tiles) {
    observer.unobserve(t.el);
    deactivate(t);
  }
  grid.textContent = '';
  const mode = modeSelect.value;
  let list;
  if (mode === 'flood') {
    list = floodZoneCameras();
    const high = stations.filter((s) => !s.stale && s.level >= FLOOD_LEVEL);
    note.textContent = high.length
      ? `สถานีน้ำสูงทั่วประเทศ ${high.length} แห่ง — แสดงกล้องสดที่อยู่ในรัศมี ${FLOOD_RADIUS_M / 1000} กม. จากสถานีเหล่านั้น (${list.length} กล้อง) กล้องจราจรอยู่บนถนนใหญ่ ไม่ได้ส่องแม่น้ำหรือคลองโดยตรง`
      : 'ตอนนี้ไม่มีสถานีวัดน้ำที่ระดับ 4–5 — แสดงเฉพาะกล้องวัดระดับน้ำของ กทม.';
  } else {
    list = mode === 'all' ? cameras : cameras.filter((c) => c.city === mode);
    note.textContent = '';
  }
  tiles = list.map(mountTile);
  renderSummary();
}

async function main() {
  const [sourcesRes, waterRes] = await Promise.all([
    fetch('/api/cctv/sources'),
    fetch('/api/bkk/water').catch(() => null),
  ]);
  const payload = await sourcesRes.json();
  cameras = (payload.sources || payload)
    .filter(
      (c) =>
        c.feedType === 'hls' ||
        c.provider?.startsWith('BMA DDS') ||
        c.sourceKind === 'egat-dam',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));
  stations = waterRes?.ok ? (await waterRes.json()).stations || [] : [];

  const byCity = new Map();
  for (const c of cameras) byCity.set(c.city, (byCity.get(c.city) || 0) + 1);
  const options = [
    ['flood', '🌊 ใกล้จุดน้ำสูง'],
    ['Bangkok', `กรุงเทพมหานคร (${byCity.get('Bangkok') || 0})`],
    ...[...byCity]
      .filter(([city]) => city !== 'Bangkok')
      .sort((a, b) => b[1] - a[1])
      .map(([city, n]) => [city, `${city} (${n})`]),
    ['all', `ทั้งประเทศ (${cameras.length})`],
  ];
  for (const [value, label] of options)
    modeSelect.append(new Option(label, value));
  const wanted = new URLSearchParams(location.search).get('mode');
  modeSelect.value = options.some(([v]) => v === wanted) ? wanted : 'flood';
  modeSelect.addEventListener('change', () => {
    history.replaceState(
      null,
      '',
      `?mode=${encodeURIComponent(modeSelect.value)}`,
    );
    render();
  });
  render();
}

addEventListener('pagehide', () => tiles.forEach(deactivate));
main().catch((e) => {
  summary.textContent = `โหลดรายชื่อกล้องไม่สำเร็จ: ${e.message}`;
});
