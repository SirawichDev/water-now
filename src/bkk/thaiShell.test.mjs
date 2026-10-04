import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, rankProvinces } from './thaiShell.js';
import { placeLine, ago } from './dom.js';
import { passability, bodyReference, formatDepth } from './depthLadder.js';
import { trendFromHistory, chartSvg } from './thaiDetail.js';

const st = (level, province, extra = {}) => ({
  level,
  province,
  stale: false,
  lat: 14,
  lon: 100,
  ...extra,
});

test('the headline counts fresh over-bank and near-bank stations only', () => {
  const sum = summarize([
    st(5, 'กาญจนบุรี'),
    st(5, 'กาญจนบุรี'),
    st(5, 'สระแก้ว'),
    st(4, 'ระยอง'),
    st(3, 'ตาก'),
    st(5, 'ตราด', { stale: true }), // an old reading is not "right now"
  ]);
  assert.equal(sum.over.length, 3);
  assert.equal(sum.overProvinces, 2);
  assert.equal(sum.near.length, 1);
  assert.equal(sum.reporting, 5);
});

test('provinces rank by over-bank count and sit at their flooded gauges', () => {
  const ranked = rankProvinces([
    st(5, 'สระแก้ว', { lat: 13.8, lon: 102 }),
    st(5, 'กาญจนบุรี', { lat: 14, lon: 99 }),
    st(5, 'กาญจนบุรี', { lat: 14.4, lon: 99.4 }),
    st(4, 'กาญจนบุรี', { lat: 20, lon: 105 }), // near-bank does not move the pin
    st(4, 'ระยอง'),
    st(3, 'ตาก'),
  ]);
  assert.deepEqual(
    ranked.map((p) => [p.name, p.over, p.near]),
    [
      ['กาญจนบุรี', 2, 1],
      ['สระแก้ว', 1, 0],
      ['ระยอง', 0, 1],
    ],
  );
  assert.equal(ranked[0].lat.toFixed(1), '14.2');
  assert.equal(ranked[2].lat, null);
});

test('places and ages read the way Thai people write them', () => {
  assert.equal(
    placeLine({ district: 'ไทรโยค', province: 'กาญจนบุรี' }),
    'อ.ไทรโยค จ.กาญจนบุรี',
  );
  assert.equal(
    placeLine({ district: 'บางเขน', province: 'กรุงเทพมหานคร' }),
    'เขตบางเขน กรุงเทพฯ',
  );
  assert.equal(ago(0, 44 * 60_000), '44 นาทีที่แล้ว');
  assert.equal(ago(0, 49 * 3600_000), '2 วันก่อน');
});

test('the depth ladder closes ways in order as water rises', () => {
  const states = (cm) =>
    Object.fromEntries(passability(cm).map((w) => [w.id, w.state]));
  assert.deepEqual(states(10), {
    walk: 'ok',
    moto: 'ok',
    car: 'ok',
    pickup: 'ok',
    boat: 'no',
  });
  assert.deepEqual(states(20), {
    walk: 'risk',
    moto: 'risk',
    car: 'risk',
    pickup: 'ok',
    boat: 'no',
  });
  assert.deepEqual(states(45), {
    walk: 'risk',
    moto: 'no',
    car: 'no',
    pickup: 'risk',
    boat: 'no',
  });
  assert.deepEqual(states(150), {
    walk: 'no',
    moto: 'no',
    car: 'no',
    pickup: 'no',
    boat: 'ok',
  });
  assert.equal(bodyReference(45), 'เข่า');
  assert.equal(formatDepth(150), '1.5 ม.');
  assert.equal(formatDepth(30), '30 ซม.');
});

test('trend compares the latest reading with an hour and a day before', () => {
  const H = 3600_000;
  const points = Array.from({ length: 49 }, (_, i) => ({
    t: i * H,
    v: i <= 24 ? 50 + i * 0.2 : 54.8 - (i - 24) * 0.1, // peak at hour 24
  }));
  const trend = trendFromHistory(points);
  assert.equal(trend.hourCm, -10);
  assert.equal(trend.dayM, -2.4);
  assert.equal(trend.peak.t, 24 * H);
  assert.equal(trendFromHistory([]), null);
  // A lone reading has nothing to compare with.
  assert.equal(trendFromHistory([{ t: 0, v: 1 }]).hourCm, null);
  assert.match(chartSvg(points, 51), /stroke-dasharray/);
  assert.equal(chartSvg([{ t: 0, v: 1 }], 1), '');
});

