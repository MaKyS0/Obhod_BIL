// Таблица: сортировка, постраничный вывод, массовый выбор с панелью действий. На узких экранах строки превращаются в карточки (data-label).
import { h } from './dom.js';
import { icon } from './icons.js';
import { cmp } from '../domain/collate.js';

// Состояние таблиц (страница, размер страницы, выбор) переживает перерисовку страницы — например, когда пришла чужая правка.
const memo = new Map();

/**
 * columns: [{ key, label, render(row) => Node|string, value(row) — для сортировки, sortable, num, actions }]
 * pageSize: строк на странице (0 — без разбиения). resetKey: меняется вместе с фильтрами → возврат на первую страницу.
 * selectable: { id(row) => string, actions: [{ label, icon, kind, run(selectedRows) }] } — колонка с флажками и панель действий.
 */
export function dataTable({ columns, rows, caption = '', empty = 'Ничего не найдено', sortKey = null, sortDir = 1, rowClass = null, onSort, pageSize = 0, pageSizes = [25, 50, 100], resetKey = '', selectable = null, persistKey = null }) {
  const key = persistKey || caption || 'table';
  let st = memo.get(key);
  if (!st) {
    st = { page: 1, size: pageSize, key: sortKey, dir: sortDir, selected: new Set(), resetKey };
    memo.set(key, st);
  } else if (st.resetKey !== resetKey) {
    st.page = 1; // изменился поиск/фильтр — начинаем с первой страницы
    st.resetKey = resetKey;
  }
  const wrap = h('div', { class: 'table-block' });
  const idOf = selectable ? selectable.id : null;
  if (selectable) {
    const ids = new Set(rows.map(idOf));
    for (const id of [...st.selected]) if (!ids.has(id)) st.selected.delete(id); // выбранные, которых уже нет в списке, снимаем
  }

  function sorted() {
    const col = columns.find((c) => c.key === st.key);
    if (!col) return rows;
    const val = col.value || ((r) => r[col.key]);
    return rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : cmp(x, y);
      return r * st.dir;
    });
  }

  function draw() {
    wrap.replaceChildren();
    if (!rows.length) {
      wrap.appendChild(h('div', { class: 'empty' }, empty));
      return;
    }
    const all = sorted();
    const size = st.size || all.length;
    const pages = Math.max(1, Math.ceil(all.length / size));
    st.page = Math.min(Math.max(1, st.page), pages);
    const slice = pageSize ? all.slice((st.page - 1) * size, st.page * size) : all;

    if (selectable && st.selected.size) {
      const chosen = rows.filter((r) => st.selected.has(idOf(r)));
      wrap.appendChild(h('div', { class: 'bulkbar', role: 'region', 'aria-label': 'Действия с выбранными' },
        h('strong', null, `Выбрано: ${chosen.length}`),
        ...selectable.actions.map((a) => h('button', { type: 'button', class: `btn btn-sm${a.kind ? ` btn-${a.kind}` : ''}`, 'data-bulk': a.key || '', onclick: () => a.run(chosen, () => { st.selected.clear(); st.redraw(); }) }, a.icon ? icon(a.icon, 15) : null, h('span', null, a.label))),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { st.selected.clear(); st.redraw(); } }, 'Снять выбор')));
    }

    const pageIds = selectable ? slice.map(idOf) : [];
    const head = h('tr', null,
      selectable ? h('th', { scope: 'col', class: 'col-check' }, (() => {
        const n = pageIds.filter((id) => st.selected.has(id)).length;
        const cb = h('input', { type: 'checkbox', 'aria-label': 'Выбрать все на странице', checked: n > 0 && n === pageIds.length, onchange: () => { for (const id of pageIds) cb.checked ? st.selected.add(id) : st.selected.delete(id); draw(); } });
        cb.indeterminate = n > 0 && n < pageIds.length;
        return cb;
      })()) : null,
      columns.map((c) => {
        const sortedHere = st.key === c.key;
        const th = h('th', { scope: 'col', class: `${c.num ? 'num' : ''} ${c.actions ? 'actions' : ''}`.trim(), 'aria-sort': sortedHere ? (st.dir === 1 ? 'ascending' : 'descending') : null });
        if (c.sortable) {
          th.appendChild(h('button', { type: 'button', class: 'sort', onclick: () => {
            st.dir = sortedHere ? -st.dir : 1;
            st.key = c.key;
            onSort?.({ key: st.key, dir: st.dir });
            draw();
          } }, c.label, icon(sortedHere ? (st.dir === 1 ? 'sort-up' : 'sort-down') : 'sort', 13)));
        } else th.textContent = c.label;
        return th;
      }),
    );
    const body = slice.map((r) => {
      const id = selectable ? idOf(r) : null;
      const on = selectable && st.selected.has(id);
      return h('tr', { class: [rowClass ? rowClass(r) : '', on ? 'is-selected' : ''].join(' ').trim() || null },
        selectable ? h('td', { class: 'col-check', 'data-label': '' }, h('input', { type: 'checkbox', 'aria-label': 'Выбрать строку', checked: on, onchange: (e) => { e.target.checked ? st.selected.add(id) : st.selected.delete(id); draw(); } })) : null,
        columns.map((c) => h('td', { class: `${c.num ? 'num' : ''} ${c.actions ? 'actions' : ''}`.trim(), 'data-label': c.actions ? '' : c.label }, c.render ? c.render(r) : r[c.key])));
    });
    wrap.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'data responsive' }, caption ? h('caption', { class: 'sr-only' }, caption) : null, h('thead', null, head), h('tbody', null, body))));

    if (pageSize && all.length > Math.min(...pageSizes)) {
      const from = (st.page - 1) * size + 1;
      const to = Math.min(all.length, st.page * size);
      const sel = h('select', { 'aria-label': 'Строк на странице', onchange: () => { st.size = Number(sel.value); st.page = 1; draw(); } }, pageSizes.map((n) => h('option', { value: n, selected: n === size }, `${n} на странице`)));
      wrap.appendChild(h('div', { class: 'pager' },
        h('span', null, `${from}–${to} из ${all.length}`),
        h('div', { class: 'pager-nav' }, sel,
          h('button', { type: 'button', class: 'btn btn-sm btn-icon btn-ghost', 'aria-label': 'Предыдущая страница', disabled: st.page <= 1, onclick: () => { st.page--; draw(); } }, icon('chevron-left', 16)),
          h('span', { class: 'page-no' }, `${st.page} / ${pages}`),
          h('button', { type: 'button', class: 'btn btn-sm btn-icon btn-ghost', 'aria-label': 'Следующая страница', disabled: st.page >= pages, onclick: () => { st.page++; draw(); } }, icon('chevron-right', 16)))));
    }
  }
  st.redraw = draw; // действия, завершившиеся после перерисовки страницы, обновляют актуальную таблицу
  draw();
  return wrap;
}
