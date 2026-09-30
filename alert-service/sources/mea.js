// MEA planned-outage announcements, scraped from the server-rendered list.
// Each row: "<date> - <date>" + "HH:MMน. - HH:MMน." + area text + province.
import { createHash } from 'node:crypto';

const BASE =
  'https://www.mea.or.th/public-relations/power-outage-notifications/power-outage-maintainence-announcement';
const MAX_PAGES = 10;

const THAI_MONTHS = {
  'ม.ค.': 1,
  'ก.พ.': 2,
  'มี.ค.': 3,
  'เม.ย.': 4,
  'พ.ค.': 5,
  'มิ.ย.': 6,
  'ก.ค.': 7,
  'ส.ค.': 8,
  'ก.ย.': 9,
  'ต.ค.': 10,
  'พ.ย.': 11,
  'ธ.ค.': 12,
};

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const text = (html) =>
  decode(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** "30 ก.ย. 2569" → {y, m, d} in the Gregorian calendar. */
export function parseThaiDate(s) {
  const m = String(s).match(/(\d{1,2})\s*([ก-๙.]+)\s*(\d{4})/);
  if (!m || !THAI_MONTHS[m[2]]) return null;
  return { y: Number(m[3]) - 543, m: THAI_MONTHS[m[2]], d: Number(m[1]) };
}

/** Bangkok wall-clock → epoch ms. */
const bkkEpoch = ({ y, m, d }, hh, mm) => Date.UTC(y, m - 1, d, hh - 7, mm);

export function parseOutageRows(html) {
  const rows = [];
  const trRe = /<tr class="pwot_date-list">([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(html))) {
    // Each row carries a commented-out leading <td>; drop comments first.
    const body = tr[1].replace(/<!--[\s\S]*?-->/g, '');
    const tds = [...body.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 2) continue;
    const small = (td) =>
      text(td.match(/<div class="small">([\s\S]*?)<\/div>/)?.[1] || '');
    const main = (td) =>
      text(td.replace(/<div class="small">[\s\S]*?<\/div>/, ''));
    const [d1, d2 = d1] = main(tds[0]).split(/\s+-\s+/);
    const times = [...small(tds[0]).matchAll(/(\d{1,2}):(\d{2})/g)];
    const start = parseThaiDate(d1);
    const end = parseThaiDate(d2) || start;
    if (!start || times.length < 2) continue;
    const area = main(tds[1]);
    const province = small(tds[1]);
    const startsAt = bkkEpoch(start, +times[0][1], +times[0][2]);
    const endsAt = bkkEpoch(end, +times[1][1], +times[1][2]);
    const id = createHash('sha1')
      .update(`${startsAt}|${endsAt}|${area}`)
      .digest('hex')
      .slice(0, 16);
    rows.push({ id, startsAt, endsAt, area, province });
  }
  return rows;
}

export async function fetchPlannedOutages({ userAgent, signal }) {
  const all = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${BASE}?page=${page}`, {
      signal,
      headers: { 'User-Agent': userAgent, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`MEA HTTP ${res.status} (page ${page})`);
    const html = await res.text();
    const rows = parseOutageRows(html);
    for (const r of rows) all.set(r.id, r);
    if (!rows.length || !html.includes(`?page=${page + 1}"`)) break;
  }
  return [...all.values()];
}

/**
 * Geocoder queries from MEA's free text, most specific first.
 * "ถนนรามคำแหง 112" means soi 112 off Ramkhamhaeng, so a numbered road
 * is also tried as a soi.
 */
export function geocodeCandidates(area) {
  const out = [];
  const add = (q, kind, name) => {
    if (q && !out.some((c) => c.query === q))
      out.push({ query: q, kind, name });
  };
  const clean = area.replace(/\(.*?\)/g, ' ');
  for (const m of clean.matchAll(/(?:ซอย|ซ\.)\s*([^\s,]+(?:\s+\d[\d/]*)?)/g)) {
    const name = m[1].replace(/^ซ\./, '').trim();
    add(`ซอย${name}, กรุงเทพมหานคร`, 'soi', `ซอย${name}`);
  }
  for (const m of clean.matchAll(
    /(?:ถนน|ถ\.)\s*([^\s,]+)(?:\s+(\d[\d/]*))?/g,
  )) {
    const road = m[1].replace(/^ถ\./, '').trim();
    if (!road) continue;
    if (m[2])
      add(`ซอย${road} ${m[2]}, กรุงเทพมหานคร`, 'soi', `ซอย${road} ${m[2]}`);
    add(`ถนน${road}, กรุงเทพมหานคร`, 'road', `ถนน${road}`);
  }
  return out;
}
