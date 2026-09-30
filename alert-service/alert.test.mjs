import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createEngine } from './engine.js';
import {
  parseOutageRows,
  parseThaiDate,
  geocodeCandidates,
} from './sources/mea.js';
import { normalizeWaterRows } from './sources/thaiwater.js';

const ROW = `
<tr class="pwot_date-list">
  <!-- <td>&nbsp;</td> -->
  <td>30 ก.ย. 2569  - 30 ก.ย. 2569
    <div class="small">09:00น. - 13:00น.</div>
  </td>
  <td>ถนนรามคำแหง 112 ซอยคอนโดสัมมากร และซอยข้างเคียง
    <div class="small">
      กรุงเทพมหานคร
    </div>
  </td>
</tr>`;

test('MEA rows parse past the commented-out cell, in Bangkok time', () => {
  const [r] = parseOutageRows(ROW);
  assert.equal(r.area, 'ถนนรามคำแหง 112 ซอยคอนโดสัมมากร และซอยข้างเคียง');
  assert.equal(r.province, 'กรุงเทพมหานคร');
  assert.equal(new Date(r.startsAt).toISOString(), '2026-09-30T02:00:00.000Z');
  assert.equal(new Date(r.endsAt).toISOString(), '2026-09-30T06:00:00.000Z');
});

test('Thai dates convert from the Buddhist era', () => {
  assert.deepEqual(parseThaiDate('1 ต.ค. 2569'), { y: 2026, m: 10, d: 1 });
  assert.equal(parseThaiDate('1 foo 2569'), null);
});

test('a numbered road is tried as a soi before the road', () => {
  const qs = geocodeCandidates('ถนนรามคำแหง 112 ซอยคอนโดสัมมากร').map(
    (c) => c.name,
  );
  assert.deepEqual(qs, ['ซอยคอนโดสัมมากร', 'ซอยรามคำแหง 112', 'ถนนรามคำแหง']);
  assert.ok(
    geocodeCandidates('ริมถนนถ.ศิริเกษม บริเวณ').some(
      (c) => c.name === 'ถนนศิริเกษม',
    ),
  );
});

test('water rows older than the stale window are flagged', () => {
  const now = Date.UTC(2026, 8, 28, 1, 0); // 08:00 Bangkok
  const payload = {
    data: [
      {
        situation_level: 5,
        storage_percent: '121',
        waterlevel_datetime: '2026-09-28 07:50',
        station: { id: 1, tele_station_lat: 13.8, tele_station_long: 100.5 },
      },
      {
        situation_level: 5,
        storage_percent: '101',
        waterlevel_datetime: '2026-09-27 18:20',
        station: { id: 2, tele_station_lat: 13.7, tele_station_long: 100.7 },
      },
    ],
  };
  const [fresh, old] = normalizeWaterRows(payload, {
    now,
    staleMs: 3 * 3600_000,
  });
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
});

function harness() {
  const db = openDb(':memory:');
  const sent = [];
  let water = [];
  let outages = [];
  const engine = createEngine({
    db,
    config: { waterStaleMs: 1e12, userAgent: 't', outageReminderMs: 3600_000 },
    geocoder: {
      locateArea: async () => ({
        lat: 13.76,
        lon: 100.64,
        precision: 'soi',
        matched: 'x',
      }),
    },
    notifier: { send: async (chatId, text) => sent.push({ chatId, text }) },
    sources: { water: async () => water, outages: async () => outages },
  });
  db.prepare(
    'INSERT INTO subscribers (chat_id, lat, lon, radius_m, active, created_at) VALUES (?,?,?,?,1,0)',
  ).run('near', 13.76, 100.64, 3000);
  db.prepare(
    'INSERT INTO subscribers (chat_id, lat, lon, radius_m, active, created_at) VALUES (?,?,?,?,1,0)',
  ).run('far', 14.5, 101.5, 3000);
  const station = (level, observedAt) => ({
    id: 's1',
    name: 'คลองทดสอบ',
    district: '',
    lat: 13.761,
    lon: 100.641,
    observedAt,
    stale: false,
    waterLevelMsl: 2,
    bankMsl: 2.2,
    storagePercent: level * 25,
    level,
    levelText: '',
  });
  return {
    db,
    sent,
    engine,
    setWater: (w) => (water = w),
    setOutages: (o) => (outages = o),
    station,
  };
}

