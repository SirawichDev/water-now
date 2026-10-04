// Floating camera player for simple mode: click a camera dot, watch the
// stream (or, for a still-image camera, its picture refreshed every half
// minute), step to the next-nearest camera. Same proxy and decoder as GEV's
// CCTV panel, without its operator controls.
import { attachCctvVideo } from '../cctv/videoPlayback.js';
import { ensurePanelCss, sharePlayerCorner } from './newsPanel.js';

const STILL_REFRESH_MS = 30_000;
// A live stream normally plays within a second or two; past this the panel
// says it is still trying instead of showing a silent black box.
const SLOW_MS = 8000;
const UNAVAILABLE = 'กล้องนี้ไม่มีภาพในขณะนี้ · ลองกล้องใกล้เคียง ▶';

function distanceM(a, b) {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

/**
 * @param {object} opts
 * @param {() => Array} opts.getCameras  current camera records
 * @param {(camera: object) => void} opts.flyTo
 */
export function createCamPanel({ getCameras, flyTo }) {
  ensurePanelCss();
  const el = document.createElement('section');
  el.className = 'bkk-news-panel bkk-cam-panel';
  el.hidden = true;
  el.setAttribute('aria-label', 'กล้องสด');
  el.innerHTML = `
    <header><strong></strong><button type="button" data-act="close" aria-label="ปิด">✕</button></header>
    <div class="player"><video muted playsinline autoplay></video><img alt="" hidden></div>
    <div class="body"><p class="title"></p><div class="meta"></div></div>
    <div class="row">
      <button type="button" data-act="prev">◀ ใกล้เคียง</button>
      <span class="count"><a href="/bkk-cams.html" target="_blank" rel="noopener">ผนังกล้อง</a></span>
      <button type="button" data-act="next">ใกล้เคียง ▶</button>
    </div>`;
  document.body.append(el);
  const video = el.querySelector('video');
  const still = el.querySelector('.player img');
  const meta = el.querySelector('.meta');
  let current = null;
  let playback = null;
  let stillTimer = null;
  let slowTimer = null;
  const history = [];

  function stop() {
    playback?.dispose();
    playback = null;
    clearInterval(stillTimer);
    stillTimer = null;
    clearTimeout(slowTimer);
    slowTimer = null;
    if (still.src) URL.revokeObjectURL(still.src);
    still.removeAttribute('src');
  }

  /** One picture from a still-image camera. */
  async function loadStill(camera) {
    try {
      const res = await fetch(
        `/api/cctv/frame/${encodeURIComponent(camera.id)}?t=${Date.now()}`,
      );
      // When a camera does not answer the server may send a Street View
      // frame instead; that is not this camera's picture, so it is refused.
      if (!res.ok || res.headers.get('x-cctv-source') !== 'upstream-image')
        throw new Error('no frame');
      const blob = await res.blob();
      if (current !== camera) return;
      if (still.src) URL.revokeObjectURL(still.src);
      still.src = URL.createObjectURL(blob);
      meta.textContent = `ภาพนิ่ง อัปเดตทุก ${STILL_REFRESH_MS / 1000} วินาที · ${camera.provider}`;
    } catch {
      if (current === camera) meta.textContent = UNAVAILABLE;
    }
  }

  function open(camera, { remember = true } = {}) {
    if (remember && current) history.push(current.id);
    current = camera;
    stop();
    el.hidden = false;
    const live = camera.feedType === 'hls';
    el.querySelector('header strong').textContent =
      `${live ? 'กล้องสด' : 'กล้อง (ภาพนิ่ง)'} · ${camera.city === 'Bangkok' ? 'กรุงเทพฯ' : camera.city}`;
    el.querySelector('.title').textContent = camera.name;
    meta.textContent = 'กำลังเชื่อมต่อ…';
    video.hidden = !live;
    still.hidden = live;
    if (!live) {
      loadStill(camera);
      stillTimer = setInterval(() => loadStill(camera), STILL_REFRESH_MS);
      corner.opened();
      return;
    }
    slowTimer = setTimeout(() => {
      if (current === camera)
        meta.textContent =
          'ยังเชื่อมต่อไม่ได้ กล้องอาจปิดอยู่ · ลองกล้องใกล้เคียง ▶';
    }, SLOW_MS);
    playback = attachCctvVideo(
      video,
      `/api/cctv/media/${encodeURIComponent(camera.id)}`,
      'hls',
      {
        onFailure: () => {
          clearTimeout(slowTimer);
          if (current === camera) meta.textContent = UNAVAILABLE;
        },
      },
    );
    corner.opened();
  }
  video.addEventListener('playing', () => {
    clearTimeout(slowTimer);
    if (current) meta.textContent = `● ถ่ายทอดสด · ${current.provider}`;
  });

  function close() {
    stop();
    el.hidden = true;
    current = null;
    history.length = 0;
  }

  /** Nearest camera not already visited in this session. */
  function hop(back) {
    if (!current) return;
    const cameras = getCameras();
    if (back) {
      const id = history.pop();
      const prev = cameras.find((c) => c.id === id);
      if (prev) {
        flyTo(prev);
        open(prev, { remember: false });
      }
      return;
    }
    const seen = new Set([...history, current.id]);
    const next = cameras
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => distanceM(current, a) - distanceM(current, b))[0];
    if (!next) return;
    flyTo(next);
    open(next);
  }

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'prev') hop(true);
    if (act === 'next') hop(false);
  });
  const onKey = (e) => e.key === 'Escape' && !el.hidden && close();
  document.addEventListener('keydown', onKey);
  const corner = sharePlayerCorner({ el, close });

  return {
    open,
    close,
    destroy() {
      corner.release();
      stop();
      document.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}
