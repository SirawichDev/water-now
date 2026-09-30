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

test('circle size follows metres over the bank and shrinks as the camera rises', async () => {
  const { bubbleRadius, overMetres, overMetresAt } =
    await import('./floodMath.js');
  assert.equal(bubbleRadius(0, 500_000), 5);
  assert.equal(bubbleRadius(4, 500_000), 19); // 5 + 7·√4
  assert.ok(bubbleRadius(4, 2_500_000) < bubbleRadius(4, 500_000) / 3 + 0.1);
  assert.equal(bubbleRadius(4, 50_000), 19 * 1.2); // capped close up
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
  assert.ok(bubbleRadius(2, 2_650_000) < TANK_MIN_RADIUS);
  assert.ok(bubbleRadius(2, 9000) >= TANK_MIN_RADIUS);
  // A gauge barely over its bank is still a tank once zoomed in, and keeps
  // its own (smaller) size from further out.
  const { circleRadius, TANK_ZOOM_M } = await import('./floodMath.js');
  assert.ok(bubbleRadius(0.05, 9000) < TANK_MIN_RADIUS);
  assert.ok(circleRadius(0.05, 9000) > TANK_MIN_RADIUS);
  assert.equal(
    circleRadius(0.05, TANK_ZOOM_M * 2),
    bubbleRadius(0.05, TANK_ZOOM_M * 2),
  );
  assert.equal(circleRadius(3, 9000), bubbleRadius(3, 9000));
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
