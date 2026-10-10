// Журнал действий (администратор): вход, запросы доступа, решения, обход, смена статусов, выгрузки, правки данных.
// Записи пишет только сервер Google, поэтому подделать их с устройства нельзя.
import { h } from '../ui/dom.js';
import { pageHead, btn, notice, badge, skeleton } from '../ui/common.js';
import { field } from '../ui/form.js';
import { toastError } from '../ui/toast.js';
import { parseAuditRow, describeAudit, EVENT_LABELS, EVENT_GROUPS, ROLE_LABEL } from '../domain/audit-view.js';
import { todayISO, formatDate } from '../domain/dates.js';
import { hm } from '../ui/round-ui.js';

export const title = 'Журнал';

const ui = { from: '', to: '', group: '', actor: '', target: '' };
const BAD = new Set(['login-failed', 'push-rejected', 'access-deny', 'access-revoke', 'clear']);

export function render(ctx) {
  const { view: el, live, query, state: s } = ctx;
  el.append(pageHead({ title: 'Журнал', sub: 'Кто и что делал: входы, запросы доступа, обход, смена статусов, выгрузки в Excel, правки' }));
  if (!live) {
    el.append(notice('info', 'Журнал ведёт сервер Google. Он подключается в файле ', h('code', null, 'js/config.js'), ' — сейчас сайт работает без сервера, и записывать действия некому.'));
    return undefined;
  }
  if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) { ui.from = query.date; ui.to = query.date; }
  const today = todayISO();
  let alive = true;
  let seq = 0;

  const from = field({ label: 'С даты', name: 'logFrom', type: 'date', value: ui.from, attrs: { max: today } });
  const to = field({ label: 'По дату', name: 'logTo', type: 'date', value: ui.to, attrs: { max: today } });
  const group = field({ label: 'Что искать', name: 'logGroup', value: ui.group, options: [{ value: '', label: 'Все события' }, ...EVENT_GROUPS.map((g) => ({ value: g.key, label: g.label }))] });
  const actor = field({ label: 'Участник', name: 'logActor', value: ui.actor, placeholder: 'Имя или роль', attrs: { maxlength: 80 } });
  const target = field({ label: 'Объект', name: 'logTarget', value: ui.target, placeholder: 'Класс, ученик, дата', attrs: { maxlength: 80 } });
  const tbody = h('tbody');
  const more = btn('Показать ещё', () => load(false), '', { id: 'logMore' });
  const status = h('div', { class: 'meta', 'aria-live': 'polite' });
  let next = null;
  let rows = 0;

  const apply = () => { ui.from = from.get(); ui.to = to.get(); ui.group = group.get(); ui.actor = actor.get().trim(); ui.target = target.get().trim(); load(true); };
  const reset = () => { Object.assign(ui, { from: '', to: '', group: '', actor: '', target: '' }); ctx.router.go('#/admin/logs', { replace: true }); };
  const form = h('form', { class: 'filters-bar no-print', onsubmit: (e) => { e.preventDefault(); apply(); } },
    from.el, to.el, group.el, actor.el, target.el,
    h('div', { class: 'filters-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', id: 'logApply' }, 'Показать'), btn('Сбросить', reset, 'ghost')));
  el.append(form);

  const table = h('table', { class: 'data log', 'aria-label': 'Журнал действий' },
    h('thead', null, h('tr', null, ['Время', 'Кто', 'Событие', 'Что именно'].map((t) => h('th', { scope: 'col' }, t)))), tbody);
  const wait = h('div', { class: 'panel-body' }, skeleton(5, 'Загрузка журнала'));
  el.append(h('div', { class: 'card flush' }, wait, h('div', { class: 'table-wrap' }, table), h('div', { class: 'log-foot' }, status, more)));

  const filter = () => {
    const f = { limit: 100 };
    if (ui.from) f.fromAt = new Date(`${ui.from}T00:00:00`).toISOString();
    if (ui.to) f.toAt = new Date(new Date(`${ui.to}T00:00:00`).getTime() + 86400000).toISOString();
    if (ui.group) f.events = (EVENT_GROUPS.find((g) => g.key === ui.group) || { events: [] }).events;
    if (ui.actor) f.actor = ui.actor;
    if (ui.target) f.target = ui.target;
    return f;
  };

  function line(e) {
    const day = e.at.slice(0, 10);
    const ts = new Date(e.at);
    const dayLocal = Number.isNaN(ts.getTime()) ? day : `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
    return h('tr', { 'data-event': e.event },
      h('td', { class: 'nowrap' }, h('span', null, hm(e.at) || '—'), h('div', { class: 'meta' }, formatDate(dayLocal))),
      h('td', null, h('strong', null, e.actor || '—'), e.role ? h('div', { class: 'meta' }, ROLE_LABEL[e.role] || e.role) : null),
      h('td', null, badge(EVENT_LABELS[e.event] || e.event, BAD.has(e.event) ? 'danger' : '')),
      h('td', null, describeAudit(e, s) || h('span', { class: 'muted' }, '—')));
  }

  async function load(reset_) {
    const mine = ++seq;
    more.disabled = true;
    if (reset_) { tbody.replaceChildren(); next = null; rows = 0; status.textContent = 'Загрузка…'; wait.hidden = false; }
    else status.textContent = 'Загрузка…';
    try {
      const r = await live.request('log', { ...filter(), ...(reset_ || !next ? {} : { before: next }) });
      if (!alive || mine !== seq) return;
      wait.hidden = true;
      const items = r.rows.map(parseAuditRow);
      tbody.append(...items.map(line));
      rows += items.length;
      next = r.next;
      status.textContent = rows ? `Записей: ${rows}${next ? ' (есть более старые)' : ''}` : 'Записей по этим условиям нет.';
      if (!rows) tbody.append(h('tr', null, h('td', { colspan: 4, class: 'empty-cell' }, 'Записей по этим условиям нет. Измените фильтры.')));
    } catch (e) {
      if (!alive || mine !== seq) return;
      status.textContent = '';
      toastError(e);
    } finally {
      more.hidden = !next;
      more.disabled = false;
    }
  }
  load(true);
  return () => { alive = false; };
}
