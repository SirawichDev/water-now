// The gauge detail view: everything a person should see before deciding to go
// to (or leave) a flooded place — how far over the bank, which way it is
// moving, how fresh the reading is, how deep the street is if anyone knows,
// and what is nearby.
import { el, distanceM, clock, dayClock, ago, km, placeLine } from './dom.js';
import { passability, bodyReference, formatDepth } from './depthLadder.js';
import {
  foodPlaces,
  foodStatuses,
  placeOf,
  spotClass,
  STATUS_LABEL,
} from './folk.js';

const NEWS_M = 8000;
const CAMERA_M = 30_000;
const OUTAGE_M = 5000;
const REPORT_M = 1500;
const NEWS_DEPTH_M = 3000;
const TRASH_M = 3000;
const FOOD_SPOT_M = 1500;
const FOOD_ROWS = 6;
const BANK_AT = 56; // % of the tank's height where the bank line sits

// 1555 is Bangkok's city hall line, so it only appears for Bangkok gauges.
const hotlines = (province) => [
  ['1784', 'ปภ.'],
  province === 'กรุงเทพมหานคร' ? ['1555', 'กทม.'] : ['191', 'ตำรวจ'],
  ['1669', 'แพทย์ฉุกเฉิน'],
];
const PLACE_KINDS = [
  ['hospital', 'โรงพยาบาล'],
  ['school', 'โรงเรียน (มักใช้เป็นที่พักพิง)'],
  ['pharmacy', 'ร้านยา'],
  ['fuel', 'ปั๊มน้ำมัน'],
  ['police', 'ตำรวจ'],
];

/** Change per hour, change over a day and the peak, from hourly points. */
export function trendFromHistory(points) {
  if (!points?.length) return null;
  const last = points[points.length - 1];
  const before = (ms) => {
    const target = last.t - ms;
    let best = null;
    for (const p of points)
      if (
        p !== last &&
        (!best || Math.abs(p.t - target) < Math.abs(best.t - target))
      )
        best = p;
    // Only trust a comparison point that is reasonably close to the target.
    return best && Math.abs(best.t - target) <= ms / 2 ? best : null;
  };
  const hourAgo = before(3600_000);
  const dayAgo = before(86400_000);
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
  return {
    latest: last,
    hourCm: hourAgo
      ? Math.round(
          ((last.v - hourAgo.v) / ((last.t - hourAgo.t) / 3600_000)) * 100,
        )
      : null,
    dayM: dayAgo ? +(last.v - dayAgo.v).toFixed(2) : null,
    peak,
  };
}

/** SVG for the level chart. Returns '' when there is nothing to draw. */
export function chartSvg(points, bankMsl, { width = 332, height = 110 } = {}) {
  if (!points || points.length < 2) return '';
  const plotH = height - 18;
  const values = points.map((p) => p.v);
  const hasBank = Number.isFinite(bankMsl);
  const lo = Math.min(...values, hasBank ? bankMsl : Infinity);
  const hi = Math.max(...values, hasBank ? bankMsl : -Infinity);
  const pad = Math.max(0.15, (hi - lo) * 0.12);
  const y = (v) =>
    +(4 + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (plotH - 8)).toFixed(
      1,
    );
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0 || 1;
  const x = (t) => +(((t - t0) / span) * width).toFixed(1);
  const line = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t)} ${y(p.v)}`)
    .join(' ');
  const base = hasBank ? y(bankMsl) : plotH;
  const over = hasBank && points[points.length - 1].v > bankMsl;
  const color = over ? '#D92D20' : '#175CD3';
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a));
  const last = points[points.length - 1];
  // Midnight ticks in Bangkok time.
  const ticks = [];
  const dayMs = 86400_000;
  for (
    let t = Math.ceil((t0 + 7 * 3600_000) / dayMs) * dayMs - 7 * 3600_000;
    t < last.t;
    t += dayMs
  )
    ticks.push(t);
  const label = (t) =>
    new Date(t).toLocaleDateString('th-TH', {
      timeZone: 'Asia/Bangkok',
      day: 'numeric',
      month: 'short',
    });
  return `<svg class="th-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="กราฟระดับน้ำย้อนหลัง">
    <path d="${line} L${width} ${base} L0 ${base}Z" fill="${over ? 'rgba(217,45,32,.13)' : 'rgba(23,92,211,.10)'}"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${hasBank ? `<line x1="0" y1="${base}" x2="${width}" y2="${base}" stroke="#15202B" stroke-dasharray="4 3"/>` : ''}
    ${ticks.map((t) => `<text x="${x(t)}" y="${height - 3}" text-anchor="middle">${label(t)}</text>`).join('')}
    ${peak !== last ? `<circle cx="${x(peak.t)}" cy="${y(peak.v)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.5"/>` : ''}
    <circle cx="${x(last.t)}" cy="${y(last.v)}" r="4" fill="${color}" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
}

