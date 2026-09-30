// bkk-watch: EGAT dam cameras. Still images of ten large dams that EGAT's
// water page (egatwater.egat.co.th/RealTimeCCTV) rewrites about every half
// minute. That page carries no list with positions, so the dams are a table
// here; the coordinates and provinces are the ones ThaiWater's camera list
// gives (api-v3.thaiwater.net/api/v1/thaiwater30/analyst/cctv, read
// 2026-09-30), and the view counts are the image files that answered then.
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import { fallbackHeadingFromId } from './normalize.js';
import { provinceCityId } from './itic.js';
import { describeImageAge } from './dds.js';

export const EGAT_CCTV_PAGE = 'https://egatwater.egat.co.th/RealTimeCCTV';
const EGAT_IMAGES = 'https://egatwater.egat.co.th/assets/CCTV/images';

/** [code, name, province, lat, lon, views] — views are image files 1…n. */
export const EGAT_DAMS = Object.freeze([
  ['BB', 'เขื่อนภูมิพล', 'ตาก', 17.244115, 98.972687, 4],
  ['SK', 'เขื่อนสิริกิติ์', 'อุตรดิตถ์', 17.765071, 100.564845, 4],
  ['VRK', 'เขื่อนวชิราลงกรณ', 'กาญจนบุรี', 14.797449, 98.592847, 4],
  ['SNR', 'เขื่อนศรีนครินทร์', 'กาญจนบุรี', 14.407899, 99.128671, 4],
  ['RPB', 'เขื่อนรัชชประภา', 'สุราษฎร์ธานี', 8.966667, 98.783333, 4],
  ['BLG', 'เขื่อนบางลาง', 'ยะลา', 6.320278, 101.275833, 4],
  ['UR', 'เขื่อนอุบลรัตน์', 'ขอนแก่น', 16.75267, 102.632545, 1],
  ['NP', 'เขื่อนน้ำพุง', 'สกลนคร', 16.971667, 103.947222, 3],
  ['SRD', 'เขื่อนสิรินธร', 'อุบลราชธานี', 15.202778, 105.432222, 2],
  ['CLB', 'เขื่อนจุฬาภรณ์', 'ชัยภูมิ', 16.533333, 101.6525, 4],
]);

// The views of one dam share its position; a small ring keeps their dots
// apart on the map (about 55 m).
const RING_DEG = 0.0005;

const headers = {
  'User-Agent': 'Mozilla/5.0 (bkk-watch; +local)',
  Accept: 'image/*',
};

/** One dam view as a catalog source. `age` is from describeImageAge. */
export function egatViewToSource(
  [code, dam, province, lat, lon, views],
  view,
  age,
) {
  const id = `egat-${code.toLowerCase()}-${view}`;
  const turn = ((view - 1) / views) * 2 * Math.PI;
  const url = `${EGAT_IMAGES}/${code}/${view}.jpg`;
  return {
    id,
    // A fresh picture needs no time in its name; a stalled one says so.
    name: `${dam} · มุม ${view}${age?.stale ? ` (${age.label})` : ''}`,
    city: province,
    cityId: provinceCityId(province),
    provider: 'กฟผ. (EGAT)',
    lat: views > 1 ? lat + RING_DEG * Math.cos(turn) : lat,
    lon: views > 1 ? lon + RING_DEG * Math.sin(turn) : lon,
    headingDeg: fallbackHeadingFromId(id),
    headingConfidence: 'low',
    pitchDeg: -20,
    fovDeg: 60,
    rangeM: 200,
    mountHeightM: 10,
    groundElevationM: 0,
    feedType: 'image',
    url,
    snapshotUrl: url,
    sourceKind: 'egat-dam',
    license: 'การไฟฟ้าฝ่ายผลิตแห่งประเทศไทย (egatwater.egat.co.th)',
  };
}

/** Every dam view whose image answers right now. */
export async function loadEgatDamSources({ fetchImpl = fetch } = {}) {
  const wanted = EGAT_DAMS.flatMap((dam) =>
    Array.from({ length: dam[5] }, (_, i) => [dam, i + 1]),
  );
  const found = await Promise.all(
    wanted.map(async ([dam, view]) => {
      try {
        const head = await fetchImpl(`${EGAT_IMAGES}/${dam[0]}/${view}.jpg`, {
          method: 'HEAD',
          headers,
          signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
        });
        if (!head.ok) return null;
        if (!String(head.headers.get('content-type')).startsWith('image/'))
          return null;
        return egatViewToSource(
          dam,
          view,
          describeImageAge(head.headers.get('last-modified')),
        );
      } catch {
        return null;
      }
    }),
  );
  const sources = found.filter(Boolean);
  console.log(
    `[CCTV] Loaded EGAT dam cameras: ${sources.length} of ${wanted.length}`,
  );
  return sources;
}
