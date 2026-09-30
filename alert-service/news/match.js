// Find Bangkok places and a topic in a Thai news headline.
//
// Thai has no spaces between words, so matching is substring search over a
// gazetteer, with three guards against the usual failures:
//  - longest match wins ("บางนา" inside "ซอยบางนา-ตราด 40" is not Bang Na);
//  - bare names (no ถนน/ซอย/เขต prefix) only count when no other province is
//    named, since "เพชรบุรี" is a road here and a province elsewhere;
//  - a headline naming another province without กทม/กรุงเทพ is not Bangkok.
import { readFileSync } from 'node:fs';

const KIND_RANK = {
  place: 0,
  soi: 0.5,
  canal: 1,
  road: 2,
  subdistrict: 3,
  district: 4,
};
// Words that make a name a housing estate or community ("เคหะร่มเกล้า").
const ESTATE = /^(เคหะชุมชน|การเคหะ|เคหะ|แฟลต|หมู่บ้าน|ชุมชน|อาคารสงเคราะห์)/;
const MIN_EXTENT_M = { place: 500, soi: 300, canal: 2000, road: 1000 };

// Other provinces (Bangkok excluded). Longest first so "พระนครศรีอยุธยา" is
// removed before anything shorter could match inside it.
export const OTHER_PROVINCES = [
  'พระนครศรีอยุธยา',
  'สมุทรปราการ',
  'สมุทรสาคร',
  'สมุทรสงคราม',
  'นครศรีธรรมราช',
  'ประจวบคีรีขันธ์',
  'กาญจนบุรี',
  'ฉะเชิงเทรา',
  'นครราชสีมา',
  'ปราจีนบุรี',
  'สุราษฎร์ธานี',
  'หนองบัวลำภู',
  'อำนาจเจริญ',
  'กำแพงเพชร',
  'พิษณุโลก',
  'เพชรบูรณ์',
  'อุตรดิตถ์',
  'นครสวรรค์',
  'นครนายก',
  'นครปฐม',
  'นครพนม',
  'สุพรรณบุรี',
  'ปทุมธานี',
  'นนทบุรี',
  'ชัยนาท',
  'สิงห์บุรี',
  'อ่างทอง',
  'ลพบุรี',
  'สระบุรี',
  'ชลบุรี',
  'ระยอง',
  'จันทบุรี',
  'ตราด',
  'สระแก้ว',
  'ราชบุรี',
  'เพชรบุรี',
  'ชุมพร',
  'ระนอง',
  'พังงา',
  'ภูเก็ต',
  'กระบี่',
  'ตรัง',
  'พัทลุง',
  'สตูล',
  'สงขลา',
  'ปัตตานี',
  'ยะลา',
  'นราธิวาส',
  'เชียงใหม่',
  'เชียงราย',
  'ลำพูน',
  'ลำปาง',
  'แพร่',
  'น่าน',
  'พะเยา',
  'แม่ฮ่องสอน',
  'ตาก',
  'สุโขทัย',
  'พิจิตร',
  'อุทัยธานี',
  'ขอนแก่น',
  'อุดรธานี',
  'เลย',
  'หนองคาย',
  'บึงกาฬ',
  'สกลนคร',
  'มุกดาหาร',
  'กาฬสินธุ์',
  'มหาสารคาม',
  'ร้อยเอ็ด',
  'ยโสธร',
  'อุบลราชธานี',
  'ศรีสะเกษ',
  'สุรินทร์',
  'บุรีรัมย์',
  'ชัยภูมิ',
].sort((a, b) => b.length - a.length);

const BKK_CONTEXT = /กทม|กรุงเทพ|เมืองหลวง/;

// A Thai match must not end mid-syllable (next char a following vowel or tone
// mark: "จอมพล" inside "จอมพลัง") nor start after a leading vowel.
const FOLLOWING_MARK = /[\u0E30-\u0E3A\u0E45\u0E47-\u0E4E]/;
const LEADING_VOWEL = /[\u0E40-\u0E44]/;
// Bare road names that are everyday words in headlines.
const STOP_BARE = new Set(
  [
    'หลวง',
    'ทหาร',
    'รถไฟ',
    'ทรัพย์',
    'ทรัพย์สิน',
    'แก้ว',
    'ปั้น',
    'เจ้าฟ้า',
    'สุพรรณ',
    'วัฒนธรรม',
    'ประชาชน',
    'เศรษฐกิจ',
    'สุขภาพ',
    'เทศบาล',
    'สาธารณสุข',
    // Sub-district names that are also everyday words.
    'ดอกไม้',
    'สะพานสูง',
  ].map((w) => w.replace(/\s+/g, '')),
);
const PREFIX_ONLY = /^(ถนน|ซอย|คลอง|ทาง|แขวง|เขต)$/;

