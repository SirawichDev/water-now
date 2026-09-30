// What can get through water of a given depth. General guidance, after the US
// National Weather Service's "Turn Around Don't Drown": 15 cm of moving water
// can knock a person over and reaches the floor of most cars, 30 cm floats
// many cars, 60 cm carries off pickups and SUVs. Not a substitute for judgment
// at the scene — the UI says so next to the result.

/** okBelow: fine under this depth; riskBelow: possible but risky under this. */
export const WAYS = Object.freeze([
  { id: 'walk', label: 'เดิน', okBelow: 15, riskBelow: 60 },
  { id: 'moto', label: 'มอเตอร์ไซค์', okBelow: 15, riskBelow: 25 },
  { id: 'car', label: 'รถเก๋ง', okBelow: 15, riskBelow: 30 },
  { id: 'pickup', label: 'กระบะ', okBelow: 30, riskBelow: 60 },
  {
    id: 'boat',
    label: 'เรือ',
    okBelow: Infinity,
    riskBelow: Infinity,
    minCm: 60,
  },
]);

/**
 * @param {number} cm water depth on the ground
 * @returns {Array<{ id: string, label: string, state: 'ok'|'risk'|'no' }>}
 */
export function passability(cm) {
  return WAYS.map((w) => {
    let state;
    if (w.minCm != null) state = cm >= w.minCm ? 'ok' : 'no';
    else state = cm < w.okBelow ? 'ok' : cm < w.riskBelow ? 'risk' : 'no';
    return { id: w.id, label: w.label, state };
  });
}

/** "ประมาณเข่า" — the body reference people use for a depth. */
export function bodyReference(cm) {
  if (cm <= 0) return 'แห้ง';
  if (cm <= 12) return 'ตาตุ่ม';
  if (cm <= 30) return 'ครึ่งแข้ง';
  if (cm <= 55) return 'เข่า';
  if (cm <= 75) return 'ต้นขา';
  if (cm <= 105) return 'เอว';
  if (cm <= 135) return 'อก';
  return 'ท่วมหัว';
}

export const formatDepth = (cm) =>
  cm >= 100 ? `${(cm / 100).toFixed(cm % 100 ? 1 : 0)} ม.` : `${cm} ซม.`;
