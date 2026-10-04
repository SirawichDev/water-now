// Hail zones drawn over the map: a storm-slate circle with ice falling inside
// while the report is fresh, a dashed edge until a second kind of evidence
// confirms it, and a label that opens the warning. Like the river band it is
// an SVG laid over the map and re-projected after every scene render. The
// circle is the area the evidence names, not the storm's real edge.
import * as Cesium from 'cesium';
import { hailName, hailStage } from './hail.js';

const SVG = 'http://www.w3.org/2000/svg';
const MIN_PX = 14; // a zone stays findable from the whole-country view
const scratch = new Cesium.Cartesian2();

const make = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function createHailOverlay({ viewer, onOpen }) {
  const root = document.createElement('div');
  root.className = 'th-hail th-only';
  const svg = make('svg', { 'aria-hidden': 'true' });
  svg.innerHTML = `<defs>
    <radialGradient id="th-hail-halo">
      <stop offset="0" stop-color="#344054" stop-opacity=".34"/>
      <stop offset=".72" stop-color="#344054" stop-opacity=".2"/>
      <stop offset="1" stop-color="#344054" stop-opacity="0"/>
    </radialGradient>
    <pattern id="th-hail-ice" width="38" height="38" patternUnits="userSpaceOnUse">
      <rect x="6" y="4" width="6.5" height="6.5" rx="2.4" fill="#fff" stroke="#475467" stroke-width="1" transform="rotate(18 9 7)"/>
      <rect x="24" y="17" width="5" height="5" rx="2" fill="#fff" stroke="#475467" stroke-width="1"/>
      <rect x="10" y="27" width="4.2" height="4.2" rx="1.6" fill="#fff" stroke="#475467" stroke-width=".9" transform="rotate(-22 12 29)"/>
      <path d="M31 2 l-3 6 M16 14 l-3 6 M35 27 l-3 6" stroke="#98A2B3" stroke-width="1" stroke-linecap="round"/>
      <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="-12 38" dur="1.1s" repeatCount="indefinite"/>
    </pattern>
    <pattern id="th-hail-ice2" x="19" y="11" width="53" height="47" patternUnits="userSpaceOnUse">
      <rect x="30" y="8" width="4" height="4" rx="1.6" fill="#fff" stroke="#667085" stroke-width=".9"/>
      <rect x="9" y="30" width="5.5" height="5.5" rx="2.2" fill="#fff" stroke="#475467" stroke-width="1" transform="rotate(30 12 33)"/>
      <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="-17 47" dur="1.6s" repeatCount="indefinite"/>
    </pattern>
  </defs>`;
  root.append(svg);
  document.body.append(root);

  let zones = [];
  let parts = []; // per zone: { g, halo, clip, ice, ring, tag, cart }
  let last = '';

  /** Draw these zones (the live ones), or [] to clear. */
  function set(next, now = Date.now()) {
    for (const p of parts) {
      p.g.remove();
      p.clipEl.remove();
      p.tag.remove();
    }
    zones = next || [];
    parts = zones.map((z, i) => {
      const stage = hailStage(z, now);
      const clipEl = make('clipPath', { id: `th-hail-clip-${i}` });
      const clip = make('circle');
      clipEl.append(clip);
      svg.querySelector('defs').append(clipEl);
      const g = make('g', {
        class: `zone ${stage}${z.confirmed ? ' confirmed' : ''}`,
      });
      const halo = make('circle', {
        class: 'halo',
        fill: 'url(#th-hail-halo)',
      });
      const ice = make('g', { 'clip-path': `url(#th-hail-clip-${i})` });
      const ice1 = make('rect', { fill: 'url(#th-hail-ice)', opacity: '.9' });
      const ice2 = make('rect', { fill: 'url(#th-hail-ice2)', opacity: '.75' });
      ice.append(ice1, ice2);
      const ring = make('circle', { class: 'ring' });
      g.append(halo, ...(stage === 'active' ? [ice] : []), ring);
      svg.append(g);
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = `th-hailtag${z.confirmed ? ' confirmed' : ''} ${stage}`;
      tag.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="5" r="2.2"/><circle cx="11" cy="8" r="2.2"/><circle cx="6" cy="12" r="2"/></svg>';
      tag.append(
        `ลูกเห็บ · ${hailName(z)} `,
        Object.assign(document.createElement('small'), {
          textContent: `รัศมีราว ${(z.radiusM / 1000).toFixed(1)} กม.`,
        }),
      );
      tag.addEventListener('click', () => onOpen?.(z.id));
      root.append(tag);
      return {
        g,
        clipEl,
        clip,
        halo,
        rects: [ice1, ice2],
        ring,
        tag,
        radiusM: z.radiusM,
        cart: Cesium.Cartesian3.fromDegrees(z.lon, z.lat),
        carto: Cesium.Cartographic.fromDegrees(z.lon, z.lat),
      };
    });
    root.classList.toggle('on', parts.length > 0);
    last = '';
    place();
  }

  function place() {
    if (!parts.length) return;
    const scene = viewer.scene;
    const box = scene.canvas.getBoundingClientRect();
    const spots = parts.map((p) => {
      const c = scene.cartesianToCanvasCoordinates(p.cart, scratch);
      if (!c) return null;
      // Radius from how far a point the zone's radius north of centre lands.
      const edge = scene.cartesianToCanvasCoordinates(
        Cesium.Cartesian3.fromRadians(
          p.carto.longitude,
          p.carto.latitude + p.radiusM / 6_371_000,
        ),
        new Cesium.Cartesian2(),
      );
      const x = box.left + c.x;
      const y = box.top + c.y;
      const r = edge ? Math.hypot(edge.x - c.x, edge.y - c.y) : MIN_PX;
      return [x, y, Math.max(MIN_PX, r)];
    });
    const key = JSON.stringify(spots.map((s) => s && s.map(Math.round)));
    if (key === last) return;
    last = key;
    parts.forEach((p, i) => {
      const s = spots[i];
      p.g.style.display = s ? '' : 'none';
      p.tag.hidden = !s;
      if (!s) return;
      const [x, y, r] = s;
      for (const [node, rr] of [
        [p.halo, r * 1.27],
        [p.ring, r],
        [p.clip, r],
      ]) {
        node.setAttribute('cx', x.toFixed(1));
        node.setAttribute('cy', y.toFixed(1));
        node.setAttribute('r', rr.toFixed(1));
      }
      for (const rect of p.rects) {
        rect.setAttribute('x', (x - r).toFixed(1));
        rect.setAttribute('y', (y - r).toFixed(1));
        rect.setAttribute('width', (2 * r).toFixed(1));
        rect.setAttribute('height', (2 * r).toFixed(1));
      }
      p.tag.style.transform = `translate(${x.toFixed(1)}px, ${(y - r - 14).toFixed(1)}px) translate(-50%, -100%)`;
    });
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