const signed = (n, unit) => `${n > 0 ? 'ขึ้น' : 'ลด'} ${Math.abs(n)} ${unit}`;

/**
 * @param {object} st  station from /api/bkk/water
 * @param {object} ctx { data, onBack, onNearby, onReport, onSpot, onPlaces,
 *                       onCamera, onNews }
 */
export function renderDetail(st, ctx) {
  const diff = st.waterLevelMsl - st.bankMsl;
  const hasBank = Number.isFinite(diff);
  const over = st.level >= 5;
  const waterPct = Math.max(
    5,
    Math.min(96, st.storagePercent * (BANK_AT / 100)),
  );
  const topColor = over ? '#F04438' : '#2E90FA';

  const trendTag = el('span', {
    class: 'th-tag flat',
    text: 'กำลังโหลดแนวโน้ม…',
  });
  const facts = el('dl', { class: 'th-facts' });
  const chartBox = el('div', { class: 'th-chartbox', text: 'กำลังโหลดกราฟ…' });
  const depthBox = el('div', { class: 'th-sec' });
  const beforeBox = el('div', { class: 'th-go' });
  const foodBox = el('div', {
    class: 'th-places',
    text: 'กำลังค้นหาที่ขายอาหารใกล้จุดนี้…',
  });
  let food = null; // places to eat from OpenStreetMap, once loaded
  const placesBox = el('div', {
    class: 'th-places',
    text: 'กำลังค้นหาสถานที่ใกล้เคียง…',
  });

  const tank = el(
    'div',
    { class: 'th-tank', 'aria-hidden': 'true' },
    el('div', {
      class: 'w',
      style: `height:${waterPct}%;background:linear-gradient(to top,#1570EF 0 ${Math.min(100, (BANK_AT / waterPct) * 100)}%,#F04438 ${Math.min(100, (BANK_AT / waterPct) * 100)}% 100%)`,
    }),
    el('div', {
      class: 'wave',
      style: `bottom:calc(${waterPct}% - 1px)`,
      html: `<svg viewBox="0 0 224 12" preserveAspectRatio="none"><path d="M0 6 Q14 0 28 6 T56 6 T84 6 T112 6 T140 6 T168 6 T196 6 T224 6 V12 H0Z" fill="${topColor}"/></svg>`,
    }),
    el('div', { class: 'bank' }),
    el('span', { class: 'bl', text: 'ตลิ่ง' }),
  );

  const root = el(
    'div',
    { class: 'th-detail-view' },
    el(
      'div',
      { class: 'th-back' },
      el('button', { type: 'button', text: '← ภาพรวม', onclick: ctx.onBack }),
      el('button', {
        type: 'button',
        text: 'แชร์จุดนี้',
        onclick: (e) => {
          const url = `${location.origin}/?station=${encodeURIComponent(st.id)}`;
          navigator.clipboard?.writeText(url).then(() => {
            e.target.textContent = 'คัดลอกลิงก์แล้ว';
          });
        },
      }),
    ),
    el(
      'div',
      { class: 'th-scroll' },
      el(
        'div',
        { class: 'th-ttl' },
        el('h1', { text: st.name }),
        el('p', {
          text: [placeLine(st), st.river].filter(Boolean).join(' · '),
        }),
        el(
          'div',
          { class: 'th-tags' },
          el('span', { class: `th-tag l${st.level}`, text: st.levelText }),
          trendTag,
        ),
      ),
      el(
        'div',
        { class: 'th-hero' },
        tank,
        el(
          'div',
          { class: 'th-fig' },
          el('small', {
            text: !hasBank
              ? 'ระดับน้ำ'
              : diff >= 0
                ? 'ระดับน้ำสูงกว่าตลิ่ง'
                : 'ระดับน้ำต่ำกว่าตลิ่ง',
          }),
          el(
            'b',
            { class: over ? 'over' : st.level === 4 ? 'near' : '' },
            hasBank
              ? Math.abs(diff).toFixed(2)
              : `${Math.round(st.storagePercent)}`,
            el('span', { text: hasBank ? 'ม.' : '%' }),
          ),
          el('small', {
            text: `${Math.round(st.storagePercent)}% ของความลึกถึงตลิ่ง`,
          }),
          facts,
        ),
      ),
      el(
        'div',
        { class: 'th-sec' },
        el(
          'h2',
          {},
          'ระดับน้ำ 3 วันที่ผ่านมา',
          el('span', { text: 'เส้นประ = ตลิ่ง' }),
        ),
        chartBox,
      ),
      el(
        'div',
        { class: 'th-sec' },
        el(
          'div',
          { class: `th-fresh${st.stale ? ' stale' : ''}` },
          el('i'),
          el(
            'span',
            {},
            `วัดล่าสุด ${clock(st.observedAt)} น. · ${ago(st.observedAt)}`,
            el('small', {
              text: st.stale
                ? 'ข้อมูลค้างเกิน 3 ชั่วโมง อาจไม่ตรงกับตอนนี้'
                : `${st.agency || 'สถานีโทรมาตร'} · วัดในแม่น้ำ/คลอง ไม่ใช่บนถนน`,
            }),
          ),
        ),
      ),
      depthBox,
      el(
        'div',
        { class: 'th-sec' },
        el('h2', { text: 'ก่อนเดินทางไปจุดนี้' }),
        beforeBox,
      ),
      el(
        'div',
        { class: 'th-sec' },
        el(
          'h2',
          {},
          'ยังมีอาหารขายไหม',
          el('span', { text: 'สถานะจากคนในพื้นที่' }),
        ),
        foodBox,
      ),
      el(
        'div',
        { class: 'th-sec' },
        el(
          'h2',
          {},
          'ใกล้จุดนี้',
          el('span', { text: 'ยังไม่มีการยืนยันว่าเปิดอยู่' }),
        ),
        placesBox,
      ),
      el(
        'div',
        { class: 'th-sec th-hot' },
        hotlines(st.province).map(([num, who]) =>
          el('a', { href: `tel:${num}` }, el('b', { text: num }), who),
        ),
      ),
      el(
        'div',
        { class: 'th-acts' },
        el('a', {
          class: 'th-btn primary',
          href: `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lon}`,
          target: '_blank',
          rel: 'noopener',
          text: 'นำทางไปจุดนี้',
        }),
        el('button', {
          class: 'th-btn',
          type: 'button',
          text: 'ดูจุดใกล้เคียง',
          onclick: () => ctx.onNearby(st),
        }),
      ),
    ),
  );

  // ── Trend and chart ────────────────────────────────────────────────────
  fetch(`/api/bkk/water/history?id=${encodeURIComponent(st.id)}`)
    .then((r) => r.json())
    .then((h) => {
      const trend = trendFromHistory(h.points);
      if (!trend) throw new Error('no history');
      const bank = Number.isFinite(h.bankMsl) ? h.bankMsl : st.bankMsl;
      chartBox.innerHTML = chartSvg(h.points, bank);
      const cm = trend.hourCm;
      if (cm == null) trendTag.remove();
      else {
        trendTag.className = `th-tag ${cm > 1 ? 'up' : cm < -1 ? 'down' : 'flat'}`;
        trendTag.textContent =
          cm > 1
            ? `▲ กำลังขึ้น ${cm} ซม./ชม.`
            : cm < -1
              ? `▼ กำลังลด ${-cm} ซม./ชม.`
              : '● ทรงตัว';
      }
      const row = (k, v, cls) => [
        el('dt', { text: k }),
        el('dd', { class: cls || '', text: v }),
      ];
      const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
      facts.replaceChildren(
        ...(cm != null
          ? row('1 ชม.', cm ? signed(cm, 'ซม.') : 'ทรงตัว', tone(cm))
          : []),
        ...(trend.dayM != null
          ? row(
              '24 ชม.',
              trend.dayM ? signed(trend.dayM, 'ม.') : 'ทรงตัว',
              tone(trend.dayM),
            )
          : []),
        ...(Number.isFinite(bank)
          ? row(
              'สูงสุด 3 วัน',
              `${trend.peak.v - bank >= 0 ? '+' : '−'}${Math.abs(trend.peak.v - bank).toFixed(2)} ม. · ${dayClock(trend.peak.t)}`,
            )
          : []),
      );
    })
    .catch(() => {
      chartBox.textContent = 'ยังโหลดกราฟย้อนหลังของสถานีนี้ไม่ได้';
      trendTag.remove();
    });

  // ── Street depth: reports first, then headlines ────────────────────────
  function renderDepth() {
    const { reports = [], news = [] } = ctx.data();
    const near = (p, m) => distanceM(st.lat, st.lon, p.lat, p.lon) <= m;
    const report = reports.find((r) => near(r, REPORT_M));
    const headline = news
      .filter((n) => n.depth && n.lat != null && near(n, NEWS_DEPTH_M))
      .sort((a, b) => b.publishedAt - a.publishedAt)[0];
    const source = report
      ? {
          cm: report.cm,
          text: `คนในพื้นที่รายงานว่าน้ำถึง${report.label} · ${ago(report.createdAt)}`,
          tag: 'ยังไม่ยืนยัน',
        }
      : headline
        ? {
            cm: headline.depth.cm,
            text: `ข่าว ${headline.channel}: “${headline.depth.text}” · ${ago(headline.publishedAt)}`,
            tag: 'จากหัวข้อข่าว',
          }
        : null;
    depthBox.replaceChildren(
      el(
        'h2',
        {},
        'ความลึกบนถนนใกล้จุดนี้',
        source ? el('span', { text: source.tag }) : null,
      ),
      source
        ? el(
            'div',
            {},
            el(
              'p',
              { class: 'th-depth' },
              el('b', { text: `ประมาณ ${formatDepth(source.cm)}` }),
              ` (${bodyReference(source.cm)})`,
            ),
            el('p', { class: 'th-note', text: source.text }),
            el(
              'div',
              { class: 'th-ways' },
              passability(source.cm).map((w) =>
                el('span', {
                  class: w.state,
                  text: w.label,
                  title: { ok: 'ผ่านได้', risk: 'เสี่ยง', no: 'ไม่ควร' }[
                    w.state
                  ],
                }),
              ),
            ),
            el('p', {
              class: 'th-note',
              text: 'เกณฑ์ทั่วไป น้ำไหลแรงอันตรายกว่านี้ ตัดสินใจจากสภาพจริงตรงหน้า',
            }),
          )
        : el('p', {
            class: 'th-note',
            text: 'ยังไม่มีข้อมูลความลึกบนถนน มาตรวัดนี้อยู่ในแม่น้ำ/คลอง',
          }),
      el('button', {
        class: 'th-btn',
        type: 'button',
        text: 'รายงานจุดนี้: น้ำ ขยะ อาหาร',
        onclick: () => ctx.onReport(st),
      }),
    );
  }
  renderDepth();

  // ── Before you go: rain, news, camera, outages ─────────────────────────
  const line = (label, body) => el('div', {}, el('b', { text: label }), body);
  const rainLine = line('ฝน 6 ชม.ข้างหน้า', el('span', { text: 'กำลังโหลด…' }));
  function renderBefore() {
    const { news = [], cams = [], outages = [], spots = [] } = ctx.data();
    const trash = spots
      .filter((s) => s.kind === 'trash')
      .map((s) => ({ s, d: distanceM(st.lat, st.lon, s.lat, s.lon) }))
      .filter((x) => x.d <= TRASH_M)
      .sort((a, b) => a.d - b.d);
    const zones = new Map();
    for (const n of news)
      if (n.lat != null && distanceM(st.lat, st.lon, n.lat, n.lon) <= NEWS_M)
        zones.set(n.zone, (zones.get(n.zone) || 0) + 1);
    const cam = cams
      .map((c) => ({ c, d: distanceM(st.lat, st.lon, c.lat, c.lon) }))
      .sort((a, b) => a.d - b.d)[0];
    const cuts = outages.filter(
      (o) =>
        o.lat != null && distanceM(st.lat, st.lon, o.lat, o.lon) <= OUTAGE_M,
    );
    beforeBox.replaceChildren(
      rainLine,
      line(
        'ข่าวในพื้นที่',
        zones.size
          ? el(
              'span',
              {},
              [...zones].map(([zone, n]) =>
                el('button', {
                  class: 'th-link',
                  type: 'button',
                  text: `${zone.replace(/^(แขวง|เขต)/, '')} · ${n} คลิป`,
                  onclick: () => ctx.onNews(zone),
                }),
              ),
            )
          : el('span', { text: `ยังไม่มีข่าวในรัศมี ${NEWS_M / 1000} กม.` }),
      ),
      line(
        'กล้องสด',
        cam && cam.d <= CAMERA_M
          ? el('button', {
              class: 'th-link',
              type: 'button',
              text: `${cam.c.name} · ${km(cam.d)}`,
              onclick: () => ctx.onCamera(cam.c),
            })
          : el('span', { text: `ไม่มีกล้องในรัศมี ${CAMERA_M / 1000} กม.` }),
      ),
      line(
        'ขยะในน้ำ',
        trash.length
          ? el(
              'span',
              {},
              trash.slice(0, 3).map(({ s, d }) =>
                el('button', {
                  class: 'th-link',
                  type: 'button',
                  text: `${STATUS_LABEL[s.status]} · ${km(d)} · ${ago(s.createdAt)} `,
                  onclick: () => ctx.onSpot(s),
                }),
              ),
            )
          : el('span', {
              text: `ยังไม่มีคนรายงานในรัศมี ${TRASH_M / 1000} กม.`,
            }),
      ),
      line(
        'ดับไฟตามแผน',
        el('span', {
          text: cuts.length
            ? `มี ${cuts.length} ประกาศในรัศมี ${OUTAGE_M / 1000} กม.`
            : 'ไม่มีประกาศใกล้จุดนี้',
        }),
      ),
    );
  }
  renderBefore();
  fetch(`/api/bkk/rain?lat=${st.lat}&lon=${st.lon}`)
    .then((r) => r.json())
    .then((rain) => {
      if (!rain.hours) throw new Error();
      rainLine.lastChild.textContent =
        rain.totalMm >= 0.5
          ? `คาดว่าฝน ${rain.totalMm} มม. · โอกาสสูงสุด ${rain.maxProb}%`
          : rain.maxProb >= 60
            ? `อาจมีฝนเล็กน้อย · โอกาสสูงสุด ${rain.maxProb}%`
            : `ไม่น่ามีฝน · โอกาสสูงสุด ${rain.maxProb}%`;
    })
    .catch(() => (rainLine.lastChild.textContent = 'ยังโหลดพยากรณ์ฝนไม่ได้'));

  // ── Places ─────────────────────────────────────────────────────────────
  // Two lookups, so a failed one costs only its own section. Until the food
  // lookup answers, the shops from the general one stand in for it.
  const setFood = (places, final) => {
    if (food?.final && !final) return;
    food = Object.assign(foodPlaces(places), { final });
    ctx.onPlaces?.(food);
    renderFood();
  };
  const places = fetch(`/api/bkk/places?lat=${st.lat}&lon=${st.lon}`)
    .then((r) => r.json())
    .then((p) => {
      if (!p.places) throw new Error();
      return p.places;
    });
  fetch(`/api/bkk/food?lat=${st.lat}&lon=${st.lon}`)
    .then((r) => r.json())
    .then((f) => {
      if (!f.places) throw new Error();
      setFood(f.places, true);
    })
    .catch(() =>
      places.then((p) => setFood(p, false)).catch(() => setFood({}, false)),
    );
  places
    .then((all) => {
      const p = { places: all };
      const rows = PLACE_KINDS.flatMap(([kind, label]) =>
        (p.places[kind] || []).slice(0, kind === 'hospital' ? 2 : 1).map((x) =>
          el(
            'a',
            {
              class: 'th-place',
              href: `https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}`,
              target: '_blank',
              rel: 'noopener',
            },
            el(
              'span',
              {},
              el('b', { text: x.name }),
              el('small', { text: label }),
            ),
            el('em', { text: km(x.distM) }),
          ),
        ),
      );
      placesBox.replaceChildren(
        ...(rows.length
          ? rows
          : [
              el('p', {
                class: 'th-note',
                text: 'ไม่พบสถานที่ในรัศมี 3 กม. ในข้อมูล OpenStreetMap',
              }),
            ]),
      );
    })
    .catch(() => {
      placesBox.textContent =
        'ยังโหลดสถานที่ใกล้เคียงไม่ได้ ลองเปิดจุดนี้อีกครั้งภายหลัง';
    });

  // ── Food still on sale: OSM places, with what residents say about them ──
  function renderFood() {
    if (!food) return;
    const { spots = [] } = ctx.data();
    const row = (spot, name, sub) =>
      el(
        'button',
        {
          class: 'th-place food',
          type: 'button',
          onclick: () => ctx.onSpot(spot),
        },
        el('span', {}, el('b', { text: name }), el('small', { text: sub })),
        el('em', {
          class: `th-fstat ${spotClass(spot)}`,
          text:
            spot.status === 'unknown'
              ? STATUS_LABEL.unknown
              : `${STATUS_LABEL[spot.status]} · ${ago(spot.createdAt)}`,
        }),
      );
    const statuses = foodStatuses(food, spots);
    const known = food.map((p) => {
      const said = statuses.get(p);
      return {
        said,
        distM: p.distM,
        node: row(
          said
            ? { ...said, place: p }
            : {
                kind: 'food',
                status: 'unknown',
                lat: p.lat,
                lon: p.lon,
                place: p,
              },
          p.name,
          `${p.kindLabel} · ${km(p.distM)}`,
        ),
      };
    });
    // Street vendors are not on the map; residents pin them themselves.
    const pinned = spots
      .filter((s) => s.kind === 'food' && !placeOf(s, food))
      .map((s) => ({ s, distM: distanceM(st.lat, st.lon, s.lat, s.lon) }))
      .filter((x) => x.distM <= FOOD_SPOT_M)
      .map(({ s, distM }) => ({
        said: s,
        distM,
        node: row(
          s,
          'จุดที่คนในพื้นที่ปักหมุด',
          `ไม่อยู่ในแผนที่ · ${km(distM)}`,
        ),
      }));
    // Places someone has spoken for come first, then the nearest.
    const rows = [...known, ...pinned]
      .sort((a, b) => Boolean(b.said) - Boolean(a.said) || a.distM - b.distM)
      .slice(0, FOOD_ROWS);
    foodBox.replaceChildren(
      ...(rows.length
        ? rows.map((r) => r.node)
        : [
            el('p', {
              class: 'th-note',
              text: food.final
                ? 'ไม่พบที่ขายอาหารในรัศมี 1.5 กม. ในข้อมูล OpenStreetMap และยังไม่มีคนรายงาน'
                : 'ยังโหลดรายชื่อร้านจาก OpenStreetMap ไม่ได้ และยังไม่มีคนรายงาน ลองเปิดจุดนี้อีกครั้งภายหลัง',
            }),
          ]),
      el('p', {
        class: 'th-note',
        text: 'แตะร้านเพื่อบอกว่ายังเปิดหรือปิดแล้ว · ร้านที่ไม่มีคนยืนยันอาจปิดอยู่',
      }),
    );
  }

  return {
    el: root,
    refresh: () => (renderDepth(), renderBefore(), renderFood()),
  };
}