export const TOPICS = [
  {
    id: 'flood',
    label: 'น้ำท่วม',
    re: /ท่วม|อ่วมน้ำ|ท่วมขัง|ท่วมสูง|น้ำขัง|น้ำล้น|ล้นตลิ่ง|ระดับน้ำ|ฝนตกหนัก|ฝนถล่ม|ฝนตกแช่|พายุ|น้ำหนุน|ประตูระบายน้ำ|ระบายน้ำ|จมบาดาล|จมน้ำ|หนีน้ำ|มวลน้ำ|ลุยน้ำ|น้ำลึก|อพยพ|ถุงยังชีพ|กระสอบทราย|น้ำไม่ลด|น้ำลด/,
  },
  {
    id: 'outage',
    label: 'ไฟดับ',
    re: /ไฟดับ|ไฟฟ้าดับ|ดับไฟ|กฟน\.?|ไฟฟ้าขัดข้อง/,
  },
  { id: 'fire', label: 'ไฟไหม้', re: /ไฟไหม้|เพลิงไหม้|ไฟลุก|ดับเพลิง/ },
  {
    id: 'traffic',
    label: 'จราจร/อุบัติเหตุ',
    re: /รถติด|จราจร|อุบัติเหตุ|รถชน|ชนกัน|ถนนทรุด|ปิดถนน|ปิดการจราจร/,
  },
];

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
export function normalize(text) {
  return String(text || '')
    .replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)))
    .replace(/ฯ/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** Build alias → entry lists. `bare` marks aliases without a Thai prefix. */
export function buildIndex(entries) {
  const aliases = new Map();
  const add = (alias, entry, bare) => {
    const key = normalize(alias);
    if (key.length < 3 || PREFIX_ONLY.test(key)) return;
    if (bare && STOP_BARE.has(key)) return;
    const list = aliases.get(key) || [];
    list.push({ entry, bare });
    aliases.set(key, list);
  };
  for (const raw of entries) {
    const entry = {
      ...raw,
      extentM: Math.max(raw.extentM || 0, MIN_EXTENT_M[raw.kind] || 0),
    };
    const { name, kind } = entry;
    // "ซอย 3" (or "ซอย ๓", "ซอย ก") with no road in its name could be any
    // soi in the city.
    if (kind === 'soi' && /^ซอย([\d/-]+|.{0,2})$/.test(normalize(name)))
      continue;
    if (kind === 'place') {
      // Only estate names are distinctive. Bare neighbourhood names matched
      // everyday words in practice ("จันทร์" in dates, "เกษตร" as farming),
      // and real districts are already covered by the admin entries.
      if (ESTATE.test(name)) add(name, entry, false);
    } else add(name, entry, false);
    if (kind === 'district') add(name.replace(/^เขต/, ''), entry, true);
    if (kind === 'subdistrict') add(name.replace(/^แขวง/, ''), entry, true);
    if (kind === 'road') {
      const bare = name.replace(/^ถนน\s*/, '');
      add(`ถ.${bare}`, entry, false);
      // Only long arteries are named bare in news ("ลาดพร้าว", "รามคำแหง");
      // short roads' bare names are mostly ordinary words — unless the road
      // is named after an estate ("ถนนเคหะร่มเกล้า" → "เคหะร่มเกล้า").
      if (
        ((raw.extentM || 0) >= 3000 || ESTATE.test(bare)) &&
        normalize(bare).length >= 4
      )
        add(bare, entry, !ESTATE.test(bare));
    }
    if (kind === 'place') {
      // "แฟลตการเคหะคลองจั่น" is written "แฟลตคลองจั่น" / "เคหะคลองจั่น".
      const core = name.replace(/^(แฟลต)?(การเคหะ|เคหะชุมชน|เคหะ)/, '').trim();
      if (core !== name && normalize(core).length >= 3)
        for (const lead of ['แฟลต', 'เคหะ', 'เคหะชุมชน', 'ชุมชนเคหะ'])
          add(`${lead}${core}`, entry, false);
    }
    if (kind === 'soi') {
      const bare = name.replace(/^ซอย/, '');
      add(`ซ.${bare}`, entry, false);
      // News writes numbered sois bare: "รามคำแหง 112".
      if (/\d/.test(bare) && normalize(bare).length >= 5)
        add(bare, entry, true);
    }
  }
  return aliases;
}

export function loadIndex(path) {
  const { entries } = JSON.parse(readFileSync(path, 'utf8'));
  return buildIndex(entries);
}

/** First occurrence of alias that sits on syllable and number boundaries. */
function findBounded(text, alias) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(alias, from);
    if (at < 0) return -1;
    const next = text[at + alias.length] || '';
    const prev = text[at - 1] || '';
    const digitRun = /\d$/.test(alias) && /\d/.test(next);
    if (!FOLLOWING_MARK.test(next) && !LEADING_VOWEL.test(prev) && !digitRun)
      return at;
    from = at + 1;
  }
}