test('water alerts fire on rising into level 4+, once, and on recovery', async () => {
  const h = harness();
  h.setWater([h.station(3, 1)]);
  await h.engine.pollWater(); // first sight: remembered, not alerted
  assert.equal(h.sent.length, 0);
  h.setWater([h.station(5, 2)]);
  await h.engine.pollWater();
  await h.engine.pollWater(); // same state again: no repeat
  assert.deepEqual(
    h.sent.map((s) => s.chatId),
    ['near'],
  );
  assert.match(h.sent[0].text, /ล้นตลิ่ง/);
  h.setWater([h.station(3, 3)]);
  await h.engine.pollWater();
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].text, /กลับสู่ปกติ/);
});

test('outages notify nearby and keyword subscribers once, then remind', async () => {
  const h = harness();
  h.db
    .prepare(
      'INSERT INTO subscribers (chat_id, radius_m, active, created_at) VALUES (?,?,1,0)',
    )
    .run('kw', 3000);
  h.db
    .prepare('INSERT INTO keywords (chat_id, keyword) VALUES (?, ?)')
    .run('kw', 'สัมมากร');
  const now = Date.now();
  const o = {
    id: 'o1',
    startsAt: now + 30 * 60_000,
    endsAt: now + 3 * 3600_000,
    area: 'ถนนรามคำแหง 112 ซอยคอนโดสัมมากร',
    province: 'กรุงเทพมหานคร',
  };
  h.setOutages([o, { ...o, id: 'o2', province: 'นนทบุรี' }]);
  await h.engine.pollOutages();
  await h.engine.pollOutages();
  const got = h.sent.map((s) => `${s.chatId}:${s.text.split('\n')[0]}`).sort();
  assert.equal(got.length, 4); // near+kw × (new + reminder), Nonthaburi ignored
  assert.ok(got.every((g) => !g.startsWith('far')));
  assert.equal(h.engine.state.outages.outages.length, 1);
});

test('the nationwide payload is nested, and stations without a bank are dropped', () => {
  const now = Date.UTC(2026, 8, 30, 9, 0);
  const row = (id, level, percent) => ({
    situation_level: level,
    storage_percent: percent,
    waterlevel_datetime: '2026-09-30 15:30',
    station: { id, tele_station_lat: 14, tele_station_long: 99 },
    geocode: {
      province_name: { th: 'กาญจนบุรี' },
      amphoe_name: { th: 'ไทรโยค' },
    },
  });
  const rows = normalizeWaterRows(
    { waterlevel_data: { data: [row(1, 5, '158.5'), row(2, null, null)] } },
    { now, staleMs: 3 * 3600_000 },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].province, 'กาญจนบุรี');
  assert.equal(rows[0].storagePercent, 158.5);
});

test('depth is read from numbers and body parts, deepest wins', async () => {
  const { extractDepth } = await import('./news/depth.js');
  assert.deepEqual(
    extractDepth('แฟลตคลองจั่น น้ำยังไม่ลดท่วมสูงถึง 1.5 เมตร'),
    { cm: 150, text: '1.5 เมตร' },
  );
  assert.equal(
    extractDepth('ลาดพร้าว 122 ยังอ่วม! ระดับน้ำครึ่งแข้ง-ถึงเอว').cm,
    95,
  );
  assert.equal(extractDepth('400 หลังน้ำหวิดถึงคอ!').cm, 145);
  assert.equal(extractDepth('น้ำท่วมสูง 30 ซม. รถเล็กผ่านไม่ได้').cm, 30);
  // Volumes, distances and ordinary words are not depths.
  assert.equal(extractDepth('เร่งระบายน้ำ 3,000 ลบ.ม. ต่อวินาที'), null);
  assert.equal(extractDepth('ชาวบ้านออกมาบอกว่าคอนโดยังปกติ'), null);
  assert.equal(extractDepth('ปิดถนนยาว 2 กิโลเมตร'), null);
});

