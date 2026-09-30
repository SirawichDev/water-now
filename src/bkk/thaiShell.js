// bkk-watch "simple mode" shell: what a first-time visitor in Thailand needs —
// how many rivers/canals are over their banks right now, where, and the data
// to decide whether to go there. It sits over the GEV map and drives its
// camera and layers; GEV's own operator interface stays one tap away
// (โหมดขั้นสูง in the menu).
import * as Cesium from 'cesium';
import { subscribeBkkUpdates } from '../layers/bkk/source.js';
import { el, distanceM, clock, dayClock, ago, placeLine } from './dom.js';
import { createMapOverlay } from './mapOverlay.js';
import { createFlowOverlay } from './flowOverlay.js';
import { renderDetail } from './thaiDetail.js';
import { createDock } from './thaiDock.js';
import {
  overMetres,
  bubbleRadius,
  trendCounts,
  frameAt,
  tankFill,
  circleRadius,
  TANK_MIN_RADIUS,
  TANK_ZOOM_M,
} from './floodMath.js';
import {
  STATUS_LABEL,
  spotIcon,
  spotClass,
  nearestStation,
  spotAt,
  placeOf,
  foodStatuses,
  sortSpots,
  spotCounts,
} from './folk.js';
import { createFolkRow, createSpotCard } from './folkUi.js';
import { openReportSheet } from './reportSheet.js';

const MODE_KEY = 'bkkwatch:mode';
const THEME_KEY = 'bkkwatch:theme';
const FOLK_KEY = 'bkkwatch:folk';
const FLOW_KEY = 'bkkwatch:flow';
const PARKED_KEY = 'bkkwatch:parked';
const SPOT_GAUGE_M = 10_000; // a spot is named after a gauge this close
const SPOT_ALERT_M = 5000; // …and shows its level when this close
const SPOT_DEPTH_M = 300;
const WAVE =
  '<svg viewBox="0 0 240 8" preserveAspectRatio="none"><path d="M0 4 Q15 0 30 4 T60 4 T90 4 T120 4 T150 4 T180 4 T210 4 T240 4 V8 H0Z"/></svg>';
const NEAR_ME_RADIUS_M = 80_000;
const COUNTRY_HEIGHT_M = 700_000; // above this the map shows province pills
const CITY_HEIGHT_M = 400_000; // below this news zones and reports are shown

const LAYER_CHIPS = [
  { id: 'bkk-water', label: 'ระดับน้ำ', color: '#D92D20' },
  { id: 'bkk-news', label: 'ข่าวน้ำท่วม', color: '#0BA5EC' },
  { id: 'bkk-cams', label: 'กล้องสด', color: '#475467' },
  { id: 'bkk-outages', label: 'ดับไฟตามแผน', color: '#9E77ED' },
];

/** Headline numbers from the station list; stale readings are not counted. */
export function summarize(stations) {
  const fresh = stations.filter((s) => !s.stale);
  const over = fresh.filter((s) => s.level >= 5);
  const near = fresh.filter((s) => s.level === 4);
  return {
    reporting: fresh.length,
    over,
    near,
    overProvinces: new Set(over.map((s) => s.province).filter(Boolean)).size,
  };
}

