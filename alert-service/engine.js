// Turns source snapshots into state changes, and state changes into alerts.
// Alerts fire on transitions only; `sent` makes each (alert, chat) at-most-once.
import { EventEmitter } from 'node:events';
import { fetchThailandWater, LEVEL_TEXT } from './sources/thaiwater.js';
import { fetchPlannedOutages } from './sources/mea.js';

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

export function createEngine({ db, config, geocoder, notifier, sources = {} }) {
  const fetchWater = sources.water || fetchThailandWater;
  const fetchOutages = sources.outages || fetchPlannedOutages;
  const events = new EventEmitter();
  const state = {
    water: { updatedAt: null, error: null, stations: [] },
    outages: { updatedAt: null, error: null, outages: [] },
  };

  const q = {
    subs: db.prepare(
      'SELECT * FROM subscribers WHERE active = 1 AND lat IS NOT NULL',
    ),
    keywords: db.prepare(
      'SELECT k.chat_id, k.keyword FROM keywords k JOIN subscribers s ON s.chat_id = k.chat_id WHERE s.active = 1',
    ),
    wasSent: db.prepare('SELECT 1 FROM sent WHERE key = ? AND chat_id = ?'),
    markSent: db.prepare(
      'INSERT OR IGNORE INTO sent (key, chat_id, sent_at) VALUES (?, ?, ?)',
    ),
    getWater: db.prepare('SELECT level FROM water_state WHERE station_id = ?'),
    putWater: db.prepare(
      'INSERT OR REPLACE INTO water_state (station_id, level, observed_at) VALUES (?, ?, ?)',
    ),
    getOutage: db.prepare('SELECT json FROM outages WHERE id = ?'),
    putOutage: db.prepare(
      'INSERT OR REPLACE INTO outages (id, json, first_seen) VALUES (?, ?, ?)',
    ),
  };

  async function deliver(key, chatIds, text) {
    let count = 0;
    for (const chatId of new Set(chatIds)) {
      if (q.wasSent.get(key, chatId)) continue;
      try {
        await notifier.send(chatId, text);
        q.markSent.run(key, chatId, Date.now());
        count++;
      } catch (e) {
        console.warn(`[alert] send to ${chatId} failed: ${e.message}`);
      }
    }
    if (count) console.log(`[alert] ${key} → ${count} chat(s)`);
  }

  const nearby = (lat, lon) =>
    q.subs.all().filter((s) => distanceM(s.lat, s.lon, lat, lon) <= s.radius_m);

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
      for (const st of stations) {
        if (st.stale || !st.level) continue;
        const prev = q.getWater.get(st.id)?.level ?? null;
        q.putWater.run(st.id, st.level, st.observedAt);
        if (prev == null || prev === st.level) continue;
        const recipients = nearby(st.lat, st.lon).map((s) => s.chat_id);
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
      state.water = { updatedAt: Date.now(), error: null, stations };
    } catch (e) {
      console.warn(`[water] ${e.message}`);
      state.water = { ...state.water, error: e.message };
    }
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
  function outageRecipients(o) {
    const ids = [];
    if (o.lat != null && o.precision === 'soi')
      ids.push(...nearby(o.lat, o.lon).map((s) => s.chat_id));
    const area = squash(o.area);
    for (const k of q.keywords.all())
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
      for (const r of rows) {
        const known = q.getOutage.get(r.id);
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
          q.putOutage.run(o.id, JSON.stringify(o), now);
        }
        outages.push(o);
        const recipients = outageRecipients(o);
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
      state.outages = { ...state.outages, error: e.message };
    }
    events.emit('update', 'outages');
  }

  /** Everything currently relevant to one subscriber, for /status and on subscribe. */
  function statusFor(sub, keywords = []) {
    const lines = [];
    if (sub.lat == null)
      lines.push(
        '📍 ยังไม่ได้ส่งตำแหน่ง — ส่งตำแหน่งเพื่อรับแจ้งเตือนระดับน้ำและไฟดับใกล้คุณ',
      );
    const stations = (sub.lat == null ? [] : state.water.stations)
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
    const mine = state.outages.outages.filter((o) =>
      outageRecipients(o).includes(sub.chat_id),
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
    pollWater,
    pollOutages,
    statusFor,
    // Shared with the news engine so every alert type dedupes the same way.
    deliver,
    subscribers: () => q.subs.all(),
    keywordWatches: () => q.keywords.all(),
  };
}
