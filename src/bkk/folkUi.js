// The "from people on the spot" controls: a row of layer chips on the map and
// the card that opens for one reported spot. Both only draw what they are
// given; thaiShell.js owns the data.
import { el } from './dom.js';
import { spotIcon, spotClass, STATUS_LABEL } from './folk.js';

const CHIPS = [
  {
    id: 'trash',
    label: 'ขยะลอยน้ำ',
    mark: { kind: 'trash', status: 'floating' },
  },
  { id: 'food', label: 'อาหารยังขาย', mark: { kind: 'food', status: 'open' } },
  { id: 'depth', label: 'น้ำบนถนน' },
];

/**
 * @param {{ onToggle: (id: string) => void, onReport: () => void }} handlers
 * @returns {{ el: HTMLElement, sync: (on: object, counts: object) => void,
 *             setBusy: (text: string | null) => void }}
 */
export function createFolkRow({ onToggle, onReport }) {
  const counts = new Map();
  const buttons = new Map();
  for (const chip of CHIPS) {
    const n = el('em', { text: '0' });
    counts.set(chip.id, n);
    buttons.set(
      chip.id,
      el(
        'button',
        {
          class: `th-fchip ${chip.id}`,
          type: 'button',
          'aria-pressed': 'true',
          onclick: () => onToggle(chip.id),
        },
        el('span', {
          class: `th-mk ${chip.mark ? spotClass(chip.mark) : 'depth'}`,
          html: chip.mark ? spotIcon(chip.mark) : '',
        }),
        chip.label,
        n,
      ),
    );
  }
  const reportLabel = el('span', { text: 'รายงานจุดนี้' });
  const root = el(
    'div',
    {
      class: 'th-shell th-only th-folk',
      role: 'group',
      'aria-label': 'รายงานจากคนในพื้นที่',
    },
    el(
      'b',
      {},
      'จากคนในพื้นที่',
      el('small', { text: 'ยังไม่ได้ตรวจสอบ · อยู่ 6 ชม.' }),
    ),
    ...buttons.values(),
    el(
      'button',
      { class: 'th-freport', type: 'button', onclick: onReport },
      reportLabel,
    ),
  );
  return {
    el: root,
    sync(on, numbers) {
      for (const [id, b] of buttons) {
        b.setAttribute('aria-pressed', String(Boolean(on[id])));
        counts.get(id).textContent = String(numbers[id] ?? 0);
      }
    },
    /** A short message in place of the button label, or null to restore it. */
    setBusy(text) {
      reportLabel.textContent = text || 'รายงานจุดนี้';
    },
  };
}

/**
 * @param {{ onSend: (choice: string) => Promise<void>, onClose: () => void }} handlers
 * @returns {{ el: HTMLElement, show: (view: object) => void, hide: () => void }}
 *
 * view: { kind, status, title, where, sub, facts: [{ tone, text }],
 *         confirm: { id, label }, deny: { id, label }, ask }
 */
export function createSpotCard({ onSend, onClose }) {
  const root = el('aside', {
    class: 'th-shell th-only th-spotcard',
    hidden: true,
    'aria-live': 'polite',
  });
  let note = '';

  function show(view) {
    const status = el('p', { class: 'th-note', role: 'status', text: note });
    const send = (choice) => async () => {
      status.textContent = 'กำลังส่ง…';
      try {
        await onSend(choice);
        note = 'ส่งแล้ว ขอบคุณที่ช่วยบอกคนอื่น';
      } catch (e) {
        note = e.message;
      }
      status.textContent = note;
    };
    root.className = `th-shell th-only th-spotcard ${spotClass(view)}`;
    root.replaceChildren(
      el(
        'header',
        {},
        el('span', { class: `th-mk ${spotClass(view)}`, html: spotIcon(view) }),
        STATUS_LABEL[view.status] || view.status,
        el('button', {
          class: 'th-x',
          type: 'button',
          'aria-label': 'ปิด',
          text: '×',
          onclick: onClose,
        }),
      ),
      el(
        'div',
        { class: 'th-spotbody' },
        el('h3', { text: view.title }),
        el('small', {
          text: [view.where, view.sub].filter(Boolean).join(' · '),
        }),
        view.facts.length
          ? el(
              'ul',
              {},
              view.facts.map((f) =>
                el('li', { class: f.tone || '' }, el('i'), f.text),
              ),
            )
          : null,
      ),
      el(
        'div',
        { class: 'th-spotact' },
        el('em', { text: view.ask }),
        el('button', {
          class: 'th-btn primary',
          type: 'button',
          text: view.confirm.label,
          onclick: send(view.confirm.id),
        }),
        el('button', {
          class: 'th-btn',
          type: 'button',
          text: view.deny.label,
          onclick: send(view.deny.id),
        }),
      ),
      status,
    );
    root.hidden = false;
  }

  return {
    el: root,
    show,
    hide() {
      note = '';
      root.hidden = true;
    },
  };
}