test('reports accept fixed depth choices, rate-limit a sender, and expire', async () => {
  const { createReports } = await import('./reports.js');
  let t = 1_000_000_000_000;
  const reports = createReports({ db: openDb(':memory:'), now: () => t });
  assert.equal(
    reports.add({ lat: 13.77, lon: 100.65, level: 'knee' }, '1.1.1.1').ok,
    true,
  );
  assert.equal(
    reports.add({ lat: 40, lon: -74, level: 'knee' }, '1.1.1.1').status,
    400,
  );
  assert.equal(
    reports.add({ lat: 13.77, lon: 100.65, level: 'drop table' }, '1.1.1.1')
      .status,
    400,
  );
  reports.add({ lat: 13.77, lon: 100.65, level: 'waist' }, '1.1.1.1');
  reports.add({ lat: 13.77, lon: 100.65, level: 'waist' }, '1.1.1.1');
  assert.equal(
    reports.add({ lat: 13.77, lon: 100.65, level: 'waist' }, '1.1.1.1').status,
    429,
  );
  assert.equal(
    reports.add({ lat: 13.77, lon: 100.65, level: 'ankle' }, '2.2.2.2').ok,
    true,
  );
  assert.equal(reports.list().length, 4);
  assert.equal(reports.list()[0].cm, 10);
  t += 7 * 3600_000; // past the 6 h window
  assert.equal(reports.list().length, 0);
});

test('one submission can report trash and food; a spot follows its newest report', async () => {
  const { createReports } = await import('./reports.js');
  let t = 1_000_000_000_000;
  const reports = createReports({ db: openDb(':memory:'), now: () => t });
  const at = { lat: 13.77, lon: 100.65 };
  const sent = reports.add(
    { ...at, answers: { depth: 'ankle', trash: 'floating', food: 'open' } },
    '1.1.1.1',
  );
  assert.equal(sent.reports.length, 3);
  // Three answers were one submission, so two more fit in the window.
  t += 60_000;
  assert.equal(
    reports.add({ ...at, answers: { trash: 'blocking' } }, '1.1.1.1').ok,
    true,
  );
  t += 60_000;
  assert.equal(
    reports.add({ ...at, answers: { trash: 'blocking' } }, '1.1.1.1').ok,
    true,
  );
  assert.equal(
    reports.add({ ...at, answers: { trash: 'blocking' } }, '1.1.1.1').status,
    429,
  );
  assert.equal(
    reports.add({ ...at, answers: { trash: 'blocking' } }, '2.2.2.2').ok,
    true,
  );
  assert.equal(
    reports.add({ ...at, answers: { trash: 'on fire' } }, '2.2.2.2').status,
    400,
  );
  assert.equal(reports.add({ ...at, answers: {} }, '2.2.2.2').status, 400);
  // A kilometre away is another spot.
  reports.add(
    { lat: 13.78, lon: 100.65, answers: { food: 'open' } },
    '4.4.4.4',
  );

  assert.equal(reports.list().length, 1); // depth reports only
  const spots = reports.spots();
  const trash = spots.filter((s) => s.kind === 'trash');
  assert.equal(trash.length, 1);
  assert.equal(trash[0].status, 'blocking');
  assert.equal(trash[0].count, 2); // two senders, since the older "floating"
  assert.equal(spots.filter((s) => s.kind === 'food').length, 2);

  t += 60_000;
  reports.add(
    { ...at, answers: { trash: 'clear', food: 'closed' } },
    '3.3.3.3',
  );
  const after = reports.spots();
  assert.equal(
    after.some((s) => s.kind === 'trash'),
    false,
  );
  assert.deepEqual(
    after.filter((s) => s.kind === 'food').map((s) => s.status),
    ['closed', 'open'],
  );
  t += 7 * 3600_000;
  assert.equal(reports.spots().length, 0);
});

