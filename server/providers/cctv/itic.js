// bkk-watch: Thailand road cameras from the iTIC Foundation feed that
// Longdo Traffic publishes. Snapshots are mostly placeholders upstream, so
// only cameras with an HTTPS HLS stream on iTIC's own hosts are kept.
import { createHash } from 'node:crypto';
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  toFiniteNumber,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';
import { readResponseJsonCapped } from '../common/http.js';

export const ITIC_CCTV_URL = 'https://camera.longdo.com/feed/?command=json';
const ITIC_STREAM_ORIGINS = new Set([
  'https://camera1.iticfoundation.org',
  'https://camerai1.iticfoundation.org',
]);
const BANGKOK = 'กรุงเทพมหานคร';
// Bangkok first when the catalog has to be trimmed.
const THAILAND_ANCHORS = [{ lat: 13.7563, lon: 100.5018 }];
const DEFAULT_ITIC_MAX_SOURCES = 400;

/** "(จ.ชลบุรี) 7 - ..." → { province: 'ชลบุรี', name: '7 - ...' } */
export function splitIticTitle(title) {
  const m = String(title || '').match(/^\((?:จ\.)?\s*([^)]+?)\s*\)\s*(.*)$/);
  if (!m) return null;
  return { province: m[1], name: m[2].trim() };
}

/** Stable ASCII city id per province; Bangkok keeps a readable one. */
export function provinceCityId(province) {
  if (province === BANGKOK) return 'bangkok';
  return `th-${createHash('sha1').update(province).digest('hex').slice(0, 8)}`;
}

/** Map one feed row to a CCTV source, or null when it is not usable. */
export function iticCameraToSource(row) {
  const title = String(row?.title || '').trim();
  const parts = splitIticTitle(title);
  if (!parts) return null;
  const lat = toFiniteNumber(row?.latitude);
  const lon = toFiniteNumber(row?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Thailand's bounding box: a bad coordinate cannot land abroad.
  if (lat < 5.5 || lat > 20.6 || lon < 97.3 || lon > 105.7) return null;

  let stream;
  try {
    stream = new URL(String(row?.hls_url || ''));
  } catch {
    return null;
  }
  if (
    !ITIC_STREAM_ORIGINS.has(stream.origin) ||
    stream.username ||
    stream.password ||
    !stream.pathname.endsWith('.m3u8')
  )
    return null;

  const camId = String(row?.camid || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(camId)) return null;
  const id = `itic-${camId.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
  const name = parts.name || camId;
  const credit = String(row?.sponsertext || row?.organization || 'iTIC');

  return {
    id,
    name,
    city: parts.province === BANGKOK ? 'Bangkok' : parts.province,
    cityId: provinceCityId(parts.province),
    province: parts.province,
    provider: 'iTIC Foundation',
    lat,
    lon,
    // The feed carries no heading; these are priors the viewer can calibrate.
    headingDeg: fallbackHeadingFromId(id),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 160,
    mountHeightM: 9,
    groundElevationM: 2,
    feedType: 'hls',
    url: stream.href,
    snapshotUrl: '',
    sourceKind: 'itic-longdo-feed',
    license: `iTIC Foundation / Longdo Traffic public camera feed — ${credit}`,
  };
}

/**
 * Keep cameras whose playlist answers right now. Most provincial DOH relays
 * return 502 upstream for long stretches; listing them only fills the wall
 * with dead tiles. Re-checked on every catalog refresh (15 min).
 */
async function keepLiveStreams(cameras, fetchImpl, concurrency = 8) {
  if (String(process.env.CCTV_ITIC_KEEP_DEAD || '') === '1') return cameras;
  const alive = new Array(cameras.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < cameras.length) {
      const i = next++;
      try {
        const res = await fetchImpl(cameras[i].url, {
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        const head = res.ok ? (await res.text()).slice(0, 7) : '';
        alive[i] = head === '#EXTM3U';
      } catch {
        alive[i] = false;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return cameras.filter((_, i) => alive[i]);
}

export async function loadIticSourcesFromFeed({ fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(ITIC_CCTV_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!resp.ok) {
      console.warn('[CCTV] iTIC source download failed:', resp.status);
      return [];
    }
    const rows = await readResponseJsonCapped(resp, 4 * 1024 * 1024);
    if (!Array.isArray(rows)) return [];
    const mapped = Array.from(
      new Map(
        rows
          .map(iticCameraToSource)
          .filter(Boolean)
          .map((camera) => [camera.id, camera]),
      ).values(),
    );
    const unique = await keepLiveStreams(mapped, fetchImpl);
    const maxRaw = Number(
      process.env.CCTV_ITIC_MAX_SOURCES || DEFAULT_ITIC_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(400, Math.floor(maxRaw)))
      : DEFAULT_ITIC_MAX_SOURCES;
    const prioritized = prioritizeSources(unique, maxCount, THAILAND_ANCHORS);
    console.log(
      `[CCTV] Loaded iTIC Thailand camera sources: ${prioritized.length} live of ${mapped.length}`,
    );
    return prioritized;
  } catch (error) {
    console.warn('[CCTV] iTIC source download error:', error?.message || error);
    return [];
  }
}
