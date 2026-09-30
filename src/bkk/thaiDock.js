// The dock under the map: the headline counts, what the circles mean, and a
// 72-hour replay of how many gauges were over the bank. Scrubbing or playing
// calls `onIndex(i)`; `onIndex(null)` means "back to now".
import { el } from './dom.js';
import { dayMarks } from './floodMath.js';

const STEP_MS = 220;
const MIN_HOURS = 6; // less history than this is not worth replaying
const BANGKOK = { timeZone: 'Asia/Bangkok' };
const dayLabel = (t) =>
  new Date(t).toLocaleDateString('th-TH', {
    ...BANGKOK,
    day: 'numeric',
    month: 'short',
  });
const hourLabel = (t) =>
  new Date(t).toLocaleString('th-TH', {
    ...BANGKOK,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function createDock({ onIndex, onFlow }) {
  let timeline = null;
  let index = null; // null = live
  let timer = null;
  let live = { over: 0, near: 0, up: 0 };

  const cell = (cls, label) => {
    const b = el('b', { text: '–' });
    return {
      b,
      node: el('div', { class: `c ${cls}` }, b, el('span', { text: label })),
    };
  };
  const cOver = cell('o', 'ล้นตลิ่ง');
  const cNear = cell('n', 'ใกล้ล้นตลิ่ง');
  const cUp = cell('u', 'กำลังขึ้น');
  const rainB = el('b');
  const rainText = el('span');
  const rain = el('div', { class: 'c rain', hidden: true }, rainB, rainText);

  const bars = el('div', { class: 'bars' });
  const labels = el('div', { class: 'lbls' });
  const readout = el('span', { class: 'th-readout' });
  const ticks = el(
    'div',
    {
      class: 'th-ticks',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'เลือกเวลาย้อนหลัง',
    },
    bars,
    labels,
  );
  const playBtn = el('button', {
    class: 'th-play',
    type: 'button',
    'aria-label': 'เล่นย้อนหลัง 72 ชั่วโมง',
    onclick: () => (timer ? pause() : play()),
  });
  const nowBtn = el('button', {
    class: 'th-now',
    type: 'button',
    text: 'กลับสู่ตอนนี้',
    hidden: true,
    onclick: () => go(null),
  });
  const title = el('span', { text: 'จำนวนจุดล้นตลิ่ง' });
  const flowText = el('span', { text: 'จุดวิ่งตามลำน้ำ: ปิดอยู่' });
  const flowBtn = el(
    'button',
    {
      class: 'th-keytoggle',
      type: 'button',
      'aria-pressed': 'false',
      onclick: () => onFlow?.(),
    },
    el('i', { class: 'fl' }),
    flowText,
  );

  const root = el(
    'section',
    { id: 'th-dock', class: 'th-shell th-only', 'aria-label': 'ย้อนดู 72 ชม.' },
    el('div', { class: 'th-strip' }, cOver.node, cNear.node, cUp.node, rain),
    el(
      'div',
      { class: 'th-key' },
      el(
        'span',
        {},
        el('i', { class: 'o s' }),
        el('i', { class: 'o l' }),
        'วงใหญ่ = สูงกว่าตลิ่งมาก',
      ),
      el('span', {}, el('i', { class: 'up' }), 'ทึบ = กำลังขึ้น'),
      el(
        'span',
        {},
        el('i', { class: 'tk' }),
        'ซูมเข้า: น้ำในวง = ระดับเทียบตลิ่ง',
      ),
      flowBtn,
      el('span', {}, el('i', { class: 'n' }), 'ใกล้ล้นตลิ่ง'),
      el('span', {
        class: 'note',
        text: 'วัดในแม่น้ำและคลอง ไม่ใช่ระดับน้ำบนถนน',
      }),
    ),
    el(
      'div',
      { class: 'th-time' },
      playBtn,
      el(
        'div',
        { class: 'th-docktitle' },
        el('b', { text: 'ย้อนดู 72 ชม.' }),
        title,
      ),
      ticks,
      el('div', { class: 'th-side-r' }, readout, nowBtn),
    ),
  );

  const count = () => timeline?.hours.length || 0;
  const usable = () =>
    timeline &&
    timeline.over.filter((n, i) => n + timeline.near[i] > 0).length >=
      MIN_HOURS;

  function drawReadout() {
    const scrubbing = index != null && timeline;
    readout.replaceChildren(
      el('b', {
        text: scrubbing ? `${hourLabel(timeline.hours[index])} น.` : 'ตอนนี้',
      }),
      `ล้นตลิ่ง ${scrubbing ? timeline.over[index] : live.over} จุด`,
    );
    readout.classList.toggle('past', Boolean(scrubbing));
    nowBtn.hidden = !scrubbing;
    const at = index ?? count() - 1;
    [...bars.children].forEach((u, i) => u.classList.toggle('cur', i === at));
    ticks.setAttribute('aria-valuenow', String(at));
    ticks.setAttribute(
      'aria-valuetext',
      scrubbing ? hourLabel(timeline.hours[index]) : 'ตอนนี้',
    );
  }

  function draw() {
    root.classList.toggle('empty', !usable());
    playBtn.disabled = !usable();
    if (!usable()) {
      bars.replaceChildren();
      labels.replaceChildren();
      title.textContent = 'กำลังเก็บข้อมูลย้อนหลัง…';
      drawReadout();
      return;
    }
    title.textContent = 'จำนวนจุดล้นตลิ่ง';
    const n = count();
    const max = Math.max(1, ...timeline.over);
    const peak = timeline.over.indexOf(max);
    // Bars start at zero: a flat row means the count really did not move much.
    bars.replaceChildren(
      ...timeline.over.map((v, i) =>
        el('u', {
          class: i === peak ? 'pk' : '',
          style: `height:${Math.max(4, (v / max) * 100)}%`,
        }),
      ),
    );
    const at = (i) => `left:${((i / (n - 1)) * 100).toFixed(2)}%`;
    labels.replaceChildren(
      ...dayMarks(timeline.hours)
        .filter((m) => m.index > 2 && m.index < n - 6)
        .map((m) =>
          el('span', { class: 'day', style: at(m.index), text: dayLabel(m.t) }),
        ),
      // Near either end the peak label would sit on top of the end labels.
      ...(peak > 8 && peak < n - 12
        ? [
            el('span', {
              class: 'pk',
              style: at(peak),
              text: `สูงสุด ${max}`,
            }),
          ]
        : []),
    );
    ticks.setAttribute('aria-valuemin', '0');
    ticks.setAttribute('aria-valuemax', String(n - 1));
    drawReadout();
  }

  function go(next, { keepPlaying = false } = {}) {
    if (!keepPlaying) pause();
    const last = count() - 1;
    index = next == null || next >= last ? null : Math.max(0, next);
    drawReadout();
    onIndex(index);
  }

  function play() {
    if (!usable()) return;
    if (index == null) go(0, { keepPlaying: true });
    root.classList.add('playing');
    timer = setInterval(() => {
      const next = (index ?? count()) + 1;
      if (next >= count() - 1) {
        pause();
        go(null);
      } else go(next, { keepPlaying: true });
    }, STEP_MS);
  }

  function pause() {
    clearInterval(timer);
    timer = null;
    root.classList.remove('playing');
  }

  const indexFromX = (clientX) => {
    const r = bars.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(f * (count() - 1));
  };
  ticks.addEventListener('pointerdown', (e) => {
    if (!usable()) return;
    ticks.setPointerCapture(e.pointerId);
    go(indexFromX(e.clientX));
  });
  ticks.addEventListener('pointermove', (e) => {
    if (ticks.hasPointerCapture(e.pointerId)) go(indexFromX(e.clientX));
  });
  ticks.addEventListener('keydown', (e) => {
    if (!usable()) return;
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    go((index ?? count() - 1) + step);
  });

  return {
    el: root,
    /** { hours, series, over, near } from /api/bkk/water/timeline */
    setTimeline(data) {
      timeline = data?.hours?.length ? data : null;
      if (index != null && index >= count() - 1) index = null;
      draw();
    },
    setLive(next) {
      live = next;
      cOver.b.textContent = String(next.over);
      cNear.b.textContent = String(next.near);
      cUp.b.textContent = String(next.up);
      drawReadout();
    },
    /** Rain chance for the selected gauge, or null to hide the card. */
    setRain(info) {
      rain.hidden = !info;
      if (!info) return;
      rainB.textContent = `${info.maxProb}%`;
      rainText.textContent = `โอกาสฝน 6 ชม.ข้างหน้าที่${info.name} · รวม ${info.totalMm} มม.`;
    },
    /** Whether the dots along rivers are drawn; the legend entry is the switch. */
    setFlow(on) {
      flowBtn.setAttribute('aria-pressed', String(on));
      flowText.textContent = on
        ? 'จุดวิ่งตามลำน้ำ: เร็ว = กำลังขึ้น'
        : 'จุดวิ่งตามลำน้ำ: ปิดอยู่';
    },
    pause,
    get index() {
      return index;
    },
    get timeline() {
      return timeline;
    },
  };
}