test('a reports table from before trash and food keeps its depth rows', async () => {
  const { createReports } = await import('./reports.js');
  const db = openDb(':memory:');
  const t = 1_000_000_000_000;
  db.exec(`CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL NOT NULL, lon REAL NOT NULL,
    level TEXT NOT NULL, sender TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.prepare(
    'INSERT INTO reports (lat, lon, level, sender, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(13.77, 100.65, 'knee', 'abc', t - 1000);
  const reports = createReports({ db, now: () => t });
  assert.equal(reports.list()[0].cm, 45);
  assert.equal(reports.spots().length, 0);
  assert.equal(
    reports.add(
      { lat: 13.77, lon: 100.65, answers: { food: 'open' } },
      '1.1.1.1',
    ).ok,
    true,
  );
});

test('nearby places are grouped by kind and sorted by distance', async () => {
  const { groupPlaces } = await import('./sources/nearby.js');
  const g = groupPlaces(
    [
      {
        tags: { shop: 'convenience', name: '7-Eleven' },
        lat: 13.775,
        lon: 100.65,
      },
      {
        tags: { shop: 'convenience', brand: 'FamilyMart' },
        center: { lat: 13.771, lon: 100.65 },
      },
      {
        tags: {
          amenity: 'hospital',
          name: 'รพ.เวชธานี',
          opening_hours: '24/7',
        },
        lat: 13.78,
        lon: 100.66,
      },
      { tags: { amenity: 'bench' }, lat: 13.77, lon: 100.65 },
      {
        tags: { amenity: 'marketplace', name: 'ตลาดสดคลองจั่น' },
        center: { lat: 13.772, lon: 100.651 },
      },
      { tags: { shop: 'convenience' }, lat: 13.77, lon: 100.65 }, // unnamed: dropped
    ],
    13.77,
    100.65,
  );
  assert.deepEqual(
    g.convenience.map((p) => p.name),
    ['FamilyMart', '7-Eleven'],
  );
  assert.equal(g.hospital[0].hours, '24/7');
  assert.equal(g.school.length, 0);
  assert.equal(g.marketplace, undefined); // food is a separate lookup
  const { groupFood } = await import('./sources/nearby.js');
  const food = groupFood(
    [
      {
        tags: { amenity: 'marketplace', name: 'ตลาดสดคลองจั่น' },
        center: { lat: 13.772, lon: 100.651 },
      },
      {
        tags: { shop: 'convenience', name: '7-Eleven' },
        lat: 13.775,
        lon: 100.65,
      },
      { tags: { amenity: 'hospital', name: 'รพ.' }, lat: 13.78, lon: 100.66 },
    ],
    13.77,
    100.65,
  );
  assert.equal(food.marketplace[0].name, 'ตลาดสดคลองจั่น');
  assert.equal(food.convenience.length, 1);
  assert.equal(food.restaurant.length, 0);
  assert.equal(food.hospital, undefined);
});

test('a gauge gets the waterway it stands on, cut to a few kilometres, in drawn order', async () => {
  const { pickRivers } = await import('./sources/nearby.js');
  const lat = 13.95;
  const lon = 99.645;
  // A river running west→east past the gauge, with sparse nodes far beyond reach.
  const river = {
    tags: { waterway: 'river', name: 'แม่น้ำแม่กลอง' },
    geometry: [-0.2, -0.03, -0.01, 0.012, 0.03, 0.2].map((dx) => ({
      lat: lat + 0.001,
      lon: lon + dx,
    })),
  };
  // A canal 900 m to the north: not this gauge's water.
  const canal = {
    tags: { waterway: 'canal' },
    geometry: [
      { lat: lat + 0.008, lon: lon - 0.01 },
      { lat: lat + 0.008, lon: lon + 0.01 },
    ],
  };
  const picked = pickRivers(
    [canal, river, { tags: {}, geometry: [] }],
    lat,
    lon,
  );
  assert.equal(picked.length, 1);
  assert.equal(picked[0].name, 'แม่น้ำแม่กลอง');
  // The two ends 20 km away are dropped; order is unchanged.
  assert.deepEqual(
    picked[0].points.map(([x]) => +(x - lon).toFixed(3)),
    [-0.03, -0.01, 0.012, 0.03],
  );
  // A different canal 200 m away is not this gauge's water; another way of
  // the same river is.
  const neighbour = {
    tags: { waterway: 'canal', name: 'คลองข้างเคียง' },
    geometry: [
      { lat: lat + 0.003, lon: lon - 0.01 },
      { lat: lat + 0.003, lon: lon + 0.01 },
    ],
  };
  const nextReach = {
    tags: { waterway: 'river', name: 'แม่น้ำแม่กลอง' },
    geometry: [
      { lat: lat + 0.002, lon: lon + 0.001 },
      { lat: lat + 0.002, lon: lon + 0.02 },
    ],
  };
  assert.deepEqual(
    pickRivers([neighbour, river, nextReach], lat, lon).map((r) => r.name),
    ['แม่น้ำแม่กลอง', 'แม่น้ำแม่กลอง'],
  );
  // With nothing close, the nearest way still stands in.
  assert.equal(pickRivers([canal], lat, lon)[0].kind, 'canal');
  assert.deepEqual(pickRivers([], lat, lon), []);
});

test('hourly history replays over-bank counts, backfills once, and carries short gaps', async () => {
  const { createHistory, percentOf, hourOf } = await import('./history.js');
  const HOUR = 3600_000;
  let t = hourOf(Date.UTC(2026, 8, 30, 10)) + 40 * 60_000; // 10:40
  const fetched = [];
  const history = createHistory({
    db: openDb(':memory:'),
    now: () => t,
    gapMs: 0,
    // Ground 0, bank 10: the level in metres is a tenth of the percent.
    fetchHistory: async (id) => {
      fetched.push(id);
      return {
        bankMsl: 10,
        groundMsl: 0,
        points: [
          { t: hourOf(t) - 5 * HOUR, v: 8 }, // near the bank
          { t: hourOf(t) - 4 * HOUR, v: 11 }, // over
          // three hours missing: carried from the last reading
          { t: hourOf(t), v: 9 }, // loses to the live reading below
        ],
      };
    },
  });
  assert.equal(percentOf(12, 10, 0), 120);
  assert.equal(percentOf(5, 10, 10), null); // no bank-full depth

  const station = (id, percent, extra = {}) => ({
    id,
    storagePercent: percent,
    level: percent > 100 ? 5 : percent > 70 ? 4 : 3,
    observedAt: t - 40 * 60_000,
    stale: false,
    bankMsl: 10,
    groundMsl: 0,
    ...extra,
  });
  const stations = [
    station('a', 120),
    station('calm', 40),
    station('old', 130, { stale: true }),
  ];
  history.record(stations);
  assert.equal(await history.backfill(stations), 1);
  assert.deepEqual(fetched, ['a']); // only the fresh at-risk station
  assert.equal(await history.backfill(stations), 0); // and only once

  const line = history.timeline({ hours: 6 });
  assert.equal(line.hours.length, 7);
  assert.equal(line.hours.at(-1), hourOf(t));
  assert.deepEqual(Object.keys(line.series), ['a']); // calm never neared the bank
  assert.deepEqual(line.series.a, [null, 80, 110, 110, 110, 110, 120]);
  assert.deepEqual(line.over, [0, 0, 1, 1, 1, 1, 1]);
  assert.deepEqual(line.near, [0, 1, 0, 0, 0, 0, 0]);

  // A week later the old rows are pruned on the next record.
  t += 8 * 86400_000;
  history.record([]);
  assert.deepEqual(history.timeline({ hours: 6 }).series, {});
});
