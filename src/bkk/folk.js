// What residents report besides street depth — trash riding the water and
// food still on sale — shaped for the map, the list and the gauge detail.
// No DOM here; the marker snippets are plain strings.
import { distanceM } from './dom.js';

/** A report this close to a place (or to another report) is about it. */
export const SPOT_MATCH_M = 60;

/** OSM categories that sell food, most useful in a flood first. */
export const FOOD_KINDS = [
  ['marketplace', 'ตลาด'],
  ['convenience', 'ร้านสะดวกซื้อ'],
  ['supermarket', 'ซูเปอร์มาร์เก็ต'],
  ['restaurant', 'ร้านอาหาร'],
  ['fast_food', 'ร้านอาหารจานด่วน'],
  ['food_court', 'ศูนย์อาหาร'],
];

const ICON = {
  trash: 'https://api.iconify.design/tabler/trash-filled.svg',
  food: 'https://api.iconify.design/ph/bowl-food-fill.svg',
};
/** Filled markers carry a white glyph, outlined ones a grey one. */
const outlined = (spot) =>
  spot.kind === 'food' && spot.status !== 'open' ? '98A2B3' : 'ffffff';

export const spotIcon = (spot) =>
  `<img src="${ICON[spot.kind]}?color=%23${outlined(spot)}" alt="">`;

/** "trash blocking" / "food open" / "food unknown": the marker's CSS classes. */
export const spotClass = (spot) => `${spot.kind} ${spot.status}`;

export const STATUS_LABEL = {
  floating: 'ขยะลอยมากับน้ำ',
  blocking: 'ขยะอุดทางระบายน้ำ',
  clear: 'ไม่มีขยะแล้ว',
  open: 'ยังเปิดขาย',
  closed: 'ปิดแล้ว',
  unknown: 'ยังไม่มีใครยืนยัน',
};

/** The closest station within `maxM`, or null. */
export function nearestStation(stations, lat, lon, maxM = Infinity) {
  let best = null;
  let bestM = maxM;
  for (const s of stations) {
    const d = distanceM(lat, lon, s.lat, s.lon);
    if (d <= bestM) {
      best = s;
      bestM = d;
    }
  }
  return best;
}

/** The API's places by category → one list of places to eat, nearest first. */
export function foodPlaces(places) {
  return FOOD_KINDS.flatMap(([kind, kindLabel]) =>
    (places?.[kind] || []).map((p) => ({ ...p, kind, kindLabel })),
  ).sort((a, b) => a.distM - b.distM);
}

/** The reported spot of this kind at a point, or null. */
export function spotAt(spots, kind, lat, lon) {
  return (
    spots.find(
      (s) =>
        s.kind === kind && distanceM(s.lat, s.lon, lat, lon) <= SPOT_MATCH_M,
    ) || null
  );
}

/** The place a spot is about: the nearest one within reach, or null. */
export function placeOf(spot, places) {
  let best = null;
  let bestM = SPOT_MATCH_M;
  for (const p of places) {
    const d = distanceM(spot.lat, spot.lon, p.lat, p.lon);
    if (d <= bestM) {
      best = p;
      bestM = d;
    }
  }
  return best;
}

/**
 * place → what residents last said about it. Two shops side by side share no
 * report: each food spot speaks for its nearest place only.
 */
export function foodStatuses(places, spots) {
  const by = new Map();
  for (const s of spots) {
    if (s.kind !== 'food') continue;
    const place = placeOf(s, places);
    if (place && !by.has(place)) by.set(place, s);
  }
  return by;
}

/** Blocked drains first, then open food, then the rest; newest first inside. */
export function sortSpots(spots) {
  const rank = (s) =>
    s.status === 'blocking'
      ? 0
      : s.kind === 'trash'
        ? 1
        : s.status === 'open'
          ? 2
          : 3;
  return [...spots].sort(
    (a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt,
  );
}

/** Chip numbers: trash spots, and places still selling food. */
export function spotCounts(spots) {
  return {
    trash: spots.filter((s) => s.kind === 'trash').length,
    food: spots.filter((s) => s.kind === 'food' && s.status === 'open').length,
  };
}
