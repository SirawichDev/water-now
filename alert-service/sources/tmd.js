// Thai Meteorological Department (กรมอุตุนิยมวิทยา) weather warnings: the
// public list at /warning-and-events/warning-storm, read as HTML. Used to tell
// whether an official warning currently names hail around Bangkok.
import { request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';

export const WARNINGS_URL =
  'https://www.tmd.go.th/warning-and-events/warning-storm';

// tmd.go.th sends its own certificate without the intermediate that signed it,
// so a plain fetch fails with "unable to verify the first certificate". That
// intermediate (GlobalSign GCC R6 AlphaSSL CA 2025, taken from the URL in the
// certificate's own AIA field) is added to Node's roots for these requests
// only. Verification stays on.
const CA = [
  ...rootCertificates,
  readFileSync(
    new URL('./certs/globalsign-gcc-r6-alphassl-ca-2025.pem', import.meta.url),
    'utf8',
  ),
];
const MAX_BYTES = 2_000_000;

/** GET a tmd.go.th page as text. */
export function getTmdText(
  url,
  { userAgent = 'bkk-watch', timeoutMs = 20_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { ca: CA, headers: { 'User-Agent': userAgent }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`TMD HTTP ${res.statusCode}`));
        }
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > MAX_BYTES)
            req.destroy(new Error('TMD page too large'));
        });
        res.on('end', () => resolve(body));
      },
    );
    req.on('timeout', () => req.destroy(new Error('TMD timeout')));
    req.on('error', reject);
    req.end();
  });
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const code =
      e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16)
        : Number(e.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}
const textOf = (html) =>
  decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];
/** "28 กันยายน 2569" → that day's Bangkok midnight in ms, or null. */
export function thaiDate(s) {
  const m = String(s).match(/(\d{1,2})\s*([^\s\d]+)\s*(\d{4})/);
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (month < 0) return null;
  const year = Number(m[3]) - 543; // Buddhist era
  return Date.UTC(year, month, Number(m[1])) - 7 * 3600_000;
}

/**
 * The warning list, newest first as the page orders it.
 * @returns {Array<{ title, summary, url, date: number|null, dateText }>}
 */
export function parseWarnings(html) {
  const out = [];
  for (const raw of String(html).split('class="link-list"').slice(1)) {
    const block = decodeEntities(raw);
    const title = block.match(
      /link-list-title"[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!title) continue;
    const summary = block.match(
      /link-list-description"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/,
    );
    const dateText = textOf(
      block.match(/วันที่ข้อมูล:\s*<\/div>\s*<div>([^<]*)</)?.[1] || '',
    );
    out.push({
      title: textOf(title[2]),
      summary: textOf(summary?.[1] || ''),
      url: new URL(encodeURI(title[1]), WARNINGS_URL).href,
      date: thaiDate(dateText),
      dateText,
    });
  }
  return out;
}

const HAIL = /ลูกเห็บ/;
const AROUND_BANGKOK = /กรุงเทพ|ปริมณฑล|ภาคกลาง/;
const WARNING_DAYS = 1; // a warning counts on its own day and the next

/** The newest current warning naming hail around Bangkok, or null. */
export function hailWarning(warnings, now) {
  const today =
    Math.floor((now + 7 * 3600_000) / 86400_000) * 86400_000 - 7 * 3600_000;
  return (
    warnings.find((w) => {
      const text = `${w.title} ${w.summary}`;
      return (
        w.date != null &&
        today - w.date <= WARNING_DAYS * 86400_000 &&
        HAIL.test(text) &&
        AROUND_BANGKOK.test(text)
      );
    }) || null
  );
}

export async function fetchTmdWarnings({
  userAgent,
  getText = getTmdText,
} = {}) {
  return parseWarnings(await getText(WARNINGS_URL, { userAgent }));
}
