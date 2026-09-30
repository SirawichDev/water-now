// Numbers behind the map's sized circles and the 72-hour replay. No DOM here.

/** Metres of water above the bank, or null without a bank reference. */
export function overMetres(st) {
  const d = st.waterLevelMsl - st.bankMsl;
  return Number.isFinite(d) ? d : null;
}

/** The same figure from a historical percent of bank-full depth. */
export function overMetresAt(percent, st) {
  const full = st.bankMsl - st.groundMsl;
  if (!Number.isFinite(full) || full <= 0 || percent == null) return null;
  return (percent / 100 - 1) * full;
}

/**
 * Circle radius in pixels. Area grows with metres over the bank, and the whole
 * set shrinks as the camera rises so a country view is not one red blob.
 */
export function bubbleRadius(metres, cameraHeightM) {
  const scale = Math.max(0.3, Math.min(1.2, 500_000 / cameraHeightM));
  return (5 + 7 * Math.sqrt(Math.max(0, metres || 0))) * scale;
}

/** Below this radius a circle is too small to show a water level inside. */
export const TANK_MIN_RADIUS = 9;
/**
 * Below this camera height gauges are far enough apart on screen for every
 * one at or near its bank to be a readable tank.
 */
export const TANK_ZOOM_M = 120_000;

/** An over-bank gauge's circle: never smaller than a tank once zoomed in. */
export function circleRadius(metres, cameraHeightM) {
  const r = bubbleRadius(metres, cameraHeightM);
  return cameraHeightM < TANK_ZOOM_M ? Math.max(r, TANK_MIN_RADIUS + 1) : r;
}
const TANK_BANK_AT = 50; // % of the circle's height where the bank line sits

/**
 * Water height inside a gauge's circle, in percent of the circle. The bank
 * line is at half height, so 100% of bank-full depth fills exactly half.
 */
export function tankFill(percent) {
  return Math.max(8, Math.min(92, ((percent || 0) * TANK_BANK_AT) / 100));
}

/** How the over-bank gauges moved since their previous reading. */
export function trendCounts(stations) {
  const counts = { up: 0, flat: 0, down: 0 };
  for (const s of stations) {
    if (s.stale || s.level < 5) continue;
    if (s.changeM > 0) counts.up++;
    else if (s.changeM < 0) counts.down++;
    else counts.flat++;
  }
  return counts;
}

/**
 * What the map shows at one hour of the replay: stations at or near the bank
 * then, with the metres each stood above it.
 * @returns {Array<{ id, lat, lon, percent, over: boolean, metres: number|null }>}
 */
export function frameAt(timeline, index, stationsById) {
  const out = [];
  for (const [id, values] of Object.entries(timeline?.series || {})) {
    const percent = values[index];
    const st = stationsById.get(id);
    if (percent == null || percent <= 70 || !st) continue;
    out.push({
      id,
      lat: st.lat,
      lon: st.lon,
      percent,
      over: percent > 100,
      metres: overMetresAt(percent, st),
    });
  }
  return out;
}

/** Bangkok-midnight positions inside an hourly axis: [{ index, t }]. */
export function dayMarks(hours) {
  const marks = [];
  hours.forEach((t, index) => {
    if (((t + 7 * 3600_000) / 3600_000) % 24 === 0) marks.push({ index, t });
  });
  return marks;
}