test('circle size follows the percent over the bank and shrinks as the camera rises', async () => {
  const { bubbleRadius, overMetres, overMetresAt } =
    await import('./floodMath.js');
  assert.equal(bubbleRadius(100, 500_000), 5); // at the bank
  assert.equal(bubbleRadius(80, 500_000), 5); // below it: no smaller
  assert.equal(bubbleRadius(125, 500_000), 15); // 5 + 20·√0.25
  assert.equal(bubbleRadius(200, 500_000), 25); // 5 + 20·√1
  assert.ok(bubbleRadius(134, 500_000) > bubbleRadius(112, 500_000));
  assert.ok(
    bubbleRadius(200, 2_500_000) < bubbleRadius(200, 500_000) / 3 + 0.1,
  );
  assert.equal(bubbleRadius(200, 50_000), 25 * 1.2); // capped close up
  const st = { waterLevelMsl: 18.5, bankMsl: 16, groundMsl: 6 };
  assert.equal(overMetres(st), 2.5);
  assert.equal(overMetres({ waterLevelMsl: 3, bankMsl: NaN }), null);
  // 125% of a 10 m bank-full depth is 2.5 m over the bank.
  assert.equal(overMetresAt(125, st), 2.5);
  assert.equal(overMetresAt(125, { bankMsl: 5, groundMsl: 5 }), null);
});

test('trend counts cover fresh over-bank gauges only', async () => {
  const { trendCounts } = await import('./floodMath.js');
  assert.deepEqual(
    trendCounts([
      st(5, 'ก', { changeM: 0.14 }),
      st(5, 'ก', { changeM: -0.02 }),
      st(5, 'ก', { changeM: 0 }),
      st(5, 'ก', { changeM: null }), // no previous reading: counted as steady
      st(4, 'ก', { changeM: 0.3 }),
      st(5, 'ก', { changeM: 0.3, stale: true }),
    ]),
    { up: 1, flat: 2, down: 1 },
  );
});

test('a replay frame lists the gauges at or near the bank at that hour', async () => {
  const { frameAt, dayMarks } = await import('./floodMath.js');
  const stations = new Map([
    ['a', { lat: 14, lon: 99, bankMsl: 10, groundMsl: 0 }],
    ['b', { lat: 15, lon: 100, bankMsl: 10, groundMsl: 0 }],
  ]);
  const timeline = {
    series: { a: [60, 80, 120], b: [null, 130, 90], gone: [150, 150, 150] },
  };
  assert.deepEqual(frameAt(timeline, 0, stations), []); // 60% is not near
  assert.deepEqual(
    frameAt(timeline, 1, stations).map((f) => [f.id, f.over]),
    [
      ['a', false],
      ['b', true],
    ],
  );
  const [a] = frameAt(timeline, 2, stations);
  assert.equal(a.over, true);
  assert.ok(Math.abs(a.metres - 2) < 1e-9);
  // 17:00 UTC is midnight in Bangkok.
  const t0 = Date.UTC(2026, 8, 29, 15);
  const hours = Array.from({ length: 30 }, (_, i) => t0 + i * 3600_000);
  assert.deepEqual(
    dayMarks(hours).map((m) => m.index),
    [2, 26],
  );
});

test('a circle fills to the gauge level with the bank at half height', async () => {
  const { tankFill, TANK_MIN_RADIUS, bubbleRadius } =
    await import('./floodMath.js');
  assert.equal(tankFill(100), 50);
  assert.equal(tankFill(134), 67);
  assert.equal(tankFill(400), 92); // never a full disc
  assert.equal(tankFill(0), 8); // never an empty one
  // Country view: too small to read a level. Street view: a tank.
  assert.ok(bubbleRadius(150, 2_650_000) < TANK_MIN_RADIUS);
  assert.ok(bubbleRadius(150, 9000) >= TANK_MIN_RADIUS);
  // A gauge barely over its bank is still a tank once zoomed in, and keeps
  // its own (smaller) size from further out.
  const { circleRadius, TANK_ZOOM_M } = await import('./floodMath.js');
  assert.ok(bubbleRadius(101, 9000) < TANK_MIN_RADIUS);
  assert.ok(circleRadius(101, 9000) > TANK_MIN_RADIUS);
  assert.equal(
    circleRadius(101, TANK_ZOOM_M * 2),
    bubbleRadius(101, TANK_ZOOM_M * 2),
  );
  assert.equal(circleRadius(300, 9000), bubbleRadius(300, 9000));
});