/** Topic ids present in the text, most urgent first. */
export function classifyTopics(text) {
  return TOPICS.filter((t) => t.re.test(text)).map((t) => t.id);
}

/**
 * Places in a headline. Returns [] for text about another province.
 * Each hit: { name, kind, lat, lon, extentM, alias }.
 */
export function matchPlaces(text, aliases) {
  const norm = normalize(text);
  const bkk = BKK_CONTEXT.test(norm);

  // Prefixed names first ("ถนนเพชรบุรี", "ซอยบางนา-ตราด 40"): they may contain
  // a province name, which must not count as a mention of that province.
  const hits = [];
  const sameSpanBare = [];
  let masked = norm;
  for (const [alias, list] of aliases) {
    const prefixed = list.filter((x) => !x.bare);
    if (!prefixed.length) continue;
    const at = findBounded(norm, alias);
    if (at < 0) continue;
    for (const { entry } of prefixed)
      hits.push({ start: at, end: at + alias.length, alias, entry });
    // Same text, bare reading ("คลองจั่น" is also แขวงคลองจั่น): keep it for
    // the bare pass, which cannot see this span once it is masked.
    for (const { entry } of list.filter((x) => x.bare))
      sameSpanBare.push({ start: at, end: at + alias.length, alias, entry });
    masked =
      masked.slice(0, at) +
      '#'.repeat(alias.length) +
      masked.slice(at + alias.length);
  }

  let otherProvince = false;
  for (const p of OTHER_PROVINCES) {
    if (masked.includes(p)) {
      otherProvince = true;
      masked = masked.split(p).join('#'.repeat(p.length));
    }
  }
  if (otherProvince && !bkk) return [];

  // Bare names only when no other province is in play.
  if (!otherProvince) hits.push(...sameSpanBare);
  if (!otherProvince)
    for (const [alias, list] of aliases) {
      const bare = list.filter((x) => x.bare);
      if (!bare.length) continue;
      const at = findBounded(masked, alias);
      if (at < 0) continue;
      for (const { entry } of bare)
        hits.push({ start: at, end: at + alias.length, alias, entry });
    }
  // Longest span first; drop anything overlapping an accepted span.
  hits.sort((a, b) => b.end - b.start - (a.end - a.start));
  const taken = [];
  const kept = [];
  for (const h of hits) {
    if (
      taken.some(
        ([s, e]) => h.start < e && s < h.end && !(h.start === s && h.end === e),
      )
    )
      continue;
    taken.push([h.start, h.end]);
    kept.push(h);
  }
  const seen = new Set();
  const places = kept
    .map((h) => ({ ...h.entry, alias: h.alias }))
    .filter((e) => {
      const key = `${e.kind}|${normalize(e.name)}`;
      return !seen.has(key) && seen.add(key);
    });
  // "แฟลตคลองจั่น" names the area, not the waterway: when a canal shares its
  // name with a subdistrict, the subdistrict is the better pin.
  const subNames = new Set(
    places
      .filter((p) => p.kind === 'subdistrict')
      .map((p) => normalize(p.name.replace(/^แขวง/, ''))),
  );
  const rank = (p) =>
    p.kind === 'canal' && subNames.has(normalize(p.name))
      ? KIND_RANK.subdistrict + 0.5
      : KIND_RANK[p.kind];
  return places.sort((a, b) => rank(a) - rank(b) || a.extentM - b.extentM);
}

const DATE_SEGMENT = /^\d{1,2}(\/\d{1,2}\/\d{2,4}|[ก-๙.]+\d{2,4})$/;

/**
 * Headline text worth matching, per channel batch. Title segments split by
 * "|" that repeat across a channel's items are show names ("ข่าวอรุณอมรินทร์",
 * "เช้านี้ที่หมอชิต") and would otherwise pin every clip to one street.
 * Returns a Map videoId → text.
 */
export function headlineTexts(items) {
  const segs = (title) =>
    String(title || '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
  const counts = new Map();
  for (const item of items)
    for (const seg of new Set(segs(item.title).map(normalize)))
      counts.set(seg, (counts.get(seg) || 0) + 1);
  const out = new Map();
  for (const item of items) {
    const kept = segs(item.title).filter((seg) => {
      const n = normalize(seg);
      return (counts.get(n) || 0) < 3 && !DATE_SEGMENT.test(n);
    });
    const description = String(item.description || '')
      .replace(/#\S+/g, ' ')
      .slice(0, 300);
    out.set(item.videoId, `${kept.join(' ')} ${description}`.trim());
  }
  return out;
}
