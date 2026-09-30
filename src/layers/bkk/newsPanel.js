// Floating player for the Bangkok news layer: click a zone on the map, watch
// its clips with PREV/NEXT, hop between zones — the CCTV panel's workflow for
// news. Clips play in YouTube's own embed player.
const TOPIC_LABEL = {
  flood: 'น้ำท่วม',
  outage: 'ไฟดับ',
  fire: 'ไฟไหม้',
  traffic: 'จราจร',
};

const CSS = `
.bkk-news-panel{position:fixed;left:24px;bottom:120px;z-index:40;width:min(400px,calc(100vw - 48px));
  background:rgba(8,14,20,.92);border:1px solid rgba(117,231,255,.35);border-radius:8px;color:#dbe7ee;
  font:13px/1.45 system-ui,'Noto Sans Thai',sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden}
.bkk-news-panel[hidden]{display:none}
.bkk-news-panel header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(117,231,255,.2)}
.bkk-news-panel header strong{flex:1;font:600 12px/1.2 ui-monospace,monospace;letter-spacing:.08em;color:#75e7ff;text-transform:uppercase}
.bkk-news-panel button{background:rgba(117,231,255,.08);color:#dbe7ee;border:1px solid rgba(117,231,255,.3);
  border-radius:4px;padding:4px 8px;font:600 11px/1.2 ui-monospace,monospace;letter-spacing:.06em;cursor:pointer}
.bkk-news-panel button:hover{background:rgba(117,231,255,.18)}
.bkk-news-panel button:disabled{opacity:.35;cursor:default}
.bkk-news-panel .player{aspect-ratio:16/9;background:#000}
.bkk-news-panel iframe,.bkk-news-panel video,.bkk-news-panel .player img{width:100%;height:100%;border:0;display:block;object-fit:contain;background:#000}
.bkk-news-panel .player [hidden]{display:none}
.bkk-news-panel .body{padding:8px 10px}
.bkk-news-panel .title{margin:0 0 4px;font-size:13px}
.bkk-news-panel .meta{color:#8fa3b0;font-size:11px}
.bkk-news-panel .row{display:flex;gap:6px;align-items:center;padding:0 10px 8px}
.bkk-news-panel .row .count{flex:1;text-align:center;color:#8fa3b0;font:11px ui-monospace,monospace}
.bkk-news-panel a{color:#75e7ff}
`;

function ago(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ชม.ที่แล้ว` : `${Math.round(h / 24)} วันที่แล้ว`;
}

/**
 * @param {object} opts
 * @param {() => Array} opts.getZones  current zone groups (newest data)
 * @param {(zone: object) => void} opts.flyTo  move the map to a zone
 */
// The news and camera players share one corner of the map. Where the page
// lays them out side by side both stay open; where they would cover each
// other (advanced mode, phones, a narrow map) the one opened last wins.
const MIN_SHARED_WIDTH = 260;
const players = new Set();

/**
 * @param {{ el: HTMLElement, close: () => void }} player
 * @returns {{ opened: () => void, release: () => void }}
 */
export function sharePlayerCorner(player) {
  players.add(player);
  return {
    /** Call after showing the player. */
    opened() {
      const mine = player.el.getBoundingClientRect();
      for (const other of players) {
        if (other === player || other.el.hidden) continue;
        const r = other.el.getBoundingClientRect();
        const apart =
          mine.right <= r.left ||
          r.right <= mine.left ||
          mine.bottom <= r.top ||
          r.bottom <= mine.top;
        if (!apart || mine.width < MIN_SHARED_WIDTH) other.close();
      }
    },
    release: () => players.delete(player),
  };
}

/** Shared by the news and camera players; injected once. */
export function ensurePanelCss() {
  if (document.getElementById('bkk-news-panel-css')) return;
  const style = document.createElement('style');
  style.id = 'bkk-news-panel-css';
  style.textContent = CSS;
  document.head.append(style);
}

export function createNewsPanel({ getZones, flyTo }) {
  ensurePanelCss();
  const el = document.createElement('section');
  el.className = 'bkk-news-panel';
  el.hidden = true;
  el.setAttribute('aria-label', 'ข่าวตามโซน');
  el.innerHTML = `
    <header><strong></strong><button type="button" data-act="close" aria-label="ปิด">✕</button></header>
    <div class="player"></div>
    <div class="body"><p class="title"></p><div class="meta"></div></div>
    <div class="row">
      <button type="button" data-act="prev">◀ PREV</button>
      <span class="count"></span>
      <button type="button" data-act="next">NEXT ▶</button>
    </div>
    <div class="row">
      <button type="button" data-act="prev-zone">◀ โซน</button>
      <span class="count"><a data-act="page" target="_blank" rel="noopener">ดูทั้งหมด</a></span>
      <button type="button" data-act="next-zone">โซน ▶</button>
    </div>`;
  document.body.append(el);

  let zoneName = null;
  let index = 0;
  let playingId = null;

  const zones = () =>
    [...getZones()].sort((a, b) => b.items.length - a.items.length);
  const current = () => zones().find((z) => z.zone === zoneName) || null;

  function render() {
    const zone = current();
    if (!zone) return close();
    const items = [...zone.items].sort(
      (a, b) => (b.publishedAt || 0) - (a.publishedAt || 0),
    );
    index = Math.min(index, items.length - 1);
    const item = items[index];
    el.querySelector('header strong').textContent =
      `ข่าว · ${zone.zone.replace(/^(แขวง|เขต)/, '')}`;
    if (playingId !== item.id) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}?autoplay=1&rel=0`;
      iframe.allow =
        'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true;
      iframe.title = item.title;
      el.querySelector('.player').replaceChildren(iframe);
      playingId = item.id;
    }
    el.querySelector('.title').textContent = item.title;
    const topics = item.topics.map((t) => TOPIC_LABEL[t] || t).join(' · ');
    el.querySelector('.meta').textContent =
      `${item.channel}${item.live ? ' · LIVE' : ''} · ${ago(item.publishedAt)}${topics ? ` · ${topics}` : ''}`;
    el.querySelector('.row .count').textContent =
      `${index + 1} / ${items.length}`;
    el.querySelector('[data-act="prev"]').disabled = index === 0;
    el.querySelector('[data-act="next"]').disabled = index >= items.length - 1;
    el.querySelector('[data-act="page"]').href =
      `/bkk-news.html?zone=${encodeURIComponent(zone.zone)}`;
  }

  function open(name) {
    if (name !== zoneName) index = 0;
    zoneName = name;
    el.hidden = false;
    render();
    corner.opened();
  }

  function close() {
    el.hidden = true;
    zoneName = null;
    playingId = null;
    el.querySelector('.player').replaceChildren(); // stop playback
  }

  function hopZone(step) {
    const list = zones();
    if (!list.length) return;
    const at = list.findIndex((z) => z.zone === zoneName);
    const next = list[(at + step + list.length) % list.length];
    flyTo(next);
    open(next.zone);
  }

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'prev') (index--, render());
    if (act === 'next') (index++, render());
    if (act === 'prev-zone') hopZone(-1);
    if (act === 'next-zone') hopZone(1);
  });
  const onKey = (e) => e.key === 'Escape' && !el.hidden && close();
  document.addEventListener('keydown', onKey);
  const corner = sharePlayerCorner({ el, close });

  return {
    open,
    close,
    /** Re-render after new data, keeping the clip that is playing. */
    refresh: () => zoneName && render(),
    destroy() {
      corner.release();
      document.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}
