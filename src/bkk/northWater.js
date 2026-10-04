// "น้ำเหนือ": water from the north travelling down the Chao Phraya to Bangkok.
// The main river's gauges, read north to south, show it as it moves: flow
// against the channel's capacity where RID measures flow, and level against
// the bank everywhere. No DOM here.

/**
 * The main stem of the Chao Phraya, north to south, by RID/ThaiWater station
 * code. Nakhon Sawan is where the Ping and the Nan meet; C.13 is the
 * Chao Phraya Dam's release at Chai Nat.
 */
export const CHAO_PHRAYA = Object.freeze([
  'C.2', // ค่ายจิรประวัติ นครสวรรค์
  'C.13', // ท้ายเขื่อนเจ้าพระยา ชัยนาท
  'C.3', // บ้านบางพุทรา สิงห์บุรี
  'C.7A', // บ้านบางแก้ว อ่างทอง
  'C.35', // บ้านป้อม พระนครศรีอยุธยา
  'CPY014', // สะพานนวลฉวี นนทบุรี
  'C.12', // กรมชลประทานสามเสน กรุงเทพฯ
  'CPY015', // สะพานกรุงเทพ กรุงเทพฯ
]);
/** The two stations whose flow is the water arriving from the north. */
const UPSTREAM = ['C.2', 'C.13'];

// A stop is "near" from this share of the bank or of the channel's capacity.
const NEAR_LEVEL = 90;
const NEAR_FLOW = 0.8;
// The river as a whole: how hard the water from the north is pushing.
const WATCH_FLOW = 0.7;
const PREPARE_FLOW = 0.8;

/** over | near | ok, from level against the bank and flow against capacity. */
export function stopStatus(st) {
  const ratio = flowRatio(st);
  if (st.storagePercent > 100 || ratio > 1) return 'over';
  if (st.storagePercent >= NEAR_LEVEL || ratio >= NEAR_FLOW) return 'near';
  return 'ok';
}

export function flowRatio(st) {
  return Number.isFinite(st.flow) && st.capacity > 0
    ? st.flow / st.capacity
    : null;
}

/**
 * The state of the water from the north.
 * @returns {{
 *   stops: Array<object>,       // stations found, north to south, with status
 *   upstream: number|null,      // highest flow/capacity at C.2 and C.13
 *   severity: 'none'|'watch'|'prepare',
 *   impact: string[],           // provinces from the first stop at risk downstream
 *   first: number,              // index in stops of that first stop, or -1
 * }}
 */
export function northWater(stations, chain = CHAO_PHRAYA) {
  const byCode = new Map(
    stations.filter((s) => s.code && !s.stale).map((s) => [s.code, s]),
  );
  const stops = chain
    .map((code) => byCode.get(code))
    .filter(Boolean)
    .map((s) => ({ ...s, ratio: flowRatio(s), status: stopStatus(s) }));
  const ratios = stops
    .filter((s) => UPSTREAM.includes(s.code) && s.ratio != null)
    .map((s) => s.ratio);
  const upstream = ratios.length ? Math.max(...ratios) : null;
  const anyOver = stops.some((s) => s.status === 'over');
  const severity =
    anyOver && upstream >= PREPARE_FLOW
      ? 'prepare'
      : anyOver || upstream >= WATCH_FLOW
        ? 'watch'
        : 'none';
  const first = stops.findIndex((s) => s.status !== 'ok');
  const impact =
    severity === 'none' || first < 0
      ? []
      : [...new Set(stops.slice(first).map((s) => s.province))];
  return { stops, upstream, severity, impact, first };
}
