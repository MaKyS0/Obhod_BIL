import { h, $ } from './dom.js';

export function toast(message, kind = 'success', ms = 4500) {
  const box = $('#toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${kind}` }, h('span', { style: 'flex:1' }, message), h('button', { type: 'button', 'aria-label': 'Закрыть', onclick: () => el.remove() }, '×'));
  box.appendChild(el);
  if (kind !== 'error') setTimeout(() => el.remove(), ms);
  else setTimeout(() => el.remove(), 9000);
}

export const toastError = (e) => toast(e && e.message ? e.message : String(e), 'error');