test('resident spots attach to places, sort by urgency and count for the chips', async () => {
  const { foodPlaces, spotAt, sortSpots, spotCounts, nearestStation } =
    await import('./folk.js');
  const places = foodPlaces({
    restaurant: [{ name: 'ครัวป้า', lat: 13.772, lon: 100.65, distM: 220 }],
    marketplace: [{ name: 'ตลาดสด', lat: 13.7705, lon: 100.65, distM: 55 }],
    hospital: [{ name: 'รพ.', lat: 13.78, lon: 100.66, distM: 900 }],
  });
  assert.deepEqual(
    places.map((p) => [p.name, p.kindLabel]),
    [
      ['ตลาดสด', 'ตลาด'],
      ['ครัวป้า', 'ร้านอาหาร'],
    ],
  );
  const spots = [
    { kind: 'food', status: 'open', lat: 13.7706, lon: 100.65, createdAt: 3 },
    { kind: 'food', status: 'closed', lat: 13.79, lon: 100.65, createdAt: 9 },
    {
      kind: 'trash',
      status: 'floating',
      lat: 13.77,
      lon: 100.65,
      createdAt: 5,
    },
    {
      kind: 'trash',
      status: 'blocking',
      lat: 13.76,
      lon: 100.65,
      createdAt: 1,
    },
  ];
  // ~11 m from the market: the report is about it. The restaurant has none.
  assert.equal(spotAt(spots, 'food', 13.7705, 100.65).status, 'open');
  assert.equal(spotAt(spots, 'food', 13.772, 100.65), null);
  assert.equal(spotAt(spots, 'trash', 13.7705, 100.65).status, 'floating');
  assert.deepEqual(
    sortSpots(spots).map((s) => s.status),
    ['blocking', 'floating', 'open', 'closed'],
  );
  assert.deepEqual(spotCounts(spots), { trash: 2, food: 1 });
  const stations = [
    { id: 'a', lat: 13.77, lon: 100.66 },
    { id: 'b', lat: 14.5, lon: 100.6 },
  ];
  // Two shops 30 m apart: the report at the first does not speak for the second.
  const { foodStatuses, placeOf } = await import('./folk.js');
  const shops = [
    { name: 'ครัวศิลา', lat: 13.8523, lon: 100.5806 },
    { name: '7-Eleven', lat: 13.85255, lon: 100.5807 },
  ];
  const said = foodStatuses(shops, [
    { kind: 'food', status: 'open', lat: 13.8523, lon: 100.5806 },
    { kind: 'trash', status: 'floating', lat: 13.85255, lon: 100.5807 },
  ]);
  assert.equal(said.get(shops[0]).status, 'open');
  assert.equal(said.has(shops[1]), false);
  assert.equal(placeOf({ lat: 13.9, lon: 100.58 }, shops), null);
  assert.equal(nearestStation(stations, 13.77, 100.65).id, 'a');
  assert.equal(nearestStation(stations, 13.77, 100.65, 500), null);
});

test('a gauge history becomes one percent per hour, ending at the current hour', async () => {
  const { gaugeSeries } = await import('./floodMath.js');
  const HOUR = 3600_000;
  const now = Date.UTC(2026, 9, 1, 6, 20); // 13:20 in Bangkok
  const st = { bankMsl: 12, groundMsl: 2 }; // 10 m bank-full depth
  const points = [
    { t: now - 3 * HOUR, v: 9 }, // three hours back: 70%
    { t: now - 3 * HOUR + 600_000, v: 10 }, // the same hour, later: 80% wins
    { t: now - 600_000, v: 13 }, // this hour: 110%
    { t: now - 100 * HOUR, v: 20 }, // before the window: dropped
  ];
  const s = gaugeSeries(points, st, { hours: 6, now });
  assert.equal(s.hours.length, 7);
  assert.equal(s.hours[6], Math.floor(now / HOUR) * HOUR);
  assert.deepEqual(s.percent, [null, null, null, 80, null, null, 110]);
  assert.equal(gaugeSeries(points, { bankMsl: 5, groundMsl: 5 }), null);
  assert.equal(gaugeSeries([], st), null);
});

