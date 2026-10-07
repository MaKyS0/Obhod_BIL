import { h } from './dom.js';
import { compareClasses } from '../domain/classes.js';

let seq = 0;

/** Поле формы: label + input/select/textarea + подсказка + ошибка. */
export function field({ label, name, type = 'text', value = '', required = false, options = null, hint = '', placeholder = '', autocomplete = 'off', rows = 3, attrs = {}, onChange }) {
  const id = `f-${name || 'x'}-${++seq}`;
  let input;
  if (options) {
    input = h('select', { id, name, ...attrs });
    const add = (parent, o) => parent.appendChild(h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label));
    for (const o of options) {
      if (o.options) {
        const g = h('optgroup', { label: o.label });
        o.options.forEach((x) => add(g, x));
        input.appendChild(g);
      } else add(input, o);
    }
  } else if (type === 'textarea') input = h('textarea', { id, name, rows, placeholder, ...attrs }, value);
  else input = h('input', { id, name, type, value, placeholder, autocomplete, ...attrs });
  if (onChange) input.addEventListener('change', onChange);
  const err = h('div', { class: 'error', id: `${id}-e`, hidden: true });
  const hintEl = hint ? h('div', { class: 'hint', id: `${id}-h` }, hint) : null;
  const el = h('div', { class: 'field' }, h('label', { for: id }, label, required ? h('span', { 'aria-hidden': 'true', style: 'color:var(--danger)' }, ' *') : null), input, hintEl, err);
  return {
    el,
    input,
    get: () => (input.type === 'checkbox' ? input.checked : input.value),
    set: (v) => (input.value = v),
    error(msg) {
      err.textContent = msg || '';
      err.hidden = !msg;
      el.classList.toggle('invalid', !!msg);
      if (msg) input.setAttribute('aria-describedby', err.id);
      else input.removeAttribute('aria-describedby');
    },
  };
}

export function checkbox({ label, checked = false, hint = '', onChange }) {
  const input = h('input', { type: 'checkbox', checked, onchange: onChange });
  const el = h('label', { class: 'check' }, input, h('span', null, label, hint ? h('small', { style: 'display:block' }, hint) : null));
  return { el, input, get: () => input.checked };
}

export function radioCard({ name, value, title, text, checked = false, onChange }) {
  const input = h('input', { type: 'radio', name, value, checked, onchange: onChange });
  return { el: h('label', { class: 'radio-card' }, input, h('span', null, h('strong', null, title), text ? h('small', { class: 'muted' }, text) : null)), input };
}

/** Опции выбора класса, сгруппированные по параллелям. */
export function classOptions(view, { empty = null } = {}) {
  const groups = new Map();
  for (const c of view.classes.slice().sort(compareClasses)) {
    if (!groups.has(c.grade)) groups.set(c.grade, []);
    groups.get(c.grade).push({ value: c.id, label: `${c.name} (${c.count})` });
  }
  const out = [];
  if (empty !== null) out.push({ value: '', label: empty });
  for (const [g, options] of groups) out.push({ label: `${g} классы`, options });
  return out;
}
