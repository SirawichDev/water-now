// Water depth as people and headlines state it: a number ("ท่วมสูง 1.5 เมตร")
// or a body part ("ครึ่งแข้ง-ถึงเอว"). Depth on the street is the one thing no
// open sensor gives us, so headlines and user reports are the sources.

/** Report levels, shallow to deep. `cm` is a typical adult's measure. */
export const DEPTH_LEVELS = Object.freeze([
  { id: 'dry', cm: 0, label: 'แห้งแล้ว' },
  { id: 'ankle', cm: 10, label: 'ตาตุ่ม' },
  { id: 'shin', cm: 25, label: 'ครึ่งแข้ง' },
  { id: 'knee', cm: 45, label: 'เข่า' },
  { id: 'waist', cm: 95, label: 'เอว' },
  { id: 'chest', cm: 125, label: 'อก' },
]);

// Body-part phrases. Short words ("อก", "คอ") occur inside ordinary words
// ("ออก", "คอนโด"), so they only count with a depth verb in front.
const BODY = [
  [/มิดหลังคา/, 250],
  [/มิดหัว|ท่วมหัว/, 170],
  [/(?:ถึง|ท่วม|ระดับ|เกือบ)คอ/, 145],
  [/หน้าอก|(?:ถึง|ท่วม|ระดับ)อก/, 125],
  [/สะเอว|เอว/, 95],
  [/ต้นขา/, 65],
  [/หัวเข่า|เข่า/, 45],
  [/ครึ่งแข้ง|หน้าแข้ง/, 25],
  [/ตาตุ่ม|ข้อเท้า/, 10],
];
const CONTEXT = /(?:สูง|ลึก|ท่วม|ระดับน้ำ|น้ำ)[^0-9|]{0,14}$/;

/**
 * Deepest water a headline states, or null.
 * @returns {{ cm: number, text: string } | null}
 */
export function extractDepth(title) {
  const text = String(title || '');
  const found = [];
  for (const m of text.matchAll(
    /(\d+(?:[.,]\d+)?)\s*(เมตร|ม\.|ซม\.?|เซนติเมตร)/g,
  )) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    // "ลบ.ม." (volume), "ตร.ม." (area) and distances are not depths.
    if (/(?:ลบ\.|ตร\.|กิโล)\s*$/.test(before) || !CONTEXT.test(before))
      continue;
    const n = Number(m[1].replace(',', '.'));
    const cm = /^(?:เมตร|ม\.)$/.test(m[2]) ? n * 100 : n;
    if (cm > 0 && cm <= 500)
      found.push({ cm: Math.round(cm), text: m[0].trim() });
  }
  for (const [re, cm] of BODY) {
    const m = text.match(re);
    if (m) found.push({ cm, text: m[0] });
  }
  if (!found.length) return null;
  return found.sort((a, b) => b.cm - a.cm)[0];
}