test('water from the north: stops read north to south, severity and the provinces downstream', async () => {
  const { northWater, stopStatus } = await import('./northWater.js');
  const st = (code, province, percent, flow = null, capacity = null) => ({
    code,
    province,
    storagePercent: percent,
    flow,
    capacity,
    stale: false,
  });
  // The readings of 1 Oct 2026, 12:00.
  const stations = [
    st('CPY015', 'กรุงเทพมหานคร', 93.6),
    st('C.35', 'พระนครศรีอยุธยา', 105.3, 1369, 1159),
    st('C.2', 'นครสวรรค์', 86.7, 2578, 3735),
    st('C.13', 'ชัยนาท', 95.2, 2380, 2720),
    st('C.7A', 'อ่างทอง', 92.8, 2305, 2862),
    st('XYZ', 'ที่อื่น', 150),
  ];
  const w = northWater(stations);
  assert.deepEqual(
    w.stops.map((s) => s.code),
    ['C.2', 'C.13', 'C.7A', 'C.35', 'CPY015'],
  );
  assert.equal(Math.round(w.upstream * 100), 88); // the dam's release, 2380/2720
  assert.equal(w.severity, 'prepare');
  assert.equal(w.stops[0].status, 'ok'); // C.2: 69% of capacity, 87% of bank
  assert.equal(w.first, 1); // C.13 is the first stop at risk
  assert.deepEqual(w.impact, [
    'ชัยนาท',
    'อ่างทอง',
    'พระนครศรีอยุธยา',
    'กรุงเทพมหานคร',
  ]);
  // Low flow upstream and nothing over the bank: nothing to warn about.
  const calm = northWater([
    st('C.2', 'นครสวรรค์', 40, 900, 3735),
    st('C.35', 'พระนครศรีอยุธยา', 60, 400, 1159),
  ]);
  assert.equal(calm.severity, 'none');
  assert.deepEqual(calm.impact, []);
  assert.equal(stopStatus(st('C.36', 'x', 80, 838, 441)), 'over'); // flow > capacity
});

test('hail zones fade after an hour, go after three, and word how sure they are', async () => {
  const { hailStage, liveZones, agoText, pillText, evidence } =
    await import('./hail.js');
  const at = Date.parse('2026-10-01T07:05:00Z'); // 14:05 Bangkok
  const zone = {
    id: '13.79,100.60',
    place: 'ลาดพร้าว',
    lastAt: at,
    confirmed: false,
    count: 1,
    news: [
      {
        channel: 'PPTV HD 36',
        title: 'ย่านลาดพร้าวฝนตกหนักมาพร้อมลูกเห็บ',
        at,
      },
    ],
    residents: { seen: 0, none: 1 },
    warning: null,
    model: {
      hail: false,
      hailAhead: null,
      stormAhead: at + 6 * 3600_000,
      cape: 2100,
    },
    sources: { news: true, residents: false, tmd: false, model: false },
  };
  assert.equal(hailStage(zone, at + 15 * 60_000), 'active');
  assert.equal(hailStage(zone, at + 61 * 60_000), 'fading');
  assert.equal(hailStage(zone, at + 3 * 3600_000), 'gone');
  assert.deepEqual(liveZones([zone], at + 3 * 3600_000), []);
  assert.equal(agoText(15 * 60_000), '15 นาทีที่แล้ว');
  assert.equal(agoText(165 * 60_000), '2 ชม. 45 นาทีที่แล้ว');
  assert.equal(agoText(120 * 60_000), '2 ชม.ที่แล้ว');
  assert.deepEqual(pillText([zone]), {
    title: 'ลูกเห็บ · ลาดพร้าว',
    status: 'มีรายงาน ยังไม่ยืนยัน',
  });
  assert.equal(
    pillText([zone, { ...zone, place: null }]).title,
    'ลูกเห็บ · 2 พื้นที่',
  );
  assert.equal(pillText([]), null);

  const rows = evidence(zone, { checkedAt: at, error: null, latest: {} });
  assert.deepEqual(
    rows.map((r) => r.ok),
    [true, false, false, false],
  );
  assert.match(rows[0].title, /^ข่าว · PPTV HD 36 · 14:05/);
  assert.equal(rows[1].text, 'ยังไม่มีใครรายงาน · บอกว่าไม่มี 1 คน');
  assert.equal(rows[2].text, 'ไม่มีประกาศเตือนลูกเห็บวันนี้');
  assert.equal(rows[3].text, 'ไม่พบสัญญาณลูกเห็บ');
  assert.match(rows[3].small, /^คาดฝนฟ้าคะนองราว 20:05 น\.$/);
  // Before the service has read TMD or the model, it says so.
  const unread = evidence({ ...zone, model: null }, null);
  assert.equal(unread[2].text, 'ยังไม่ได้ตรวจ');
  assert.equal(unread[3].text, 'ยังไม่ได้ตรวจ');
});
