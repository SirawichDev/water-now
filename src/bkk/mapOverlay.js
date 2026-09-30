// HTML markers pinned to map coordinates: water ripples and light callout
// pills. They live in the DOM (not the WebGL scene) so Thai text is shaped by
// the browser and the animation is plain CSS; positions are refreshed after
// every scene render.
import * as Cesium from 'cesium';

const scratch = new Cesium.Cartesian2();

export function createMapOverlay({ viewer }) {
  const root = document.createElement('div');
  root.className = 'th-overlay th-only';
  document.body.append(root);
  /** @type {Map<string, Array<object>>} group → items */
  const groups = new Map();
  let bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };

  /**
   * Replace one group's markers.
   * item: { id, lat, lon, className, text?, html?, title?, onClick?, style?,
   *         priority?, collide? }
   */
  function set(group, items) {
    const old = groups.get(group) || [];
    const keep = new Map(old.map((it) => [it.id, it]));
    const next = items.map((item) => {
      const prev = keep.get(item.id);
      const el =
        prev?.el || document.createElement(item.onClick ? 'button' : 'span');
      keep.delete(item.id);
      el.className = item.className;
      if (item.onClick) el.type = 'button';
      // Rewriting unchanged markup would restart its CSS animations on every
      // camera move.
      if (item.html == null) el.textContent = item.text || '';
      else if (!prev || prev.html !== item.html) el.innerHTML = item.html;
      if (item.title) el.title = item.title;
      el.style.cssText = item.style || '';
      el.onclick = item.onClick || null;
      if (!el.isConnected) root.append(el);
      return {
        ...item,
        el,
        cart: Cesium.Cartesian3.fromDegrees(item.lon, item.lat),
        // Reuse the measured width only for an unchanged label.
        width:
          prev && prev.text === item.text && prev.html === item.html
            ? prev.width
            : 0,
        measured: Boolean(
          prev &&
          prev.text === item.text &&
          prev.html === item.html &&
          prev.measured,
        ),
      };
    });
    for (const gone of keep.values()) gone.el.remove();
    groups.set(group, next);
    place();
  }

  /** Markers inside this rectangle only (the map area not under panels). */
  function setBounds(next) {
    bounds = next;
    place();
  }

  function place() {
    const canvas = viewer.scene.canvas.getBoundingClientRect();
    const taken = [];
    // Higher priority first so they win collisions.
    const all = [...groups.values()]
      .flat()
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const it of all) {
      const p = viewer.scene.cartesianToCanvasCoordinates(it.cart, scratch);
      const x = p ? canvas.left + p.x : NaN;
      const y = p ? canvas.top + p.y : NaN;
      let show =
        p &&
        x >= bounds.left &&
        x <= bounds.right &&
        y >= bounds.top &&
        y <= bounds.bottom;
      if (show && it.collide) {
        it.width ||= 120;
        const rect = [x + 10, y - 13, x + 10 + it.width, y + 13];
        if (
          taken.some(
            (t) =>
              rect[0] < t[2] &&
              t[0] < rect[2] &&
              rect[1] < t[3] &&
              t[1] < rect[3],
          )
        )
          show = false;
        else taken.push(rect);
      }
      it.el.hidden = !show;
      if (show) {
        it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        // A hidden element has no width; measure once it is on screen.
        if (it.collide && !it.measured) {
          it.width = it.el.offsetWidth || it.width;
          it.measured = true;
        }
      }
    }
  }

  const stop = viewer.scene.postRender.addEventListener(place);
  addEventListener('resize', place);

  return {
    set,
    setBounds,
    place,
    destroy() {
      stop();
      removeEventListener('resize', place);
      root.remove();
    },
  };
}
