// Flow lines: dots running along the river or canal a gauge stands on. They
// are SVG laid over the map (not in the WebGL scene) so the motion is plain
// CSS; every line is re-projected after each scene render.
import * as Cesium from 'cesium';

const SVG = 'http://www.w3.org/2000/svg';
const scratch = new Cesium.Cartesian2();

export function createFlowOverlay({ viewer }) {
  const root = document.createElementNS(SVG, 'svg');
  root.setAttribute('class', 'th-flow th-only');
  root.setAttribute('aria-hidden', 'true');
  document.body.append(root);
  /** @type {Map<string, { bed: SVGPathElement, run: SVGPathElement, carts: object[], d: string }>} */
  const lines = new Map();

  /**
   * Replace the lines drawn.
   * item: { id, points: [[lon, lat], …] in the direction of flow,
   *         pace: 'up' | 'flat' | 'down' }
   */
  function set(items) {
    const wanted = new Set(items.map((item) => item.id));
    for (const [id, line] of lines)
      if (!wanted.has(id)) {
        line.bed.remove();
        line.run.remove();
        lines.delete(id);
      }
    for (const item of items) {
      let line = lines.get(item.id);
      if (!line) {
        line = {
          bed: document.createElementNS(SVG, 'path'),
          run: document.createElementNS(SVG, 'path'),
          carts: item.points.map(([lon, lat]) =>
            Cesium.Cartesian3.fromDegrees(lon, lat),
          ),
          d: '',
        };
        line.bed.setAttribute('class', 'bed');
        root.append(line.bed, line.run);
        lines.set(item.id, line);
      }
      line.run.setAttribute('class', `run ${item.pace}`);
    }
    place();
  }

  function place() {
    if (!lines.size) return;
    const canvas = viewer.scene.canvas.getBoundingClientRect();
    for (const line of lines.values()) {
      let d = '';
      let pen = false;
      for (const cart of line.carts) {
        const p = viewer.scene.cartesianToCanvasCoordinates(cart, scratch);
        if (!p) {
          pen = false; // behind the globe: lift the pen
          continue;
        }
        d += `${pen ? 'L' : 'M'}${(canvas.left + p.x).toFixed(1)} ${(canvas.top + p.y).toFixed(1)}`;
        pen = true;
      }
      if (d === line.d) continue;
      line.d = d;
      line.bed.setAttribute('d', d);
      line.run.setAttribute('d', d);
    }
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
