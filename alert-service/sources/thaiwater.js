// Thailand telemetry water levels from the HII ThaiWater public API
// (~800 stations from HII, RID and others; Bangkok has 9 of them).
// storage_percent = (waterlevel - ground) / (bank - ground) * 100, and
// situation_level bands it: 1 ≤10, 2 ≤30, 3 ≤70, 4 ≤100, 5 >100 (over bank).
const API = 'https://api-v3.thaiwater.net/api/v1/thaiwater30';
const URL_THAILAND = `${API}/public/waterlevel_load`;
// Below this change between two readings the level is called steady.
const TREND_EPSILON_M = 0.01;

export const LEVEL_TEXT = Object.freeze({
  1: 'น้อยวิกฤต',
  2: 'น้อย',
  3: 'ปกติ',
  4: 'น้ำมาก ใกล้ตลิ่ง',
  5: 'ล้นตลิ่ง',
});

/** Parse "YYYY-MM-DD HH:mm" as Bangkok local time (UTC+7). */
export function parseBangkokTime(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5]);
}

function trendChange(now, previous) {
  const a = Number(now);
  const b = Number(previous);
  if (previous == null || !Number.isFinite(a) || !Number.isFinite(b))
    return null;
  const d = +(a - b).toFixed(2);
  return Math.abs(d) < TREND_EPSILON_M ? 0 : d;
}

export function normalizeWaterRows(payload, { now = Date.now(), staleMs }) {
  // The nationwide endpoint nests rows; the per-province one does not.
  const rows =
    [payload?.waterlevel_data?.data, payload?.data].find(Array.isArray) || [];
  return rows
    .map((r) => {
      const st = r.station || {};
      const lat = Number(st.tele_station_lat);
      const lon = Number(st.tele_station_long);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const observedAt = parseBangkokTime(r.waterlevel_datetime);
      const level = Number(r.situation_level) || null;
      const percent = Number(r.storage_percent);
      // A station without a bank reference cannot say "over the bank".
      if (!level || !Number.isFinite(percent)) return null;
      return {
        id: String(st.id ?? r.id),
        name: st.tele_station_name?.th || st.tele_station_name?.en || '',
        river: r.river_name || '',
        district: r.geocode?.amphoe_name?.th || '',
        province: r.geocode?.province_name?.th || '',
        lat,
        lon,
        observedAt,
        stale: observedAt == null || now - observedAt > staleMs,
        waterLevelMsl: Number(r.waterlevel_msl),
        bankMsl: Number(st.min_bank),
        groundMsl: Number(st.ground_level),
        // Change since the station's previous reading (its own interval).
        changeM: trendChange(r.waterlevel_msl, r.waterlevel_msl_previous),
        storagePercent: percent,
        level,
        levelText: LEVEL_TEXT[level] || 'ไม่ทราบ',
        agency: r.agency?.agency_shortname?.th || '',
      };
    })
    .filter(Boolean);
}

export async function fetchThailandWater({ staleMs, userAgent, signal }) {
  const res = await fetch(URL_THAILAND, {
    signal,
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`ThaiWater HTTP ${res.status}`);
  const payload = await res.json();
  const stations = normalizeWaterRows(payload, { staleMs });
  if (!stations.length) throw new Error('ThaiWater returned no stations');
  return stations;
}

const ymd = (ms) => new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);

/** Hourly levels for one station: { bankMsl, groundMsl, points: [{t, v}] }. */
export function normalizeHistory(payload) {
  const data = payload?.data || {};
  const points = (Array.isArray(data.graph_data) ? data.graph_data : [])
    .filter((p) => p.value != null)
    .map((p) => ({ t: parseBangkokTime(p.datetime), v: Number(p.value) }))
    .filter((p) => p.t != null && Number.isFinite(p.v));
  return {
    bankMsl: Number.isFinite(Number(data.min_bank))
      ? Number(data.min_bank)
      : null,
    groundMsl: Number.isFinite(Number(data.ground_level))
      ? Number(data.ground_level)
      : null,
    points,
  };
}

export async function fetchWaterHistory(
  stationId,
  { days = 3, userAgent, now = Date.now(), signal } = {},
) {
  const url = `${API}/public/waterlevel_graph?station_type=tele_waterlevel&station_id=${encodeURIComponent(stationId)}&start_date=${ymd(now - days * 86400_000)}&end_date=${ymd(now)}`;
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`ThaiWater history HTTP ${res.status}`);
  return normalizeHistory(await res.json());
}
