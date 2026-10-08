// Выбор файла на русском: родная кнопка браузера подписана по-английски («Choose File / No file chosen»), поэтому скрываем её и рисуем свою.
// Сам <input type="file"> остаётся в разметке (подпись, id, change, files работают как раньше).
import { h } from './dom.js';
import { icon } from './icons.js';

/** Возвращает { el, sync }: el вставляется вместо input; sync() обновляет подпись после программного сброса input.value. */
export function filePicker(input, { label = 'Выбрать файл…', empty = 'Файл не выбран' } = {}) {
  input.classList.add('sr-only');
  input.tabIndex = -1;
  const name = h('span', { class: 'file-name' }, empty);
  const sync = () => {
    const f = input.files && input.files[0];
    name.textContent = f ? f.name : empty;
    name.classList.toggle('muted', !f);
  };
  input.addEventListener('change', sync);
  const el = h('div', { class: 'file-picker' },
    input,
    h('button', { type: 'button', class: 'btn', onclick: () => input.click() }, icon('upload', 16), h('span', null, label)),
    name);
  sync();
  return { el, sync };
}
