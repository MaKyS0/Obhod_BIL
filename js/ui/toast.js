import { h, $ } from './dom.js';

export function toast(message, kind = 'success', ms = 4500) {
  const box = $('#toasts');
  if (!box) return;
  // Закрытие — с плавным исчезновением (если анимации включены), иначе сразу.
  const close = () => {
    if (!el.isConnected || el.classList.contains('out')) return;
    if (document.documentElement.classList.contains('no-anim')) return el.remove();
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  const el = h('div', { class: `toast ${kind}` }, h('span', { style: 'flex:1' }, message), h('button', { type: 'button', 'aria-label': 'Закрыть', onclick: close }, '×'));
  box.appendChild(el);
  setTimeout(close, kind !== 'error' ? ms : 9000);
}

export const toastError = (e) => toast(e && e.message ? e.message : String(e), 'error');