/** Provinces ranked by over-bank count, then near-bank: [{ name, over, near, lat, lon }] */
export function rankProvinces(stations) {
  const by = new Map();
  for (const s of stations) {
    if (s.stale || s.level < 4 || !s.province) continue;
    const p = by.get(s.province) || {
      name: s.province,
      over: 0,
      near: 0,
      lat: 0,
      lon: 0,
      n: 0,
    };
    if (s.level >= 5) {
      p.over++;
      p.lat += s.lat;
      p.lon += s.lon;
      p.n++;
    } else p.near++;
    by.set(s.province, p);
  }
  return [...by.values()]
    .map((p) => ({
      ...p,
      lat: p.n ? p.lat / p.n : null,
      lon: p.n ? p.lon / p.n : null,
    }))
    .sort((a, b) => b.over - a.over || b.near - a.near);
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

export function mountThaiShell({
  viewer,
  dataManager,
  hud,
  mapStackController,
}) {
  const root = document.documentElement;
  const isPhone = () => matchMedia('(max-width: 820px)').matches;
  const state = {
    stations: [],
    updatedAt: null,
    error: null,
    news: [],
    outages: [],
    reports: [],
    levels: [],
    spots: [], // trash and food, one per place
    choices: {},
    folk: { trash: true, food: true, depth: true }, // resident layers shown
    places: [], // places to eat around the selected gauge
    spot: null, // { kind, lat, lon, place? }: the spot whose card is open
    cams: null,
    tab: 'over',
    province: '',
    me: null,
    anchor: null, // { name, lat, lon }: "near this gauge" listing
    selectedId: null,
    allProvinces: false,
    base: 'osm',
    theme: 'light',
    replay: null, // hour index into the timeline, or null for "now"
    flow: false, // dots running along rivers; off until switched on
  };
  let detail = null;
  const overlay = createMapOverlay({ viewer });
  const flow = createFlowOverlay({ viewer });
  // The river or canal each gauge stands on, as far as it has been asked for.
  const riverMemo = new Map(); // station id → { rivers, full, at }
  /**
   * A gauge's river lines, or null while unknown. `full` lets the service
   * ask OpenStreetMap; without it only an answer it already holds comes back.
   */
  function riverOf(st, full) {
    const hit = riverMemo.get(st.id);
    const settled =
      hit &&
      (hit.rivers || (Date.now() - hit.at < 5 * 60_000 && (hit.full || !full)));
    if (!settled) {
      riverMemo.set(st.id, { rivers: null, full, at: Date.now() });
      getJson(
        `/api/bkk/river?lat=${st.lat}&lon=${st.lon}${full ? '' : '&cached=1'}`,
      )
        .then((d) => {
          if (!d.rivers?.length) return;
          riverMemo.set(st.id, { rivers: d.rivers, full, at: Date.now() });
          syncOverlay();
        })
        .catch(() => {});
    }
    return riverMemo.get(st.id).rivers;
  }
  // The dark theme on a wide screen is a three-column dashboard: summary on
  // the left, list or gauge detail on the right, the map between them.
  const isDash = () =>
    state.theme === 'dark' && matchMedia('(min-width: 1100px)').matches;

  // ── Camera ──────────────────────────────────────────────────────────────
  const down = { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 };
  const flyThailand = (duration = 1.2) =>
    viewer.camera.flyTo({
      // Thailand is 97–106°E, 5.5–20.5°N. Shift the look-at so the country
      // clears the summary panel (left on desktop, bottom on phones).
      destination: isPhone()
        ? Cesium.Cartesian3.fromDegrees(101.3, 3.4, 3_900_000)
        : isDash()
          ? Cesium.Cartesian3.fromDegrees(102.4, 11.9, 3_300_000)
          : Cesium.Cartesian3.fromDegrees(98.2, 12.3, 2_650_000),
      orientation: down,
      duration,
    });
  const flyToPoint = (lat, lon, height = 9000) =>
    viewer.camera.flyTo({
      // Offset so the point lands in the visible part of the map.
      destination: Cesium.Cartesian3.fromDegrees(
        lon - (isPhone() || isDash() ? 0 : height / 520_000),
        // Phones have the sheet below the map, desktops the replay dock.
        lat - height / (isPhone() ? 290_000 : 900_000),
        height,
      ),
      orientation: down,
      duration: 1.2,
    });
  const flyToStations = (list) => {
    if (!list.length) return;
    const lats = list.map((s) => s.lat);
    const lons = list.map((s) => s.lon);
    const spanLat = Math.max(0.25, Math.max(...lats) - Math.min(...lats));
    const spanLon = Math.max(0.25, Math.max(...lons) - Math.min(...lons));
    // Pad each side by what covers it: the sheet below on phones, the panel
    // on the left on desktop, columns on both sides in the dashboard.
    const pad = isPhone()
      ? { w: 0.2, s: 1.6, e: 0.25 }
      : isDash()
        ? { w: 0.9, s: 0.7, e: 1.1 }
        : { w: 1.1, s: 0.55, e: 0.25 };
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        Math.min(...lons) - spanLon * pad.w,
        Math.min(...lats) - spanLat * pad.s,
        Math.max(...lons) + spanLon * pad.e,
        Math.max(...lats) + spanLat * 0.25,
      ),
      duration: 1.2,
    });
  };
  const zoom = (factor) => {
    const h = viewer.camera.positionCartographic.height;
    if (factor < 1) viewer.camera.zoomIn(h * (1 - factor));
    else viewer.camera.zoomOut(h * (factor - 1));
  };

  // ── Base map: muted streets so only flood colour carries meaning ────────
  function styleBase() {
    const simple = root.classList.contains('th-simple');
    const mute = simple && state.base === 'osm';
    const dark = mute && state.theme === 'dark';
    const layers = viewer.imageryLayers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers.get(i);
      layer.saturation = dark ? 0.45 : mute ? 0.28 : 1;
      layer.brightness = mute && !dark ? 1.07 : 1;
      // Cesium mixes each pixel with mid-grey by `contrast`, so a negative
      // value inverts the tiles: the light street map becomes a dark one.
      // Inverting also flips every hue, which the half-turn puts back.
      layer.contrast = dark ? -0.82 : mute ? 0.94 : 1;
      layer.hue = dark ? Math.PI : 0;
    }
    root.dataset.thBase = state.base;
    viewer.scene.requestRender();
  }
  viewer.imageryLayers.layerAdded.addEventListener(styleBase);

  // ── Top bar ─────────────────────────────────────────────────────────────
  const livePill = el(
    'span',
    { class: 'th-live' },
    el('i'),
    el('span', { text: 'กำลังโหลด…' }),
  );
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'ค้นหาจังหวัด อำเภอ หรือแม่น้ำ',
    'aria-label': 'ค้นหาจังหวัด อำเภอ หรือแม่น้ำ',
    autocomplete: 'off',
    oninput: () => renderSearch(),
    onfocus: () => renderSearch(),
  });
  const searchResults = el('div', { class: 'th-results', hidden: true });
  const search = el(
    'div',
    { class: 'th-search' },
    el('img', {
      src: 'https://api.iconify.design/material-symbols/search-rounded.svg?color=%2315202B',
      alt: '',
    }),
    searchInput,
    searchResults,
  );

  const chips = el('div', {
    class: 'th-chips',
    role: 'group',
    'aria-label': 'ชั้นข้อมูลบนแผนที่',
  });
  const chipButtons = new Map();
  const layerOn = (id) => Boolean(dataManager.layers.get(id)?.enabled);
  for (const chip of LAYER_CHIPS) {
    const b = el(
      'button',
      {
        class: 'th-chip',
        type: 'button',
        style: `--chip:${chip.color}`,
        'aria-pressed': 'false',
        onclick: () => dataManager.setEnabled(chip.id, !layerOn(chip.id)),
      },
      el('i'),
      chip.label,
    );
    chipButtons.set(chip.id, b);
    chips.append(b);
  }
  // The outage chip carries the number of announcements, so "none right now"
  // does not look like a layer that failed to load.
  const outageCount = el('em');
  chipButtons.get('bkk-outages').append(outageCount);
  // Simple mode shows only the layers its chips control. Anything else that
  // is on belongs to advanced mode (its cameras with their "CAM-…" labels,
  // weather, wind): the saved address switches those back on a moment after
  // start-up, with no control here to switch them off. They are parked while
  // simple mode shows and put back on the way to advanced mode; the list is
  // kept across reloads.
  const OWN_LAYERS = new Set(LAYER_CHIPS.map((chip) => chip.id));
  const parked = new Set();
  try {
    for (const id of JSON.parse(localStorage.getItem(PARKED_KEY)) || [])
      parked.add(id);
  } catch {
    /* nothing parked */
  }
  const saveParked = () => {
    try {
      localStorage.setItem(PARKED_KEY, JSON.stringify([...parked]));
    } catch {
      /* private mode: advanced mode just starts with its layers off */
    }
  };
  // Switching a layer off notifies the listeners before the layer reads as
  // off, so each request is made once and remembered until it settles.
  // A layer that will not switch off is left alone after a few tries.
  const parking = new Set();
  const parkTries = new Map();
  function parkAdvancedLayers() {
    if (!root.classList.contains('th-simple')) return;
    for (const [id, layer] of dataManager.layers) {
      if (OWN_LAYERS.has(id) || !layer?.enabled || parking.has(id)) continue;
      const tries = (parkTries.get(id) || 0) + 1;
      if (tries > 3) continue;
      parkTries.set(id, tries);
      parking.add(id);
      parked.add(id);
      saveParked();
      Promise.resolve(dataManager.setEnabled(id, false))
        .catch(() => {})
        .finally(() => parking.delete(id));
    }
  }
  function unparkAdvancedLayers() {
    for (const id of parked)
      Promise.resolve(dataManager.setEnabled(id, true)).catch(() => {});
    parked.clear();
    saveParked();
  }
  const syncChips = () => {
    parkAdvancedLayers();
    for (const [id, b] of chipButtons)
      b.setAttribute('aria-pressed', String(layerOn(id)));
    syncOverlay();
  };
  dataManager.subscribe?.(syncChips);

  const nearBtn = el(
    'button',
    { class: 'th-cta', type: 'button', onclick: locateMe },
    el('img', {
      src: 'https://api.iconify.design/lucide/locate.svg?color=%23ffffff',
      alt: '',
    }),
    el('span', { text: 'น้ำใกล้ฉัน' }),
  );
  const themeButtons = {
    light: el('button', {
      type: 'button',
      text: 'สว่าง',
      onclick: () => setTheme('light'),
    }),
    dark: el('button', {
      type: 'button',
      text: 'มืด',
      onclick: () => setTheme('dark'),
    }),
  };
  const themeSeg = el(
    'div',
    { class: 'th-theme', role: 'group', 'aria-label': 'โทนสี' },
    themeButtons.light,
    themeButtons.dark,
  );
  const themeMenuItem = el('button', {
    type: 'button',
    onclick: () => setTheme(state.theme === 'dark' ? 'light' : 'dark'),
  });
  // Phones have no dock, so the switch for the river dots is here too.
  const flowMenuItem = el('button', { type: 'button', onclick: toggleFlow });
  const menu = el(
    'nav',
    { class: 'th-menu', hidden: true },
    el(
      'a',
      { href: '/bkk-cams.html' },
      'ผนังกล้องสด',
      el('small', { text: 'ดูทุกกล้องพร้อมกัน' }),
    ),
    el(
      'a',
      { href: '/bkk-news.html' },
      'ข่าวทั้งหมด',
      el('small', { text: 'แยกตามโซน' }),
    ),
    el('hr'),
    themeMenuItem,
    flowMenuItem,
    el(
      'button',
      { type: 'button', onclick: () => setMode('advanced') },
      'โหมดขั้นสูง',
      el('small', { text: 'แผนที่ 3 มิติเต็มรูปแบบ' }),
    ),
  );
  const menuBtn = el(
    'button',
    {
      class: 'th-iconbtn',
      type: 'button',
      'aria-label': 'เมนู',
      'aria-expanded': 'false',
      onclick: () => {
        menu.hidden = !menu.hidden;
        menuBtn.setAttribute('aria-expanded', String(!menu.hidden));
      },
    },
    el('img', {
      src: 'https://api.iconify.design/material-symbols/menu-rounded.svg?color=%2315202B',
      alt: '',
    }),
  );
  const bar = el(
    'header',
    { id: 'th-bar', class: 'th-shell th-only' },
    el('div', { class: 'th-brand', text: 'น้ำท่วมตอนนี้' }),
    livePill,
    search,
    chips,
    themeSeg,
    nearBtn,
    menuBtn,
    menu,
  );

  // ── Panel ───────────────────────────────────────────────────────────────
  const main = el('div', { class: 'th-main' });
  // The dashboard's last card: one gauge in figures (see renderFocus).
  const focus = el('div', { class: 'th-focus' });
  // Rain forecasts by gauge, shared by the dock and that card.
  const rainCache = new Map(); // station id → { at, promise }
  const rainFor = (st) => {
    const hit = rainCache.get(st.id);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.promise;
    const promise = getJson(`/api/bkk/rain?lat=${st.lat}&lon=${st.lon}`)
      .then((rain) => (rain.hours ? rain : null))
      .catch(() => null);
    rainCache.set(st.id, { at: Date.now(), promise });
    return promise;
  };
  const list = el('div', { class: 'th-listview' });
  const side = el('div', { class: 'th-side' }, list);
  const panel = el(
    'section',
    {
      id: 'th-panel',
      class: 'th-shell th-only',
      'data-sheet': 'half',
      'data-view': 'overview',
      'aria-label': 'สรุปสถานการณ์น้ำ',
    },
    el('button', {
      class: 'th-handle',
      type: 'button',
      'aria-label': 'ย่อ/ขยายแผงข้อมูล',
      onclick: () => {
        const order = ['peek', 'half', 'full'];
        panel.dataset.sheet =
          order[(order.indexOf(panel.dataset.sheet) + 1) % 3];
        setTimeout(syncBounds, 250);
      },
    }),
    main,
    side,
  );

  // ── Map chrome: zoom, base map, legend ──────────────────────────────────
  const baseButtons = {
    osm: el('button', {
      type: 'button',
      text: 'แผนที่',
      onclick: () => pickBase('osm'),
    }),
    'esri-imagery': el('button', {
      type: 'button',
      text: 'ดาวเทียม',
      onclick: () => pickBase('esri-imagery'),
    }),
  };
  /** A tap on one of the two buttons: a fresh choice, so retries start over. */
  function pickBase(id) {
    reasserted = 0;
    setBase(id);
  }
  function setBase(id) {
    state.base = id;
    for (const [key, b] of Object.entries(baseButtons))
      b.setAttribute('aria-pressed', String(key === id));
    Promise.resolve(mapStackController?.setStack(id, { silent: true }))
      .catch(() => {})
      .finally(styleBase);
  }
  // Simple mode owns the base map. GEV restores its own choice from the page
  // address a moment after start-up (`map=photoreal`), which would leave a
  // third map showing under these two buttons, so the chosen one is put
  // back. Only a few times: a base map that cannot load must not fight the
  // controller's fallback forever.
  let reasserted = 0;
  mapStackController?.subscribe?.((stack) => {
    if (!root.classList.contains('th-simple')) return;
    if (stack.activeId === state.base || stack.switchOrigin !== 'manual')
      return;
    if (reasserted++ < 5) setBase(state.base);
  });
  const chrome = el(
    'div',
    { class: 'th-shell th-only th-chrome' },
    el(
      'div',
      { class: 'th-zoom' },
      el('button', {
        type: 'button',
        'aria-label': 'ซูมเข้า',
        text: '+',
        onclick: () => zoom(0.55),
      }),
      el('button', {
        type: 'button',
        'aria-label': 'ซูมออก',
        text: '−',
        onclick: () => zoom(1.8),
      }),
    ),
    el(
      'div',
      { class: 'th-seg', role: 'group', 'aria-label': 'ชนิดแผนที่' },
      ...Object.values(baseButtons),
    ),
  );
  const back = el('button', {
    id: 'th-back',
    class: 'th-advanced-only',
    type: 'button',
    text: '← กลับโหมดดูน้ำท่วม',
    onclick: () => setMode('simple'),
  });
  // Lifts the inverted street map from black to navy (dark theme only).
  const mapTint = el('div', { class: 'th-maptint th-only' });
  const dock = createDock({ onIndex: setReplay, onFlow: toggleFlow });
  const folkRow = createFolkRow({ onToggle: toggleFolk, onReport: reportHere });
  const spotCard = createSpotCard({ onSend: sendSpot, onClose: closeSpot });
  document.body.append(
    mapTint,
    bar,
    panel,
    chrome,
    folkRow.el,
    spotCard.el,
    dock.el,
    back,
  );

  addEventListener('click', (e) => {
    if (!search.contains(e.target)) searchResults.hidden = true;
    if (!menu.contains(e.target) && !menuBtn.contains(e.target)) {
      menu.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // ── Behaviour ───────────────────────────────────────────────────────────
  function refreshGevLabels() {
    // The water and news layers skip GEV's dark labels in simple mode.
    for (const id of ['bkk-water', 'bkk-news'])
      if (layerOn(id)) dataManager.layers.get(id)?.module?.update?.(viewer);
  }

  function setMode(mode) {
    const simple = mode !== 'advanced';
    root.classList.toggle('th-simple', simple);
    try {
      localStorage.setItem(MODE_KEY, simple ? 'simple' : 'advanced');
    } catch {
      /* private mode: the choice just does not persist */
    }
    hud?.setMode(simple ? 'off' : 'auto');
    menu.hidden = true;
    if (simple) parkAdvancedLayers();
    else unparkAdvancedLayers();
    // Advanced mode may have switched the map; simple mode shows its own.
    if (simple && mapStackController?.getActiveId?.() !== state.base)
      pickBase(state.base);
    if (!simple && state.replay != null) {
      dock.pause();
      setReplay(null);
    }
    styleBase();
    refreshGevLabels();
    syncOverlay();
  }

  function setTheme(theme) {
    const wasDash = isDash();
    state.theme = theme === 'dark' ? 'dark' : 'light';
    root.dataset.thTheme = state.theme;
    try {
      localStorage.setItem(THEME_KEY, state.theme);
    } catch {
      /* private mode: the choice just does not persist */
    }
    for (const [key, b] of Object.entries(themeButtons))
      b.setAttribute('aria-pressed', String(key === state.theme));
    themeMenuItem.replaceChildren(
      state.theme === 'dark' ? 'โทนสว่าง' : 'โทนมืด',
      el('small', {
        text:
          state.theme === 'dark'
            ? 'พื้นขาว อ่านง่ายกลางแดด'
            : 'แผงข้อมูลบนพื้นมืด',
      }),
    );
    menu.hidden = true;
    styleBase();
    refreshGevLabels(); // the water dots are coloured per theme
    renderFocus();
    syncOverlay();
    syncBounds();
    // The dashboard frames the map differently, so re-centre the country view.
    if (wasDash !== isDash() && !state.selectedId && !state.province)
      flyThailand(0.6);
  }

  /** Dots along rivers, on or off: the dock legend and the menu both switch it. */
  function syncFlow() {
    dock.setFlow(state.flow);
    flowMenuItem.replaceChildren(
      'จุดวิ่งตามลำน้ำ',
      el('small', { text: state.flow ? 'เปิดอยู่' : 'ปิดอยู่' }),
    );
  }
  function toggleFlow() {
    state.flow = !state.flow;
    try {
      localStorage.setItem(FLOW_KEY, state.flow ? 'on' : 'off');
    } catch {
      /* private mode: the choice just does not persist */
    }
    menu.hidden = true;
    syncFlow();
    syncOverlay();
  }

  /** Show the map as it was at one hour of the timeline; null returns to now. */
  function setReplay(index) {
    state.replay = index;
    // The live dots would contradict the replayed ones.
    dataManager.layers.get('bkk-water')?.module?.setVisible?.(index == null);
    root.classList.toggle('th-replaying', index != null);
    syncOverlay();
  }

  function locateMe() {
    const label = nearBtn.lastChild;
    if (!navigator.geolocation) {
      label.textContent = 'อุปกรณ์นี้ไม่รองรับตำแหน่ง';
      return;
    }
    label.textContent = 'กำลังหาตำแหน่ง…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        Object.assign(state, {
          me: { lat: pos.coords.latitude, lon: pos.coords.longitude },
          anchor: null,
          province: '',
          selectedId: null,
        });
        label.textContent = 'น้ำใกล้ฉัน';
        showOverview();
        flyToPoint(state.me.lat, state.me.lon, 140_000);
      },
      () => {
        label.textContent = 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง';
        setTimeout(() => (label.textContent = 'น้ำใกล้ฉัน'), 3000);
      },
      { timeout: 10_000, maximumAge: 300_000 },
    );
  }

  /** Stations for the current tab/filter, worst first (or nearest first). */
  function visible() {
    const fresh = state.stations.filter((s) => !s.stale);
    const origin = state.me || state.anchor;
    if (origin)
      return fresh
        .filter((s) => s.level >= 4)
        .map((s) => ({
          ...s,
          distM: distanceM(origin.lat, origin.lon, s.lat, s.lon),
        }))
        .filter((s) => s.distM <= NEAR_ME_RADIUS_M)
        .sort((a, b) => a.distM - b.distM);
    return fresh
      .filter((s) => (state.tab === 'over' ? s.level >= 5 : s.level === 4))
      .filter((s) => !state.province || s.province === state.province)
      .sort((a, b) => b.storagePercent - a.storagePercent);
  }

  async function loadCams() {
    state.cams ??= await fetch('/api/cctv/sources')
      .then((r) => r.json())
      .then((d) =>
        (d.sources || []).filter(
          (c) => c.feedType === 'hls' || c.sourceKind === 'egat-dam',
        ),
      )
      .catch(() => []);
  }

  function select(id, { fly = true } = {}) {
    const st = state.stations.find((s) => s.id === id);
    if (!st) return;
    state.selectedId = id;
    state.places = [];
    detail = renderDetail(st, {
      data: () => ({ ...state, cams: state.cams || [] }),
      onBack: () => {
        state.selectedId = null;
        showOverview();
      },
      onNearby: (s) => {
        Object.assign(state, {
          anchor: { name: s.name, lat: s.lat, lon: s.lon },
          me: null,
          province: '',
          selectedId: null,
        });
        showOverview();
        flyToPoint(s.lat, s.lon, 160_000);
      },
      onReport: (s) => openReport({ lat: s.lat, lon: s.lon }, `ใกล้ ${s.name}`),
      onSpot: (spot) => openSpot(spot),
      // Camera and news open their player over the map, at their place.
      onCamera: (camera) =>
        showOnMap('bkk-cams', camera, 4000, 'bkk:open-camera', { camera }),
      onNews: (zone) =>
        showOnMap(
          'bkk-news',
          state.news.find((n) => n.zone === zone && n.lat != null),
          9000,
          'bkk:open-news',
          { zone },
        ),
      onPlaces: (places) => {
        if (state.selectedId !== id) return;
        state.places = places;
        syncOverlay();
        refreshSpot();
      },
    });
    side.replaceChildren(detail.el);
    panel.dataset.view = 'detail';
    loadCams().then(() => detail?.refresh());
    dock.setRain(null);
    rainFor(st).then((rain) => {
      if (state.selectedId === id && rain)
        dock.setRain({ ...rain, name: st.name });
    });
    renderFocus();
    if (fly) flyToPoint(st.lat, st.lon);
    if (isPhone()) panel.dataset.sheet = 'full';
    syncOverlay();
    setTimeout(syncBounds, 300);
  }

  /** Turn a layer on, open its player and bring its point into view. */
  function showOnMap(layerId, at, height, event, detail) {
    if (!layerOn(layerId)) dataManager.setEnabled(layerId, true);
    // A full-height sheet would hide the map the player belongs to.
    if (isPhone()) panel.dataset.sheet = 'half';
    dispatchEvent(new CustomEvent(event, { detail }));
    if (at) flyClearOfPlayers(at.lat, at.lon, height);
  }

  /**
   * Fly so the point lands in the part of the map the open players leave
   * free: beside them when there is room, otherwise above them.
   */
  function flyClearOfPlayers(lat, lon, height) {
    if (isPhone()) return flyToPoint(lat, lon, height);
    const top = bar.getBoundingClientRect().bottom + 64;
    const bottom = dock.el.getBoundingClientRect().top || innerHeight;
    const left = (isDash() ? main : panel).getBoundingClientRect().right;
    const right = isDash() ? side.getBoundingClientRect().left : innerWidth;
    const players = [...document.querySelectorAll('.bkk-news-panel')]
      .filter((n) => !n.hidden)
      .map((n) => n.getBoundingClientRect());
    const edge = Math.min(right, ...players.map((r) => r.left));
    const roof = Math.min(bottom, ...players.map((r) => r.top));
    const beside = edge - left >= 160;
    const x = beside ? (left + edge) / 2 : (left + right) / 2;
    const y = beside ? (top + bottom) / 2 : (top + roof) / 2;
    // Cesium's field of view spans the longer side of the window.
    const fov = viewer.camera.frustum.fov ?? Math.PI / 3;
    const mPerPx =
      (2 * height * Math.tan(fov / 2)) / Math.max(innerWidth, innerHeight);
    return viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        lon +
          ((innerWidth / 2 - x) * mPerPx) /
            (111_320 * Math.cos(Cesium.Math.toRadians(lat))),
        lat + ((y - innerHeight / 2) * mPerPx) / 110_540,
        height,
      ),
      orientation: down,
      duration: 1.2,
    });
  }

  function showOverview() {
    detail = null;
    state.places = [];
    side.replaceChildren(list);
    panel.dataset.view = 'overview';
    dock.setRain(null);
    if (isPhone() && panel.dataset.sheet === 'full')
      panel.dataset.sheet = 'half';
    render();
    setTimeout(syncBounds, 300);
  }

  function setProvince(name) {
    Object.assign(state, {
      province: name,
      me: null,
      anchor: null,
      selectedId: null,
    });
    showOverview();
    if (name) {
      const inProvince = state.stations.filter(
        (s) => s.province === name && !s.stale,
      );
      const alert = inProvince.filter((s) => s.level >= 4);
      flyToStations(alert.length ? alert : inProvince);
    } else flyThailand();
  }

  function renderSearch() {
    const q = searchInput.value.trim().replace(/\s+/g, '');
    if (!q) {
      searchResults.hidden = true;
      return;
    }
    const has = (s) =>
      String(s || '')
        .replace(/\s+/g, '')
        .includes(q);
    const provinces = rankProvinces(state.stations)
      .filter((p) => has(p.name))
      .slice(0, 4);
    const stations = state.stations
      .filter(
        (s) => !s.stale && (has(s.name) || has(s.district) || has(s.river)),
      )
      .sort((a, b) => b.level - a.level || b.storagePercent - a.storagePercent)
      .slice(0, 7);
    const pick = (fn) => () => {
      searchResults.hidden = true;
      searchInput.value = '';
      fn();
    };
    searchResults.replaceChildren(
      ...provinces.map((p) =>
        el(
          'button',
          { type: 'button', onclick: pick(() => setProvince(p.name)) },
          el('b', { text: `จ.${p.name}` }),
          el('small', { text: `ล้นตลิ่ง ${p.over} · ใกล้ล้น ${p.near}` }),
        ),
      ),
      ...stations.map((s) =>
        el(
          'button',
          { type: 'button', onclick: pick(() => select(s.id)) },
          el('b', { text: s.name }),
          el('small', {
            text: `${placeLine(s)} · ${s.levelText} ${Math.round(s.storagePercent)}%`,
          }),
        ),
      ),
      ...(provinces.length + stations.length
        ? []
        : [el('p', { text: 'ไม่พบจังหวัด อำเภอ หรือแม่น้ำที่ตรงกับคำค้น' })]),
    );
    searchResults.hidden = false;
  }

  function row(st) {
    const over = st.level >= 5;
    const arrow = st.changeM > 0 ? '▲' : st.changeM < 0 ? '▼' : '';
    return el(
      'li',
      {},
      el(
        'button',
        { class: 'th-row', type: 'button', onclick: () => select(st.id) },
        el('span', { class: 'th-name', text: st.name }),
        el(
          'span',
          { class: `th-pct ${over ? 'over' : 'near'}` },
          arrow
            ? el('i', {
                class: st.changeM > 0 ? 'up' : 'down',
                text: arrow,
                title: st.changeM > 0 ? 'กำลังขึ้น' : 'กำลังลด',
              })
            : null,
          `${Math.round(st.storagePercent)}%`,
        ),
        el('span', {
          class: 'th-where',
          text: [
            placeLine(st),
            st.distM != null
              ? `ห่าง ${(st.distM / 1000).toFixed(0)} กม.`
              : st.river,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
        el('span', { class: 'th-when', text: `${clock(st.observedAt)} น.` }),
        // Scale 0–167% so the bank (100%) sits at 60% of the bar.
        el(
          'span',
          { class: 'th-lv' },
          el('u', {
            class: over ? 'over' : 'near',
            style: `width:${Math.min(100, st.storagePercent * 0.6)}%`,
          }),
          el('s'),
        ),
      ),
    );
  }

  function render() {
    const sum = summarize(state.stations);
    livePill.lastChild.textContent = state.updatedAt
      ? `อัปเดต ${clock(state.updatedAt)} น.`
      : 'กำลังโหลด…';
    livePill.classList.toggle(
      'err',
      Boolean(state.error && !state.stations.length),
    );
    const trend = trendCounts(state.stations);
    dock.setLive({
      over: sum.over.length,
      near: sum.near.length,
      up: trend.up,
    });
    const ranked = rankProvinces(state.stations);
    // The bars are about over-bank water; near-only provinces stay in search.
    const provinces = ranked.filter((p) => p.over > 0);
    const maxOver = Math.max(1, ...provinces.map((p) => p.over));
    const current = ranked.find((p) => p.name === state.province);
    const origin = state.me || state.anchor;
    const rows = visible();
    const backLink = () =>
      el('button', {
        class: 'th-backlink',
        type: 'button',
        text: '← ทั้งประเทศ',
        onclick: () => setProvince(''),
      });

    const head = origin
      ? el(
          'div',
          { class: 'th-head' },
          backLink(),
          el('h1', {
            class: 'th-title',
            text: state.me ? 'ใกล้ตำแหน่งของฉัน' : `ใกล้ ${state.anchor.name}`,
          }),
          el('p', {
            class: 'th-also',
            text: `จุดน้ำล้นหรือใกล้ล้นตลิ่งในรัศมี ${NEAR_ME_RADIUS_M / 1000} กม. · ${rows.length} จุด`,
          }),
        )
      : state.province
        ? el(
            'div',
            { class: 'th-head' },
            backLink(),
            el('h1', { class: 'th-title', text: state.province }),
            el(
              'div',
              { class: 'th-nums' },
              el(
                'div',
                { class: 'o' },
                el('b', { text: String(current?.over || 0) }),
                'ล้นตลิ่ง',
              ),
              el(
                'div',
                { class: 'n' },
                el('b', { text: String(current?.near || 0) }),
                'ใกล้ล้น',
              ),
            ),
          )
        : el(
            'div',
            { class: 'th-head country' },
            // The dashboard shows this row in place of the headline below.
            el(
              'div',
              { class: 'th-stats' },
              el(
                'h2',
                {},
                'ประเทศไทย · ตอนนี้',
                el('em', {
                  text: state.updatedAt ? dayClock(state.updatedAt) : '',
                }),
              ),
              el(
                'div',
                {},
                el(
                  'div',
                  { class: 'o' },
                  el('b', { text: String(sum.over.length) }),
                  'จุดล้นตลิ่ง',
                ),
                el(
                  'div',
                  { class: 'n' },
                  el('b', { text: String(sum.near.length) }),
                  'ใกล้ล้น',
                ),
                el(
                  'div',
                  {},
                  el('b', { text: String(sum.reporting) }),
                  'สถานีรายงาน',
                ),
              ),
            ),
            el('p', {
              class: 'th-kicker',
              text: state.updatedAt
                ? `สถานการณ์ตอนนี้ · ${sum.reporting} สถานีรายงาน`
                : 'กำลังโหลดข้อมูลระดับน้ำ…',
            }),
            state.error && !state.stations.length
              ? el('h1', {
                  class: 'th-title',
                  text: 'ยังโหลดข้อมูลระดับน้ำไม่ได้',
                })
              : el(
                  'div',
                  { class: 'th-big' },
                  el('b', { text: String(sum.over.length) }),
                  el(
                    'span',
                    {},
                    'จุด น้ำล้นตลิ่ง',
                    el('small', { text: `ใน ${sum.overProvinces} จังหวัด` }),
                  ),
                ),
            el(
              'p',
              { class: 'th-also' },
              el('i'),
              'ใกล้ล้นตลิ่งอีก ',
              el('b', { text: `${sum.near.length} จุด` }),
            ),
          );

    const trendSec =
      origin || state.province || !sum.over.length
        ? null
        : el(
            'div',
            { class: 'th-trend' },
            el('h2', { text: 'แนวโน้มของจุดที่ล้นตลิ่ง' }),
            el(
              'div',
              {
                class: 'th-donut',
                // Share rising, then rising plus steady; the rest is falling.
                style: `--a:${((trend.up / sum.over.length) * 100).toFixed(1)}%;--b:${(((trend.up + trend.flat) / sum.over.length) * 100).toFixed(1)}%`,
              },
              el(
                'div',
                {},
                el('b', { text: String(sum.over.length) }),
                el('small', { text: 'จุด' }),
              ),
            ),
            el(
              'div',
              { class: 'th-trendcells' },
              el(
                'div',
                { class: 'up' },
                el('b', { text: `▲ ${trend.up}` }),
                'กำลังขึ้น',
              ),
              el('div', {}, el('b', { text: String(trend.flat) }), 'ทรงตัว'),
              el(
                'div',
                { class: 'down' },
                el('b', { text: `▼ ${trend.down}` }),
                'กำลังลด',
              ),
            ),
          );

    const shown = state.allProvinces ? provinces : provinces.slice(0, 5);
    const provinceSec =
      origin || state.province
        ? null
        : el(
            'div',
            { class: 'th-provs' },
            el(
              'h2',
              {},
              'จังหวัดที่ล้นตลิ่งมากที่สุด',
              provinces.length > 5
                ? el('button', {
                    type: 'button',
                    text: state.allProvinces
                      ? 'ย่อ'
                      : `ดูทั้ง ${provinces.length} จังหวัด`,
                    onclick: () => {
                      state.allProvinces = !state.allProvinces;
                      render();
                    },
                  })
                : null,
            ),
            el(
              'div',
              { class: 'th-provlist' },
              shown.map((p) =>
                el(
                  'button',
                  {
                    class: 'th-prov',
                    type: 'button',
                    onclick: () => setProvince(p.name),
                  },
                  el('span', { text: p.name }),
                  el(
                    'span',
                    { class: 'track' },
                    el('u', { style: `width:${(p.over / maxOver) * 100}%` }),
                  ),
                  el('b', { text: String(p.over) }),
                ),
              ),
            ),
          );

    const onFolk = state.tab === 'folk';
    const folk = scopedSpots();
    const tab = (id, label, selected = state.tab === id) =>
      el('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(selected),
        text: label,
        onclick: () => {
          state.tab = id;
          render();
        },
      });
    const overN = state.province ? current?.over || 0 : sum.over.length;
    const nearN = state.province ? current?.near || 0 : sum.near.length;

    main.replaceChildren(
      ...[head, trendSec, provinceSec, focus].filter(Boolean),
    );
    renderFocus();
    list.replaceChildren(
      el(
        'div',
        { class: 'th-tabs', role: 'tablist' },
        // Near a point the list is every alert gauge by distance: one tab.
        ...(origin
          ? [tab('over', `ระดับน้ำ ${rows.length}`, !onFolk)]
          : [
              tab('over', `ล้นตลิ่ง ${overN}`),
              tab('near', `ใกล้ล้น ${nearN}`),
            ]),
        tab('folk', `คนในพื้นที่ ${folk.length}`),
      ),
      onFolk
        ? folkList(folk)
        : el(
            'ul',
            { id: 'th-list', 'aria-label': 'สถานีวัดระดับน้ำ' },
            rows.length
              ? [
                  el('li', {
                    class: 'th-listnote',
                    text: 'ขีดดำบนแถบ = ระดับตลิ่ง',
                  }),
                  ...rows.slice(0, 150).map(row),
                ]
              : el('li', {
                  class: 'th-empty',
                  text: origin
                    ? 'ไม่พบจุดน้ำล้นหรือใกล้ล้นตลิ่งในรัศมี 80 กม.'
                    : state.stations.length
                      ? 'ไม่มีสถานีในกลุ่มนี้'
                      : 'กำลังโหลด…',
                }),
          ),
    );
    syncOverlay();
  }

  // ── Dashboard: one gauge in figures ─────────────────────────────────────
  /** The selected gauge, else the nearest or worst one in the current view. */
  function focusStation() {
    if (state.selectedId)
      return state.stations.find((s) => s.id === state.selectedId) || null;
    const alert = state.stations.filter((s) => !s.stale && s.level >= 4);
    const origin = state.me || state.anchor;
    if (origin)
      return nearestStation(alert, origin.lat, origin.lon, NEAR_ME_RADIUS_M);
    return (
      alert
        .filter((s) => !state.province || s.province === state.province)
        .sort((a, b) => b.storagePercent - a.storagePercent)[0] || null
    );
  }

  function renderFocus() {
    if (!isDash()) return;
    const st = focusStation();
    if (!st) {
      focus.replaceChildren(
        el('h2', { text: 'จุดที่หนักที่สุดตอนนี้' }),
        el('p', {
          text: state.stations.length
            ? 'ไม่มีจุดน้ำล้นหรือใกล้ล้นตลิ่งในกลุ่มนี้'
            : 'กำลังโหลด…',
        }),
      );
      return;
    }
    const selected = st.id === state.selectedId;
    const d = overMetres(st);
    const cm = Math.round(Math.abs(st.changeM || 0) * 100);
    const rainCell = el(
      'div',
      { class: 'rain' },
      el('b', { text: '—' }),
      'โอกาสฝน 6 ชม.',
    );
    focus.replaceChildren(
      el(
        'h2',
        {},
        selected
          ? 'จุดที่เลือก'
          : state.me || state.anchor
            ? 'จุดที่ใกล้ที่สุด'
            : 'จุดที่หนักที่สุดตอนนี้',
        el('em', { text: `${clock(st.observedAt)} น.` }),
      ),
      el('h3', { text: st.name }),
      el('p', { text: [placeLine(st), st.river].filter(Boolean).join(' · ') }),
      el(
        'div',
        { class: 'th-kv' },
        el(
          'div',
          { class: st.level >= 5 ? 'over' : 'near' },
          el('b', {
            text:
              d == null
                ? `${Math.round(st.storagePercent)}%`
                : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} ม.`,
          }),
          d == null ? 'ของตลิ่ง' : d >= 0 ? 'สูงกว่าตลิ่ง' : 'ต่ำกว่าตลิ่ง',
        ),
        el(
          'div',
          { class: st.changeM > 0 ? 'up' : st.changeM < 0 ? 'down' : '' },
          el('b', {
            text:
              st.changeM > 0
                ? `▲ ${cm} ซม.`
                : st.changeM < 0
                  ? `▼ ${cm} ซม.`
                  : 'ทรงตัว',
          }),
          'จากการวัดครั้งก่อน',
        ),
        el(
          'div',
          {},
          el('b', { text: `${Math.round(st.storagePercent)}%` }),
          'ของความลึกถึงตลิ่ง',
        ),
        rainCell,
      ),
      el('button', {
        class: 'th-btn',
        type: 'button',
        text: selected ? '← กลับไปภาพรวม' : 'ดูรายละเอียดและระดับน้ำบนถนน',
        onclick: () => {
          if (!selected) return select(st.id);
          state.selectedId = null;
          showOverview();
        },
      }),
      el('p', { text: 'วัดในแม่น้ำและคลอง ไม่ใช่ระดับน้ำบนถนน' }),
    );
    rainFor(st).then((rain) => {
      if (rain && rainCell.isConnected)
        rainCell.firstChild.textContent = `${rain.maxProb}%`;
    });
  }

  // ── Reports from people on the spot: trash and food ─────────────────────
  /** Trash and food spots inside the current filter, most urgent first. */
  function scopedSpots() {
    const origin = state.me || state.anchor;
    return sortSpots(state.spots).filter((s) => {
      if (origin)
        return (
          distanceM(origin.lat, origin.lon, s.lat, s.lon) <= NEAR_ME_RADIUS_M
        );
      // Reports carry no province; the nearest gauge's stands in for it.
      if (state.province)
        return (
          nearestStation(state.stations, s.lat, s.lon)?.province ===
          state.province
        );
      return true;
    });
  }

  function folkList(spots) {
    return el(
      'ul',
      { id: 'th-list', 'aria-label': 'รายงานจากคนในพื้นที่' },
      spots.map((s) => {
        const gauge = nearestStation(
          state.stations,
          s.lat,
          s.lon,
          SPOT_GAUGE_M,
        );
        return el(
          'li',
          {},
          el(
            'button',
            {
              class: 'th-row folk',
              type: 'button',
              onclick: () => openSpot(s, { fly: true }),
            },
            el('span', { class: `th-mk ${spotClass(s)}`, html: spotIcon(s) }),
            el('span', {
              class: 'th-name',
              text: gauge ? `ใกล้ ${gauge.name}` : 'จุดที่มีคนรายงาน',
            }),
            el('span', {
              class: `th-fstat ${spotClass(s)}`,
              // The marker already says it is trash.
              text: STATUS_LABEL[s.status].replace(/^ขยะ/, ''),
            }),
            el('span', {
              class: 'th-where',
              text: [gauge && placeLine(gauge), `${s.count} คนรายงาน`]
                .filter(Boolean)
                .join(' · '),
            }),
            el('span', { class: 'th-when', text: ago(s.createdAt) }),
          ),
        );
      }),
      el(
        'li',
        { class: 'th-empty' },
        el('p', {
          text: spots.length
            ? 'รายงานจากคนในพื้นที่ ยังไม่ได้ตรวจสอบ แต่ละรายงานอยู่บนแผนที่ 6 ชั่วโมง'
            : 'ยังไม่มีรายงานขยะลอยน้ำหรือที่ขายอาหารใน 6 ชั่วโมงที่ผ่านมา',
        }),
        el('button', {
          class: 'th-btn primary',
          type: 'button',
          text: 'รายงานจุดที่ฉันอยู่',
          onclick: reportHere,
        }),
      ),
    );
  }

  function toggleFolk(id) {
    state.folk[id] = !state.folk[id];
    try {
      localStorage.setItem(FOLK_KEY, JSON.stringify(state.folk));
    } catch {
      /* private mode: the choice just does not persist */
    }
    syncFolk();
    syncOverlay();
  }

  function syncFolk() {
    folkRow.sync(state.folk, {
      ...spotCounts(state.spots),
      depth: state.reports.length,
    });
  }

  function openReport(at, where) {
    openReportSheet({
      at,
      where,
      choices: state.choices,
      onSent: loadReports,
    });
  }

  /** Report at the visitor's own position. */
  function reportHere() {
    if (!navigator.geolocation) {
      folkRow.setBusy('อุปกรณ์นี้ไม่รองรับตำแหน่ง');
      return;
    }
    folkRow.setBusy('กำลังหาตำแหน่ง…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        folkRow.setBusy(null);
        const at = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const gauge = nearestStation(
          state.stations,
          at.lat,
          at.lon,
          SPOT_GAUGE_M,
        );
        openReport(
          at,
          `ตำแหน่งของคุณ${gauge ? ` · ใกล้ ${gauge.name}` : ''} · แม่นยำราว ${Math.round(pos.coords.accuracy)} ม.`,
        );
      },
      () => {
        folkRow.setBusy('ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง');
        setTimeout(() => folkRow.setBusy(null), 3000);
      },
      { timeout: 10_000, maximumAge: 60_000, enableHighAccuracy: true },
    );
  }

  /** What the card says about the open spot, from the latest data. */
  function spotView(sel) {
    const place =
      sel.place || (sel.kind === 'food' ? placeOf(sel, state.places) : null);
    const at = spotAt(state.spots, sel.kind, sel.lat, sel.lon);
    // A report next door is about the shop next door, not this one.
    const theirs = at && place ? placeOf(at, state.places) : null;
    const live =
      theirs && (theirs.lat !== place.lat || theirs.lon !== place.lon)
        ? null
        : at;
    const fresh = state.stations.filter((s) => !s.stale);
    const gauge = nearestStation(fresh, sel.lat, sel.lon, SPOT_GAUGE_M);
    const alert = nearestStation(
      fresh.filter((s) => s.level >= 4),
      sel.lat,
      sel.lon,
      SPOT_ALERT_M,
    );
    const depth = state.reports.find(
      (r) => distanceM(r.lat, r.lon, sel.lat, sel.lon) <= SPOT_DEPTH_M,
    );
    const trash = sel.kind === 'trash';
    const status = live?.status || (trash ? 'clear' : 'unknown');
    return {
      kind: sel.kind,
      status,
      title: place?.name || (gauge ? `ใกล้ ${gauge.name}` : 'จุดที่มีคนรายงาน'),
      where: place ? place.kindLabel : gauge ? placeLine(gauge) : '',
      sub: live
        ? `${live.count} คนรายงาน · ล่าสุด ${ago(live.createdAt)}`
        : trash
          ? 'ไม่มีรายงานขยะที่จุดนี้ในตอนนี้'
          : 'ตำแหน่งจาก OpenStreetMap',
      facts: [
        alert && {
          tone: alert.level >= 5 ? 'over' : 'near',
          text: `ระดับน้ำที่${alert.name} ${Math.round(alert.storagePercent)}% ของตลิ่ง${alert.changeM > 0 ? ' ▲ กำลังขึ้น' : alert.changeM < 0 ? ' ▼ กำลังลด' : ''}`,
        },
        depth && {
          text: `น้ำบนถนนใกล้จุดนี้ราว ${depth.cm} ซม. (${depth.label}) · ${ago(depth.createdAt)}`,
        },
      ].filter(Boolean),
      ask: trash ? 'ตอนนี้ยังเป็นอยู่ไหม' : 'ตอนนี้ยังขายอยู่ไหม',
      confirm: trash
        ? {
            id: status === 'clear' ? 'floating' : status,
            label: status === 'clear' ? 'มีขยะ' : 'ยังมีขยะ',
          }
        : { id: 'open', label: 'ยังเปิด' },
      deny: trash
        ? { id: 'clear', label: 'เก็บแล้ว' }
        : { id: 'closed', label: 'ปิดแล้ว' },
    };
  }

  function openSpot(spot, { fly = false } = {}) {
    spotCard.hide();
    state.spot = {
      kind: spot.kind,
      lat: spot.lat,
      lon: spot.lon,
      place: spot.place || null,
    };
    spotCard.show(spotView(state.spot));
    if (fly) flyToPoint(spot.lat, spot.lon, 6000);
    syncOverlay();
  }

  function closeSpot() {
    state.spot = null;
    spotCard.hide();
    syncOverlay();
  }

  const refreshSpot = () => state.spot && spotCard.show(spotView(state.spot));

  /** One tap on the card: confirm or contradict the spot's status. */
  async function sendSpot(choice) {
    const { kind, lat, lon } = state.spot;
    const res = await fetch('/api/bkk/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, answers: { [kind]: choice } }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'ส่งไม่สำเร็จ');
    await loadReports();
  }

  // ── Map markers ─────────────────────────────────────────────────────────
  /** The selected gauge's figure, hung from its point on a leader line. */
  function pinHtml(st) {
    const d = overMetres(st);
    const cm = Math.round(Math.abs(st.changeM || 0) * 100);
    const move =
      st.changeM > 0
        ? `▲ ${cm} ซม.`
        : st.changeM < 0
          ? `▼ ${cm} ซม.`
          : 'ทรงตัว';
    const figure =
      d == null
        ? `<b>${Math.round(st.storagePercent)}%</b><small>ของตลิ่ง</small>`
        : `<b>${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}</b><small>เมตร</small>`;
    const where = d == null ? '' : d >= 0 ? 'เหนือตลิ่ง · ' : 'ต่ำกว่าตลิ่ง · ';
    return `<i></i><span class="bd">${figure}</span><span class="tx"><b>${esc(st.name)}</b><small>${where}${move}</small></span>`;
  }

  function syncOverlay() {
    const simple = root.classList.contains('th-simple');
    const height = viewer.camera.positionCartographic.height;
    const replaying = simple && state.replay != null && dock.timeline;
    const water = simple && layerOn('bkk-water') && !replaying;
    const over = water
      ? state.stations.filter((s) => !s.stale && s.level >= 5)
      : [];

    // The replay draws its own hour: red circles over the bank, amber dots
    // near it. The live layers below stay empty while it runs.
    overlay.set(
      'replay',
      replaying && layerOn('bkk-water')
        ? frameAt(
            dock.timeline,
            state.replay,
            new Map(state.stations.map((s) => [s.id, s])),
          ).map((f) =>
            f.over
              ? {
                  id: f.id,
                  lat: f.lat,
                  lon: f.lon,
                  className: 'th-bub core',
                  style: `--r:${bubbleRadius(f.metres ?? 0.3, height).toFixed(1)}px`,
                }
              : { id: f.id, lat: f.lat, lon: f.lon, className: 'th-dot' },
          )
        : [],
    );

    // Circle size is metres over the bank; a solid circle is still rising.
    // Once a circle is big enough to read, it fills like a tank instead: the
    // water stands at the gauge's level against a dashed bank line, and its
    // surface creeps up or sinks with the latest change.
    // Zoomed in, the near-bank gauges become small amber tanks too: their
    // water stands under the bank line.
    const near =
      water && height < TANK_ZOOM_M
        ? state.stations.filter((s) => !s.stale && s.level === 4)
        : [];
    const radius = new Map([
      ...over.map((s) => [s.id, circleRadius(overMetres(s) ?? 0.3, height)]),
      ...near.map((s) => [s.id, TANK_MIN_RADIUS]),
    ]);
    const isTank = (s) => radius.get(s.id) >= TANK_MIN_RADIUS;
    overlay.set(
      'bubbles',
      [...near, ...over].map((s) => {
        const move = s.changeM > 0 ? ' up' : s.changeM < 0 ? ' down' : '';
        const tone = s.level >= 5 ? '' : ' near';
        return {
          id: s.id,
          lat: s.lat,
          lon: s.lon,
          className: isTank(s) ? `th-bub tank${tone}${move}` : `th-bub${move}`,
          style: `--r:${radius.get(s.id).toFixed(1)}px;--fill:${tankFill(s.storagePercent).toFixed(0)}%`,
          html: isTank(s) ? `<span><u>${WAVE}</u><s></s></span>` : '',
        };
      }),
    );

    // Dots run along the open gauge's river, and along the river of every
    // tank in view whose line the service already holds: fast where the
    // level is rising, slow where it is falling.
    const opened = simple
      ? state.stations.find((s) => s.id === state.selectedId)
      : null;
    const eye = viewer.camera.positionCartographic;
    const inView = (s) =>
      distanceM(
        Cesium.Math.toDegrees(eye.latitude),
        Cesium.Math.toDegrees(eye.longitude),
        s.lat,
        s.lon,
      ) <=
      height * 1.2;
    const flowing =
      water && state.flow && height < TANK_ZOOM_M
        ? [...new Set([opened, ...over, ...near].filter(Boolean))].filter(
            inView,
          )
        : [];
    flow.set(
      flowing.flatMap((s) =>
        (riverOf(s, s === opened) || []).map((river, i) => ({
          id: `${s.id}:${i}`,
          points: river.points,
          pace: s.changeM > 0 ? 'up' : s.changeM < 0 ? 'down' : 'flat',
        })),
      ),
    );

    // Ripples mark the worst gauges from afar and the rising ones up close;
    // a tank already shows its own movement.
    const rippling =
      height > COUNTRY_HEIGHT_M
        ? [...over]
            .sort((a, b) => b.storagePercent - a.storagePercent)
            .slice(0, 18)
        : over.filter((s) => s.changeM > 0 && !isTank(s));
    overlay.set(
      'ripples',
      rippling.map((s, i) => ({
        id: s.id,
        lat: s.lat,
        lon: s.lon,
        className: `th-rp${s.storagePercent >= 125 ? ' big' : ''}`,
        // Wider rings for more water over the bank; staggered starts.
        style: `--d:${((i * 37) % 28) / 10}s;--s:${(2.2 + Math.min(1.6, (s.storagePercent - 100) / 30)).toFixed(1)}`,
      })),
    );

    let pills = [];
    if (water && height > COUNTRY_HEIGHT_M)
      pills = rankProvinces(state.stations)
        .filter((p) => p.over > 0)
        .slice(0, 8)
        .map((p) => ({
          id: `p:${p.name}`,
          lat: p.lat,
          lon: p.lon,
          className: 'th-pill',
          html: `${esc(p.name)} <b>${p.over}</b>`,
          priority: p.over,
          collide: true,
          onClick: () => setProvince(p.name),
        }));
    else if (water)
      pills = [...over, ...near]
        // The selected gauge carries its own pin.
        .filter((s) => s.id !== state.selectedId)
        .map((s) => ({
          id: `s:${s.id}`,
          lat: s.lat,
          lon: s.lon,
          className: s.level >= 5 ? 'th-pill' : 'th-pill near',
          // The number keeps the bank's colour; the arrow says which way.
          html: `${esc(s.name)} <b>${Math.round(s.storagePercent)}%</b>${s.changeM > 0 ? '<i class="up">▲</i>' : s.changeM < 0 ? '<i class="down">▼</i>' : ''}`,
          priority: s.storagePercent,
          collide: true,
          onClick: () => select(s.id, { fly: false }),
        }));
    overlay.set('pills', pills);

    const zones = new Map();
    if (simple && layerOn('bkk-news'))
      for (const n of state.news) {
        if (n.lat == null) continue;
        const z = zones.get(n.zone) || {
          zone: n.zone,
          lat: n.lat,
          lon: n.lon,
          n: 0,
        };
        z.n++;
        zones.set(n.zone, z);
      }
    overlay.set(
      'news',
      [...zones.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, height > CITY_HEIGHT_M ? 2 : 40)
        .map((z) => ({
          id: z.zone,
          lat: z.lat,
          lon: z.lon,
          className: 'th-pill news',
          text: `${z.zone.replace(/^(แขวง|เขต)/, '')} · ข่าว ${z.n}`,
          priority: 200 + z.n,
          collide: true,
          onClick: () =>
            dispatchEvent(
              new CustomEvent('bkk:open-news', { detail: { zone: z.zone } }),
            ),
        })),
    );

    // What residents reported: trash in the water and food still on sale,
    // plus the unconfirmed places to eat around the open gauge.
    const folkOn = (id) => simple && !replaying && state.folk[id];
    const spotMarker = (spot, id) => ({
      id,
      lat: spot.lat,
      lon: spot.lon,
      className: `th-spot ${spotClass(spot)}`,
      html: spotIcon(spot),
      title: STATUS_LABEL[spot.status],
      onClick: () => openSpot(spot),
    });
    overlay.set(
      'spots',
      state.spots
        .filter((s) => folkOn(s.kind))
        .map((s) => spotMarker(s, `${s.kind}:${s.id}`)),
    );
    overlay.set(
      'places',
      folkOn('food') && height < CITY_HEIGHT_M
        ? state.places
            .filter((p) => !foodStatuses(state.places, state.spots).has(p))
            .map((p, i) =>
              spotMarker(
                {
                  kind: 'food',
                  status: 'unknown',
                  lat: p.lat,
                  lon: p.lon,
                  place: p,
                },
                `place:${i}:${p.lat},${p.lon}`,
              ),
            )
        : [],
    );

    overlay.set(
      'reports',
      water && folkOn('depth') && height < CITY_HEIGHT_M
        ? state.reports.map((r) => ({
            id: String(r.id),
            lat: r.lat,
            lon: r.lon,
            className: 'th-pill report',
            text: `มีคนรายงาน: ${r.label} · ${ago(r.createdAt)}`,
            priority: 150,
            collide: true,
          }))
        : [],
    );

    const sel =
      simple && !replaying
        ? state.stations.find((s) => s.id === state.selectedId)
        : null;
    overlay.set('selected', [
      ...(simple && state.spot
        ? [
            {
              id: 'spotring',
              lat: state.spot.lat,
              lon: state.spot.lon,
              className: 'th-selring spot',
            },
          ]
        : []),
      ...(sel
        ? [
            { id: 'ring', lat: sel.lat, lon: sel.lon, className: 'th-selring' },
            {
              id: 'pin',
              lat: sel.lat,
              lon: sel.lon,
              className: `th-pin${sel.level >= 5 ? ' over' : sel.level === 4 ? ' near' : ''}`,
              html: pinHtml(sel),
              priority: 9999,
            },
          ]
        : []),
      ...(simple && state.me
        ? [
            {
              id: 'me',
              lat: state.me.lat,
              lon: state.me.lon,
              className: 'th-me',
              title: 'ตำแหน่งของฉัน',
            },
          ]
        : []),
    ]);
  }

  /** Keep markers out from under the bar, the panels and the dock. */
  function syncBounds() {
    const top = bar.getBoundingClientRect().bottom;
    if (isPhone()) {
      overlay.setBounds({
        left: 0,
        top: top + 88,
        right: innerWidth,
        bottom: panel.getBoundingClientRect().top,
      });
      return;
    }
    // The dock is hidden on phones and in advanced mode (a zero rectangle).
    const bottom = dock.el.getBoundingClientRect().top || innerHeight;
    overlay.setBounds(
      isDash()
        ? {
            left: main.getBoundingClientRect().right,
            top,
            right: side.getBoundingClientRect().left,
            bottom,
          }
        : {
            left: panel.getBoundingClientRect().right,
            top,
            right: innerWidth,
            bottom,
          },
    );
  }

  // Province pills ↔ station pills ↔ news zones switch with zoom level, and
  // the circles scale with camera height, so every move redraws the markers.
  viewer.camera.percentageChanged = 0.1;
  viewer.camera.changed.addEventListener(syncOverlay);

  // ── Data ────────────────────────────────────────────────────────────────
  const getJson = (url) => fetch(url).then((r) => r.json());
  async function loadWater() {
    try {
      const payload = await getJson('/api/bkk/water');
      state.stations = payload.stations || [];
      state.updatedAt = payload.updatedAt;
      state.error = payload.error || null;
    } catch (e) {
      state.error = e.message;
    }
    render();
    loadTimeline();
  }
  const loadTimeline = () =>
    getJson('/api/bkk/water/timeline')
      .then((d) => dock.setTimeline(d))
      .catch(() => {});
  const loadNews = () =>
    getJson('/api/bkk/news')
      .then((d) => (state.news = d.items || []))
      .catch(() => {})
      .then(() => {
        detail?.refresh();
        syncOverlay();
      });
  const loadOutages = () =>
    getJson('/api/bkk/outages')
      .then((d) => {
        state.outages = d.outages || [];
        outageCount.textContent = String(state.outages.length);
        chipButtons.get('bkk-outages').title = state.outages.length
          ? `กฟน. ประกาศดับไฟตามแผน ${state.outages.length} รายการ (กรุงเทพฯ นนทบุรี สมุทรปราการ)`
          : 'กฟน. ไม่มีประกาศดับไฟตามแผนในขณะนี้ (กรุงเทพฯ นนทบุรี สมุทรปราการ)';
      })
      .catch(() => {})
      .then(() => detail?.refresh());
  function loadReports() {
    return getJson('/api/bkk/reports')
      .then((d) => {
        state.reports = d.reports || [];
        state.levels = d.levels || [];
        state.spots = d.spots || [];
        state.choices = d.choices || {};
      })
      .catch(() => {})
      .then(() => {
        syncFolk();
        refreshSpot();
        detail?.refresh();
        // The residents' tab shows a count, so the list redraws too.
        if (!state.selectedId) render();
        else syncOverlay();
      });
  }

  // A station clicked on the map opens its detail without moving the camera.
  addEventListener('bkk:station', (e) =>
    select(String(e.detail?.id), { fly: false }),
  );
  addEventListener('resize', () => {
    renderFocus();
    syncBounds();
    syncOverlay();
  });
  subscribeBkkUpdates((kind) => {
    if (kind === 'water') loadWater();
    if (kind === 'news') loadNews();
    if (kind === 'outages') loadOutages();
    if (kind === 'reports') loadReports();
  });

  let savedMode = 'simple';
  try {
    savedMode = localStorage.getItem(MODE_KEY) || 'simple';
  } catch {
    /* default */
  }
  let savedTheme = 'light';
  try {
    savedTheme = localStorage.getItem(THEME_KEY) || 'light';
  } catch {
    /* default */
  }
  state.theme = savedTheme === 'dark' ? 'dark' : 'light';
  try {
    Object.assign(state.folk, JSON.parse(localStorage.getItem(FOLK_KEY)) || {});
  } catch {
    /* default: every residents' layer on */
  }
  syncFolk();
  try {
    state.flow = localStorage.getItem(FLOW_KEY) === 'on';
  } catch {
    /* default: off */
  }
  syncFlow();
  setMode(savedMode);
  setTheme(state.theme);
  if (savedMode === 'simple') {
    setBase('osm');
    flyThailand(0);
  }
  syncChips();
  syncBounds();
  loadWater().then(() => {
    const wanted = new URLSearchParams(location.search).get('station');
    if (wanted) select(wanted);
  });
  loadNews();
  loadOutages();
  loadReports();

  // Dev-only QA handle: lets browser tests read which layers are on.
  if (import.meta.env?.DEV) globalThis.__bkkShellQa = { dataManager, parked };

  return {
    select,
    setMode,
    setTheme,
    setProvince,
    flyThailand,
    reload: loadWater,
  };
}
