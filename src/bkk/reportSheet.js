// The report form: up to three questions, each answered by tapping one fixed
// choice. No typing and no photo, so there is nothing to moderate.
import { el } from './dom.js';

const GROUPS = [
  { kind: 'depth', title: 'น้ำบนถนนสูงแค่ไหน', hint: 'ซม. โดยประมาณ' },
  {
    kind: 'trash',
    title: 'มีขยะมากับน้ำไหม',
    order: ['clear', 'floating', 'blocking'],
    short: {
      clear: 'ไม่มี',
      floating: 'ลอยมากับน้ำ',
      blocking: 'อุดทางระบายน้ำ',
    },
  },
  {
    kind: 'food',
    title: 'ตรงนี้ยังมีอาหารขายไหม',
    short: { open: 'ยังมีขาย', closed: 'ไม่มีขายแล้ว' },
  },
];

/**
 * @param {object} opts
 * @param {{ lat: number, lon: number }} opts.at  where the report is about
 * @param {string} opts.where   one line naming the place
 * @param {object} opts.choices `{ depth, trash, food }` from /api/bkk/reports
 * @param {() => unknown} [opts.onSent]
 * @returns {() => void} closes the sheet
 */
export function openReportSheet({ at, where, choices, onSent }) {
  const picked = {};
  const status = el('p', { class: 'th-note', role: 'status' });
  const submit = el('button', {
    class: 'th-btn primary',
    type: 'button',
    disabled: '',
    onclick: send,
  });
  const syncSubmit = () => {
    const n = Object.keys(picked).length;
    submit.textContent = n
      ? `ส่งรายงาน ${n} เรื่อง`
      : 'เลือกอย่างน้อย 1 เรื่อง';
    submit.toggleAttribute('disabled', !n);
  };

  const groups = GROUPS.filter((g) => choices?.[g.kind]?.length).map((g) => {
    const list = g.order
      ? g.order
          .map((id) => choices[g.kind].find((c) => c.id === id))
          .filter(Boolean)
      : choices[g.kind];
    const buttons = list.map((c) =>
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': 'false',
          onclick: (e) => {
            // Tapping the chosen answer again takes it back.
            if (picked[g.kind] === c.id) delete picked[g.kind];
            else picked[g.kind] = c.id;
            for (const b of buttons)
              b.setAttribute(
                'aria-pressed',
                String(b === e.currentTarget && picked[g.kind] === c.id),
              );
            syncSubmit();
          },
        },
        g.kind === 'depth' ? el('b', { text: String(c.cm) }) : null,
        g.short?.[c.id] || c.label,
      ),
    );
    return el(
      'fieldset',
      { class: `th-q ${g.kind}` },
      el(
        'legend',
        {},
        el('i'),
        g.title,
        g.hint ? el('small', { text: g.hint }) : null,
      ),
      el('div', { class: 'th-opts' }, buttons),
    );
  });

  const sheet = el(
    'div',
    {
      class: 'th-sheet',
      tabindex: '-1',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'รายงานจุดนี้',
    },
    el(
      'div',
      { class: 'th-sheethead' },
      el(
        'div',
        {},
        el('h1', { text: 'รายงานจุดนี้' }),
        el('p', {
          text: `${where} · แตะเลือกเรื่องที่คุณเห็น ไม่ต้องครบทุกเรื่อง`,
        }),
      ),
      el('button', {
        class: 'th-x',
        type: 'button',
        'aria-label': 'ปิด',
        text: '×',
        onclick: close,
      }),
    ),
    groups,
    el(
      'div',
      { class: 'th-sheetfoot' },
      submit,
      status,
      el('p', {
        class: 'th-note',
        text: 'ไม่ต้องพิมพ์ ไม่ต้องถ่ายรูป ไม่เก็บชื่อหรือเบอร์โทร รายงานอยู่บนแผนที่ 6 ชั่วโมงแล้วหายไปเอง',
      }),
    ),
  );
  const wrap = el(
    'div',
    {
      class: 'th-shell th-only th-sheetwrap',
      onclick: (e) => {
        if (e.target === wrap) close();
      },
    },
    sheet,
  );
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  async function send() {
    submit.setAttribute('disabled', '');
    status.textContent = 'กำลังส่ง…';
    try {
      const res = await fetch('/api/bkk/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: at.lat, lon: at.lon, answers: picked }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'ส่งไม่สำเร็จ');
      await onSent?.();
      close();
    } catch (e) {
      status.textContent = e.message;
      syncSubmit();
    }
  }

  function close() {
    removeEventListener('keydown', onKey);
    wrap.remove();
  }

  syncSubmit();
  addEventListener('keydown', onKey);
  document.body.append(wrap);
  sheet.focus();
  return close;
}
