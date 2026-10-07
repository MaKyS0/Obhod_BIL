// Модальные окна на нативном <dialog>: фокус, Esc и затемнение обеспечивает браузер.
import { h } from './dom.js';
import { toastError } from './toast.js';

let seq = 0;

/**
 * actions: [{ label, kind: 'primary'|'danger'|'secondary', run?: async (ctx) => false|void, keepOpen? }]
 * run может вернуть false (или бросить ошибку), чтобы окно осталось открытым.
 */
export function openModal({ title, body, actions = [], wide = false, danger = false, onClose, closeLabel = 'Закрыть' }) {
  const id = `modal-${++seq}`;
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}${danger ? ' danger' : ''}`, 'aria-labelledby': `${id}-t` });
  let busy = false;
  const buttons = [];
  const ctx = {
    el: dlg,
    close(result) {
      if (dlg.open) dlg.close();
      ctx.result = result;
    },
    setDisabled(i, v) {
      actions[i].disabled = v;
      buttons[i].disabled = v;
    },
    buttons,
    result: null,
  };
  const submitIdx = actions.findIndex((a) => a.kind === 'primary' || a.kind === 'danger');

  async function runAction(a) {
    if (busy) return;
    if (!a.run) {
      ctx.close(a.value ?? null);
      return;
    }
    busy = true;
    buttons.forEach((b) => (b.disabled = true));
    let keep = false;
    try {
      const r = await a.run(ctx);
      keep = r === false;
    } catch (e) {
      keep = true;
      toastError(e);
    } finally {
      busy = false;
      buttons.forEach((b, i) => (b.disabled = !!actions[i].disabled));
    }
    if (!keep && !a.keepOpen) ctx.close(a.value ?? true);
  }

  const form = h(
    'form',
    { novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      if (submitIdx >= 0) runAction(actions[submitIdx]);
    } },
    h('div', { class: 'modal-head' }, h('h2', { id: `${id}-t` }, title), h('button', { type: 'button', class: 'modal-close', 'aria-label': 'Закрыть окно', onclick: () => ctx.close(null) }, '×')),
    h('div', { class: 'modal-body' }, body),
    h(
      'div',
      { class: 'modal-foot' },
      actions.length
        ? actions.map((a, i) => {
            const b = h('button', { type: a.kind === 'primary' || a.kind === 'danger' ? 'submit' : 'button', class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : a.kind === 'danger-outline' ? 'btn-danger-outline' : ''}`, disabled: !!a.disabled, onclick: (e) => {
              if (b.type === 'submit') return; // submit-обработчик формы вызовет runAction
              e.preventDefault();
              runAction(a);
            } }, a.label);
            buttons[i] = b;
            return b;
          })
        : h('button', { type: 'button', class: 'btn', onclick: () => ctx.close(null) }, closeLabel),
    ),
  );
  dlg.appendChild(form);
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.(ctx.result);
    ctx.resolve?.(ctx.result);
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) ctx.close(null);
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  const first = dlg.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea');
  (first || buttons[buttons.length - 1] || dlg).focus?.();
  ctx.done = new Promise((res) => (ctx.resolve = res));
  return ctx;
}

/** Подтверждение опасных действий. Возвращает Promise<boolean>. */
export function confirmAction({ title, message, details = [], confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', kind = 'danger', typeToConfirm = null }) {
  let input = null;
  const confirmBtn = { label: confirmLabel, kind, value: true, disabled: !!typeToConfirm };
  const body = h(
    'div',
    null,
    h('p', null, message),
    details.length ? h('ul', { style: 'margin:8px 0 0;padding-left:20px' }, details.map((d) => h('li', null, d))) : null,
    typeToConfirm
      ? h(
          'div',
          { class: 'field', style: 'margin-top:14px' },
          h('label', { for: 'confirm-typed' }, `Для подтверждения введите: ${typeToConfirm}`),
          (input = h('input', { id: 'confirm-typed', autocomplete: 'off', oninput: () => {
            m.setDisabled(1, input.value.trim().replace(/[-—/]/g, '–') !== typeToConfirm.replace(/[-—/]/g, '–'));
          } })),
        )
      : null,
  );
  const m = openModal({ title, body, danger: kind === 'danger', actions: [{ label: cancelLabel, kind: 'secondary' }, confirmBtn] });
  return m.done.then((r) => r === true);
}
