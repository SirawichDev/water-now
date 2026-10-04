// Hail zones (from /api/bkk/hail) as the map and the panel word them. A zone
// is "reported" on one kind of evidence and "confirmed" on two; it fades an
// hour after its last report and is gone after three. No DOM here.
import { clock } from './dom.js';

export const HAIL_FADE_MS = 3600_000;
export const HAIL_GONE_MS = 3 * 3600_000;
export const HAIL_SOURCES = 4; // news, residents, TMD warning, weather model

/** active (ice still falling) | fading | gone, from the last report's age. */
export function hailStage(zone, now) {
  const age = now - zone.lastAt;
  return age >= HAIL_GONE_MS
    ? 'gone'
    : age >= HAIL_FADE_MS
      ? 'fading'
      : 'active';
}

/** Zones still on the map, strongest first (the service's order). */
export const liveZones = (zones, now) =>
  (zones || []).filter((z) => hailStage(z, now) !== 'gone');

export const hailName = (z) => z.place || 'จุดที่คนในพื้นที่รายงาน';

/** "15 นาทีที่แล้ว" / "2 ชม. 45 นาทีที่แล้ว": precise, because minutes matter. */
export function agoText(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ชม. ${m % 60} นาทีที่แล้ว` : `${h} ชม.ที่แล้ว`;
}

export const statusText = (z) =>
  z.confirmed ? 'ยืนยันแล้ว' : 'มีรายงาน ยังไม่ยืนยัน';

/** The top-bar alert: { title, status } for the strongest zone. */
export function pillText(zones) {
  const [z] = zones;
  if (!z) return null;
  return {
    title:
      zones.length > 1
        ? `ลูกเห็บ · ${zones.length} พื้นที่`
        : `ลูกเห็บ · ${hailName(z)}`,
    status: statusText(z),
  };
}

/**
 * The four kinds of evidence, each { ok, title, text, small }.
 * @param {object} z     a zone
 * @param {object} tmd   the service's TMD state: { checkedAt, error, latest, hail }
 */
export function evidence(z, tmd) {
  const [clip] = z.news; // newest first
  const more = z.news.length - 1;
  // Several channels are still one kind of evidence: they often air the same
  // viral video. The count is shown, not added to the sources.
  const channels = new Set(z.news.map((n) => n.channel)).size;
  const r = z.residents;
  const none = r.none ? ` · บอกว่าไม่มี ${r.none} คน` : '';
  const m = z.model;
  return [
    clip
      ? {
          ok: true,
          title:
            channels > 1
              ? `ข่าว · ${channels} ช่อง · ล่าสุด ${clock(clip.at)}`
              : `ข่าว · ${clip.channel} · ${clock(clip.at)}`,
          small: `${channels > 1 ? `${clip.channel}: ` : ''}“${clip.title}”${more > 0 ? ` และอีก ${more} คลิป` : ''}`,
        }
      : { ok: false, title: 'ข่าว', text: 'ยังไม่มีข่าวพูดถึง' },
    r.seen
      ? {
          ok: true,
          title: 'คนในพื้นที่',
          text: `เห็นลูกเห็บ ${r.seen} คน${none}`,
        }
      : { ok: false, title: 'คนในพื้นที่', text: `ยังไม่มีใครรายงาน${none}` },
    z.sources.tmd && z.warning
      ? { ok: true, title: 'กรมอุตุนิยมวิทยา', small: z.warning.title }
      : {
          ok: false,
          title: 'กรมอุตุนิยมวิทยา',
          text: !tmd?.checkedAt
            ? 'ยังไม่ได้ตรวจ'
            : tmd.error && !tmd.latest
              ? 'อ่านประกาศไม่ได้ตอนนี้'
              : 'ไม่มีประกาศเตือนลูกเห็บวันนี้',
        },
    m?.hail
      ? {
          ok: true,
          title: 'แบบจำลองอากาศ',
          text: 'พบสัญญาณลูกเห็บช่วงที่มีรายงาน',
        }
      : {
          ok: false,
          title: 'แบบจำลองอากาศ',
          text: m ? 'ไม่พบสัญญาณลูกเห็บ' : 'ยังไม่ได้ตรวจ',
          small: !m
            ? null
            : m.hailAhead
              ? `คาดอาจมีลูกเห็บราว ${clock(m.hailAhead)} น.`
              : m.stormAhead
                ? `คาดฝนฟ้าคะนองราว ${clock(m.stormAhead)} น.`
                : m.cape >= 1500
                  ? 'อากาศแปรปรวน'
                  : null,
        },
  ];
}
