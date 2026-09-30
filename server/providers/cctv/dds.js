// bkk-watch: BMA Drainage and Sewerage (DDS) water-level cameras, scraped
// from the Leaflet markers on dds.bangkok.go.th/cctv.php. They point at canal
// staff gauges, so they are the closest thing to a flood-zone camera, but they
// are still images whose upload can stall: each name carries the image's age.
import { readFileSync } from 'node:fs';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import { toFiniteNumber, fallbackHeadingFromId } from './normalize.js';

export const DDS_CCTV_PAGE = 'https://dds.bangkok.go.th/cctv.php';
const DDS_ORIGIN = 'https://dds.bangkok.go.th';
const STALE_AFTER_MS = 60 * 60 * 1000;
// Last marker list parsed from cctv.php. On 2026-09-28 that page began
// serving the site's home page instead; the image URLs still answer.
const CAPTURED = new URL('./dds-markers.json', import.meta.url);

function capturedMarkers() {
  try {
    return JSON.parse(readFileSync(CAPTURED, 'utf8')).markers || [];
  } catch {
    return [];
  }
}
const MARKER_RE =
  /L\.marker\(\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\][^)]*\)\s*\.bindPopup\('([^'<]*)<br><br><img src="([^"]+)"/g;

/** Parse the page's markers into { lat, lon, name, imagePath }. */
export function parseDdsMarkers(html) {
  const out = [];
  for (const m of String(html).matchAll(MARKER_RE)) {
    const lat = toFiniteNumber(m[1]);
    const lon = toFiniteNumber(m[2]);
    const imagePath = m[4];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!/^\/[A-Za-z0-9_\-/]+\.jpe?g$/.test(imagePath)) continue;
    out.push({
      lat,
      lon,
      name: m[3].replace(/^CCTV\s*/, '').trim(),
      imagePath,
    });
  }
  return out;
}

/** "ภาพล่าสุด 28 ส.ค. 15:17" from an HTTP Last-Modified header. */
export function describeImageAge(lastModified, now = Date.now()) {
  const at = Date.parse(lastModified || '');
  if (!Number.isFinite(at)) return { stale: true, label: 'ไม่ทราบเวลาภาพ' };
  const when = new Date(at).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const stale = now - at > STALE_AFTER_MS;
  return { stale, label: `${stale ? 'ภาพค้าง · ' : ''}ภาพล่าสุด ${when}` };
}

const headers = {
  'User-Agent': 'Mozilla/5.0 (bkk-watch; +local)',
  Accept: 'text/html,image/*',
};

export async function loadDdsFloodSources({ fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(DDS_CCTV_PAGE, {
      headers,
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] DDS page download failed:', resp.status);
      return [];
    }
    const html = await resp.text();
    let markers = parseDdsMarkers(html);
    // Fall back to the captured list only when this really is the DDS site
    // answering with a page that lost its markers, not any empty response.
    if (!markers.length && html.includes('สำนักการระบายน้ำ')) {
      markers = capturedMarkers();
      console.warn(
        `[CCTV] DDS page has no camera markers; using ${markers.length} captured`,
      );
    }
    const sources = await Promise.all(
      markers.map(async (marker, index) => {
        const url = `${DDS_ORIGIN}${marker.imagePath}`;
        let age = describeImageAge(null);
        try {
          const head = await fetchImpl(url, {
            method: 'HEAD',
            headers,
            signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
          });
          age = describeImageAge(head.headers.get('last-modified'));
        } catch {
          /* keep "unknown" */
        }
        const id = `dds-flood-${index + 1}-${marker.imagePath
          .replace(/[^a-z0-9]/gi, '')
          .toLowerCase()
          .slice(-24)}`;
        return {
          id,
          name: `วัดระดับน้ำ ${marker.name} (${age.label})`,
          city: 'Bangkok',
          cityId: 'bangkok',
          provider: 'BMA DDS (flood)',
          lat: marker.lat,
          lon: marker.lon,
          headingDeg: fallbackHeadingFromId(id),
          headingConfidence: 'low',
          pitchDeg: -35,
          fovDeg: 50,
          rangeM: 40,
          mountHeightM: 4,
          groundElevationM: 2,
          feedType: 'image',
          url,
          snapshotUrl: url,
          sourceKind: 'dds-flood',
          license: 'สำนักการระบายน้ำ กรุงเทพมหานคร (dds.bangkok.go.th)',
        };
      }),
    );
    console.log(`[CCTV] Loaded DDS flood cameras: ${sources.length}`);
    return sources;
  } catch (error) {
    console.warn('[CCTV] DDS flood download error:', error?.message || error);
    return [];
  }
}
