// bkk-watch news page: YouTube news clips placed on Bangkok zones by the
// alert service (/api/bkk/news). Clips play through YouTube's own embed
// player, loaded only when clicked.
import { subscribeBkkUpdates } from '../layers/bkk/source.js';

const TOPIC_LABEL = {
  flood: 'น้ำท่วม',
  outage: 'ไฟดับ',
  fire: 'ไฟไหม้',
  traffic: 'จราจร',
};

const list = document.getElementById('list');
const zonesNav = document.getElementById('zones');
const summary = document.getElementById('summary');
const topicSelect = document.getElementById('topic');

let items = [];
let zone = new URLSearchParams(location.search).get('zone') || '';
topicSelect.value = new URLSearchParams(location.search).get('topic') || '';

const shortZone = (z) => z.replace(/^(แขวง|เขต)/, '');

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ชม.ที่แล้ว` : `${Math.round(h / 24)} วันที่แล้ว`;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (zone) p.set('zone', zone);
  if (topicSelect.value) p.set('topic', topicSelect.value);
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
}

function renderZones(visible) {
  const counts = new Map();
  for (const i of visible) counts.set(i.zone, (counts.get(i.zone) || 0) + 1);
  zonesNav.textContent = '';
  const chips = [
    ['', `ทุกโซน (${visible.length})`],
    ...[...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([z, n]) => [z, `${shortZone(z)} (${n})`]),
  ];
  for (const [value, label] of chips) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(zone === value));
    b.addEventListener('click', () => {
      zone = value;
      syncUrl();
      render();
    });
    zonesNav.append(b);
  }
}

function card(item) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="player" role="button" tabindex="0" aria-label="เล่นคลิป">
      <img loading="lazy" alt="">
      <span class="play" aria-hidden="true">▶</span>
    </div>
    <div class="body">
      <p class="title"></p>
      <div class="meta"></div>
    </div>`;
  el.querySelector('img').src = item.thumbnail;
  el.querySelector('.title').textContent = item.title;
  if (item.live)
    el.querySelector('.player').insertAdjacentHTML(
      'beforeend',
      '<span class="live">LIVE</span>',
    );
  const meta = el.querySelector('.meta');
  for (const t of item.topics) {
    const tag = document.createElement('span');
    tag.className = `tag ${t}`;
    tag.textContent = TOPIC_LABEL[t] || t;
    meta.append(tag);
  }
  const place = document.createElement('span');
  place.className = 'place';
  place.textContent = `📍 ${[...new Set(item.places.map((p) => shortZone(p.name).replace(/^ถนน/, 'ถ.')))].join(', ')}`;
  meta.append(place, document.createElement('br'));
  meta.append(`${item.channel} · ${ago(item.publishedAt)} · `);
  const link = document.createElement('a');
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'YouTube';
  meta.append(link);

  const player = el.querySelector('.player');
  const play = () => {
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}?autoplay=1&rel=0`;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.title = item.title;
    player.replaceChildren(iframe);
    player.style.cursor = 'default';
  };
  player.addEventListener('click', play, { once: true });
  player.addEventListener('keydown', (e) => e.key === 'Enter' && play(), {
    once: true,
  });
  return el;
}

function render() {
  const topic = topicSelect.value;
  const byTopic = topic ? items.filter((i) => i.topics.includes(topic)) : items;
  if (zone && !byTopic.some((i) => i.zone === zone)) zone = '';
  renderZones(byTopic);
  const shown = zone ? byTopic.filter((i) => i.zone === zone) : byTopic;
  list.replaceChildren(...shown.map(card));
  summary.textContent = `${shown.length} คลิป · ${new Set(byTopic.map((i) => i.zone)).size} โซน · 48 ชม.ล่าสุด`;
}

async function load() {
  const res = await fetch('/api/bkk/news');
  const payload = await res.json();
  items = payload.items || [];
  render();
  if (payload.error && !items.length)
    summary.textContent = `ยังไม่มีข่าว: ${payload.error}`;
}

topicSelect.addEventListener('change', () => {
  syncUrl();
  render();
});
subscribeBkkUpdates((kind) => kind === 'news' && load());
load().catch((e) => {
  summary.textContent = `โหลดข่าวไม่สำเร็จ: ${e.message}`;
});
