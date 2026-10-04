// Turns source snapshots into state changes, and state changes into alerts.
// Alerts fire on transitions only; `sent` makes each (alert, chat) at-most-once.
import { EventEmitter } from 'node:events';
import { fetchThailandWater, LEVEL_TEXT } from './sources/thaiwater.js';
import { fetchPlannedOutages } from './sources/mea.js';
import { loadSnapshot, saveSnapshot } from './store.js';

const ALERT_LEVEL = 4;
const BKK_PROVINCE = 'กรุงเทพมหานคร';
const squash = (s) => String(s || '').replace(/\s+/g, '');

export function distanceM(aLat, aLon, bLat, bLon) {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const fmtTime = (ms) =>
  new Date(ms).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const km = (m) => `${(m / 1000).toFixed(1)} กม.`;
/** " (เขตบางเขน)" in Bangkok, " (อ.ไทรโยค จ.กาญจนบุรี)" elsewhere. */
const placeSuffix = (st) => {
  if (!st.district && !st.province) return '';
  if (!st.province || st.province === 'กรุงเทพมหานคร')
    return st.district ? ` (เขต${st.district})` : '';
  return ` (${st.district ? `อ.${st.district} ` : ''}จ.${st.province})`;
};

const SQL = {
  subs: 'SELECT * FROM subscribers WHERE active = 1 AND lat IS NOT NULL',
  keywords:
    'SELECT k.chat_id, k.keyword FROM keywords k JOIN subscribers s ON s.chat_id = k.chat_id WHERE s.active = 1',
  wasSent: 'SELECT 1 AS hit FROM sent WHERE key = ? AND chat_id = ?',
  markSent:
    'INSERT INTO sent (key, chat_id, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  getWater: 'SELECT level FROM water_state WHERE station_id = ?',
  putWater:
    'INSERT INTO water_state (station_id, level, observed_at) VALUES (?, ?, ?) ON CONFLICT (station_id) DO UPDATE SET level = excluded.level, observed_at = excluded.observed_at',
  getOutage: 'SELECT json FROM outages WHERE id = ?',
  putOutage:
    'INSERT INTO outages (id, json, first_seen) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json',
};
const EMPTY = {
  water: { updatedAt: null, error: null, stations: [] },
  outages: { updatedAt: null, error: null, outages: [] },
};

/**
 * @param {object} opts
 * @param {object} opts.db  a store from store.js
 */
export function createEngine({ db, config, geocoder, notifier, sources = {} }) {
  const fetchWater = sources.water || fetchThailandWater;
  const fetchOutages = sources.outages || fetchPlannedOutages;
  const events = new EventEmitter();
  // What this process last polled. Another process (a serverless instance)
  // reads the saved snapshot instead: see snapshot().
  const state = structuredClone(EMPTY);

  /**
   * The latest water or outage result. Read from the database: on Vercel
   * another instance may have polled since this one did.
   */
  async function snapshot(kind) {
    return (await loadSnapshot(db, kind)) || state[kind];
  }

  async function deliver(key, chatIds, text) {
    let count = 0;
    for (const chatId of new Set(chatIds)) {
      if (await db.get(SQL.wasSent, key, chatId)) continue;
      try {
        await notifier.send(chatId, text);
        await db.run(SQL.markSent, key, chatId, Date.now());
        count++;
      } catch (e) {
        console.warn(`[alert] send to ${chatId} failed: ${e.message}`);
      }
    }
    if (count) console.log(`[alert] ${key} → ${count} chat(s)`);
  }

  const subscribers = () => db.all(SQL.subs);
  const keywordWatches = () => db.all(SQL.keywords);
  const nearby = (subs, lat, lon) =>
    subs.filter((s) => distanceM(s.lat, s.lon, lat, lon) <= s.radius_m);

  function waterText(st, kind) {
    const head =
      kind === 'resolved'
        ? '✅ ระดับน้ำกลับสู่ปกติ'
        : st.level >= 5
          ? '🚨 น้ำล้นตลิ่ง'
          : '⚠️ น้ำมาก ใกล้ล้นตลิ่ง';
    const diff = st.waterLevelMsl - st.bankMsl;
    return [
      `${head} — ${st.name}${placeSuffix(st)}`,
      `ระดับน้ำ ${st.storagePercent.toFixed(0)}% ของความลึกถึงตลิ่ง (${LEVEL_TEXT[st.level]})`,
      `${diff >= 0 ? 'สูงกว่า' : 'ต่ำกว่า'}ตลิ่ง ${Math.abs(diff).toFixed(2)} ม.`,
      `ข้อมูล ณ ${fmtTime(st.observedAt)} · สสน./ThaiWater`,
      'หมายเหตุ: เป็นระดับน้ำในคลอง/แม่น้ำ ไม่ใช่การวัดน้ำท่วมถนนโดยตรง',
    ].join('\n');
  }

  async function pollWater() {
    try {
      const stations = await fetchWater({
        staleMs: config.waterStaleMs,
        userAgent: config.userAgent,
      });
      const subs = await subscribers();
      const prevLevels = new Map(
        (await db.all('SELECT station_id, level FROM water_state')).map((r) => [
          r.station_id,
          r.level,
        ]),
      );
      const changed = [];
      for (const st of stations) {
        if (st.stale || !st.level) continue;
        const prev = prevLevels.get(String(st.id)) ?? null;
        if (prev !== st.level) changed.push(st);
        if (prev == null || prev === st.level) continue;
        const recipients = nearby(subs, st.lat, st.lon).map((s) => s.chat_id);
        if (st.level >= ALERT_LEVEL && st.level > prev)
          await deliver(
            `water:${st.id}:L${st.level}:${st.observedAt}`,
            recipients,
            waterText(st, 'up'),
          );
        else if (prev >= ALERT_LEVEL && st.level < ALERT_LEVEL)
          await deliver(
            `water:${st.id}:ok:${st.observedAt}`,
            recipients,
            waterText(st, 'resolved'),
          );
      }
      // Only levels that moved are written: about 800 rows otherwise.
      await db.tx(async (tx) => {
        for (const st of changed)
          await tx.run(SQL.putWater, String(st.id), st.level, st.observedAt);
      });
      state.water = { updatedAt: Date.now(), error: null, stations };
    } catch (e) {
      console.warn(`[water] ${e.message}`);
      state.water = { ...(await snapshot('water')), error: e.message };
    }
    await saveSnapshot(db, 'water', state.water);
    events.emit('update', 'water');
  }

  function outageText(o, kind) {
    const head =
      kind === 'remind'
        ? '⏰ อีกไม่นานจะดับไฟ (ตามแผน MEA)'
        : '🔌 ประกาศดับไฟตามแผน (MEA)';
    return [
      head,
      o.area,
      `${fmtTime(o.startsAt)} – ${fmtTime(o.endsAt)}`,
      o.precision === 'soi' ? '' : 'ตำแหน่งบนแผนที่เป็นค่าประมาณ',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Location matches need a soi-level geocode; keyword matches read the text. */
  function outageRecipients(o, subs, keywords) {
    const ids = [];
    if (o.lat != null && o.precision === 'soi')
      ids.push(...nearby(subs, o.lat, o.lon).map((s) => s.chat_id));
    const area = squash(o.area);
    for (const k of keywords)
      if (area.includes(squash(k.keyword))) ids.push(k.chat_id);
    return ids;
  }

  async function pollOutages() {
    try {
      const now = Date.now();
      const rows = (await fetchOutages({ userAgent: config.userAgent })).filter(
        (r) => r.province === BKK_PROVINCE && r.endsAt > now,
      );
      const outages = [];
      const subs = await subscribers();
      const keywords = await keywordWatches();
      for (const r of rows) {
        const known = await db.get(SQL.getOutage, r.id);
        let o;
        if (known) o = JSON.parse(known.json);
        else {
          let loc = null;
          try {
            loc = await geocoder.locateArea(r.area);
          } catch (e) {
            console.warn(`[geocode] ${e.message}`);
          }
          o = {
            ...r,
            lat: loc?.lat ?? null,
            lon: loc?.lon ?? null,
            precision: loc?.precision ?? 'none',
            matched: loc?.matched ?? null,
          };
          await db.run(SQL.putOutage, o.id, JSON.stringify(o), now);
        }
        outages.push(o);
        const recipients = outageRecipients(o, subs, keywords);
        await deliver(`outage:${o.id}:new`, recipients, outageText(o, 'new'));
        if (o.startsAt > now && o.startsAt - now <= config.outageReminderMs)
          await deliver(
            `outage:${o.id}:remind`,
            recipients,
            outageText(o, 'remind'),
          );
      }
      outages.sort((a, b) => a.startsAt - b.startsAt);
      state.outages = { updatedAt: now, error: null, outages };
    } catch (e) {
      console.warn(`[outages] ${e.message}`);
      state.outages = { ...(await snapshot('outages')), error: e.message };
    }
    await saveSnapshot(db, 'outages', state.outages);
    events.emit('update', 'outages');
  }

  /** Everything currently relevant to one subscriber, for /status and on subscribe. */
  async function statusFor(sub, keywords = []) {
    const water = await snapshot('water');
    const outages = await snapshot('outages');
    const subs = await subscribers();
    const watches = await keywordWatches();
    const lines = [];
    if (sub.lat == null)
      lines.push(
        '📍 ยังไม่ได้ส่งตำแหน่ง — ส่งตำแหน่งเพื่อรับแจ้งเตือนระดับน้ำและไฟดับใกล้คุณ',
      );
    const stations = (sub.lat == null ? [] : water.stations)
      .map((st) => ({ st, d: distanceM(sub.lat, sub.lon, st.lat, st.lon) }))
      .sort((a, b) => a.d - b.d);
    const inRange = stations.filter((x) => x.d <= sub.radius_m);
    if (inRange.length) {
      lines.push(`💧 สถานีวัดน้ำในรัศมี ${km(sub.radius_m)}:`);
      for (const { st, d } of inRange)
        lines.push(
          `• ${st.name} (${km(d)}) — ${st.storagePercent.toFixed(0)}% ${st.levelText}${st.stale ? ' [ข้อมูลค้าง]' : ''}`,
        );
    } else if (stations.length) {
      const { st, d } = stations[0];
      lines.push(
        `💧 ไม่มีสถานีวัดน้ำในรัศมี ${km(sub.radius_m)} — ใกล้สุดคือ ${st.name} (${km(d)}) ${st.storagePercent.toFixed(0)}% ${st.levelText}`,
      );
    }
    const mine = outages.outages.filter((o) =>
      outageRecipients(o, subs, watches).includes(sub.chat_id),
    );
    lines.push(
      mine.length
        ? `🔌 ดับไฟตามแผนที่เกี่ยวกับคุณ ${mine.length} รายการ:`
        : '🔌 ยังไม่มีประกาศดับไฟตามแผนในพื้นที่/คำค้นของคุณ',
    );
    for (const o of mine.slice(0, 10))
      lines.push(`• ${fmtTime(o.startsAt)} — ${o.area}`);
    if (keywords.length)
      lines.push(`🔎 คำค้นที่ติดตาม: ${keywords.join(', ')}`);
    return lines.join('\n');
  }

  return {
    state,
    events,
    snapshot,
    pollWater,
    pollOutages,
    statusFor,
    // Shared with the news engine so every alert type dedupes the same way.
    deliver,
    subscribers,
    keywordWatches,
  };
}
