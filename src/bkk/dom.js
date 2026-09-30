// Small shared helpers for the simple-mode shell.

/** el('div', { class, text, onclick, … }, ...children) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

export function distanceM(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) *
      Math.cos(bLat * rad) *
      Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

export const clock = (ms) =>
  new Date(ms).toLocaleTimeString('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
  });

export const dayClock = (ms) =>
  new Date(ms).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "44 นาทีที่แล้ว" / "3 ชม.ที่แล้ว" / "2 วันก่อน" */
export function ago(ms, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} ชม.ที่แล้ว` : `${Math.round(h / 24)} วันก่อน`;
}

export const km = (m) =>
  m < 950 ? `${Math.round(m / 10) * 10} ม.` : `${(m / 1000).toFixed(1)} กม.`;

const BKK = 'กรุงเทพมหานคร';
/** "อ.ไทรโยค จ.กาญจนบุรี" / "เขตบางเขน กรุงเทพฯ" */
export function placeLine(st) {
  if (st.province === BKK)
    return `${st.district ? `เขต${st.district} ` : ''}กรุงเทพฯ`;
  return [st.district && `อ.${st.district}`, st.province && `จ.${st.province}`]
    .filter(Boolean)
    .join(' ');
}
