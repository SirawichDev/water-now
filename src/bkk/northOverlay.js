// The water from the north, drawn over the map while it is being followed: a
// wide blue band along the river with waves moving inside it and a brighter
// swell travelling north to south. It is an SVG laid over the map (not in the
// WebGL scene) and is re-projected after every scene render. It marks the
// river the water is travelling down; it is not a flood extent.
import * as Cesium from 'cesium';

const SVG = 'http://www.w3.org/2000/svg';
const BAND_KM = 24; // how wide the band is drawn on the ground
const scratch = new Cesium.Cartesian2();

const make = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function createNorthOverlay({ viewer }) {
  const root = make('svg', {
    class: 'th-northband th-only',
    'aria-hidden': 'true',
  });
  root.innerHTML = `<defs>
    <filter id="th-nb-soft"><feGaussianBlur stdDeviation="12"/></filter>
    <linearGradient id="th-nb-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1000">
      <stop offset="0" stop-color="#2F7BFF" stop-opacity=".35"/>
      <stop offset=".55" stop-color="#175CD3" stop-opacity=".9"/>
      <stop offset="1" stop-color="#175CD3" stop-opacity=".75"/>
    </linearGradient>
    <pattern id="th-nb-waves" width="44" height="16" patternUnits="userSpaceOnUse">
      <path d="M0 8 Q11 2 22 8 T44 8" fill="none" stroke="#fff" stroke-width="2.2"/>
      <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="0 32" dur="2.4s" repeatCount="indefinite"/>
    </pattern>
    <radialGradient id="th-nb-crest">
      <stop offset="0" stop-color="#9DBCFF" stop-opacity=".95"/>
      <stop offset=".5" stop-color="#2F7BFF" stop-opacity=".45"/>
      <stop offset="1" stop-color="#2F7BFF" stop-opacity="0"/>
    </radialGradient>
    <path id="th-nb-path" d=""/>
  </defs>
  <use href="#th-nb-path" class="zone"/>
  <use href="#th-nb-path" class="core"/>
  <use href="#th-nb-path" class="waves"/>
  <use href="#th-nb-path" class="flow"/>
  <circle class="crest" r="50">
    <animateMotion dur="7s" repeatCount="indefinite"><mpath href="#th-nb-path"/></animateMotion>
  </circle>`;
  document.body.append(root);
  const path = root.querySelector('#th-nb-path');
  const grad = root.querySelector('#th-nb-grad');
  const crest = root.querySelector('.crest');
  let carts = [];
  let last = '';

  /** [[lon, lat], …] north to south, or null to hide. */
  function set(points) {
    carts = (points || []).map(([lon, lat]) =>
      Cesium.Cartesian3.fromDegrees(lon, lat),
    );
    root.classList.toggle('on', carts.length > 1);
    last = '';
    place();
  }

  function place() {
    if (carts.length < 2) return;
    const scene = viewer.scene;
    const canvas = scene.canvas.getBoundingClientRect();
    const xy = carts
      .map((c) => scene.cartesianToCanvasCoordinates(c, scratch)?.clone?.())
      .filter(Boolean)
      .map((p) => [canvas.left + p.x, canvas.top + p.y]);
    if (xy.length < 2) return;
    const d = xy
      .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ');
    if (d === last) return;
    last = d;
    path.setAttribute('d', d);
    // The band is a fixed width on the ground, so it narrows as you zoom out.
    const pxPerKm = pxPerKmAt(scene, carts[Math.floor(carts.length / 2)]);
    const w = Math.max(48, Math.min(160, BAND_KM * pxPerKm));
    root.style.setProperty('--band', `${w.toFixed(0)}px`);
    crest.setAttribute('r', (w * 0.7).toFixed(0));
    const ys = xy.map(([, y]) => y);
    grad.setAttribute('y1', String(Math.min(...ys)));
    grad.setAttribute('y2', String(Math.max(...ys)));
  }

  function pxPerKmAt(scene, cart) {
    const carto = Cesium.Cartographic.fromCartesian(cart);
    const a = scene.cartesianToCanvasCoordinates(cart, new Cesium.Cartesian2());
    const b = scene.cartesianToCanvasCoordinates(
      Cesium.Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude + 0.1 * (Math.PI / 180),
      ),
      new Cesium.Cartesian2(),
    );
    if (!a || !b) return 1;
    return Math.hypot(a.x - b.x, a.y - b.y) / 11.1; // 0.1° of latitude ≈ 11.1 km
  }

  const stop = viewer.scene.postRender.addEventListener(place);
  return {
    set,
    destroy() {
      stop();
      root.remove();
    },
  };
}
