// Таблица с сортировкой; на узких экранах превращается в карточки (data-label).
import { h } from './dom.js';
import { cmp } from '../domain/collate.js';

/**
 * columns: [{ key, label, render(row) => Node|string, value(row) — для сортировки, sortable, num, actions }]
 */
export function dataTable({ columns, rows, caption = '', empty = 'Ничего не найдено', sortKey = null, sortDir = 1, rowClass = null, onSort }) {
  const state = { key: sortKey, dir: sortDir };
  const wrap = h('div', { class: 'table-wrap' });

  function sorted() {
    const col = columns.find((c) => c.key === state.key);
    if (!col) return rows;
    const val = col.value || ((r) => (col.render ? r[col.key] : r[col.key]));
    return rows.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : cmp(x, y);
      return r * state.dir;
    });
  }

  function draw() {
    wrap.replaceChildren();
    if (!rows.length) {
      wrap.appendChild(h('div', { class: 'empty' }, empty));
      return;
    }
    const head = h(
      'tr',
      null,
      columns.map((c) => {
        const th = h('th', { scope: 'col', class: `${c.num ? 'num' : ''} ${c.actions ? 'actions' : ''}`.trim(), 'aria-sort': state.key === c.key ? (state.dir === 1 ? 'ascending' : 'descending') : null });
        if (c.sortable) {
          th.appendChild(h('button', { type: 'button', class: 'sort', onclick: () => {
            state.dir = state.key === c.key ? -state.dir : 1;
            state.key = c.key;
            onSort?.(state);
            draw();
          } }, c.label));
        } else th.textContent = c.label;
        return th;
      }),
    );
    const body = sorted().map((r) =>
      h(
        'tr',
        { class: rowClass ? rowClass(r) : null },
        columns.map((c) => h('td', { class: `${c.num ? 'num' : ''} ${c.actions ? 'actions' : ''}`.trim(), 'data-label': c.actions ? '' : c.label }, c.render ? c.render(r) : r[c.key])),
      ),
    );
    wrap.appendChild(h('table', { class: 'data responsive' }, caption ? h('caption', { class: 'sr-only' }, caption) : null, h('thead', null, head), h('tbody', null, body)));
  }
  draw();
  return wrap;
}
