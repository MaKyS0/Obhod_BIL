// Обзор дня (администратор): как прошёл обход — по классам, список учеников со статусами, действия за день; выгрузка в Excel.
import { h } from '../ui/dom.js';
import { pageHead, btn, link, notice, emptyState } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { field } from '../ui/form.js';
import { toast, toastError } from '../ui/toast.js';
import { downloadBlob } from '../services/download.js';
import { roundView, ROUND_PLACES, ROUND_KINDS, ROUND_LABEL, earliestRoundDate, shiftDate } from '../domain/rounds.js';
import { dayRows, roundWorkbook, exportFilename, recordsFromMarks, EXPORT_PREFIX } from '../domain/round-export.js';
import { XLSX_MIME } from '../domain/xlsx.js';
import { dayInfo } from '../domain/calendar.js';
import { parseAuditRow, describeAudit, EVENT_LABELS } from '../domain/audit-view.js';
import { fullName, } from '../domain/people.js';
import { todayISO, formatDate } from '../domain/dates.js';
import { placeBadge, hm, whenBy } from '../ui/round-ui.js';

export const title = 'Обзор дня';

// Выбор живёт между перерисовками (чужая правка перерисовывает страницу)
const ui = { date: null, kind: 'evening', classId: '', status: '', by: '', q: '' };
const STATUS_OPTIONS = [{ value: '', label: 'Любой статус' }, { value: 'here', label: 'На месте' }, ...ROUND_PLACES.filter((p) => p.key !== 'sleeping').map((p) => ({ value: p.key, label: p.label })), { value: 'none', label: 'Не отмечен' }];

const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
const matchStatus = (x, f) => (!f ? true : f === 'none' ? !x.place : f === 'here' ? x.place === 'sleeping' : x.place === f);

export async function render(ctx) {
  const { state: s, view: el, live } = ctx;
  const today = todayISO();
  if (!ui.date || ui.date > today) ui.date = today;
  const fresh = ui.date >= earliestRoundDate(today, ui.kind);
  let alive = true;

  // ---- данные: свежие даты — из общей базы на устройстве, старые — итоги из истории на сервере
  let records = null;
  let problem = '';
  if (!fresh) {
    if (!live) problem = 'Эта дата старше срока хранения отметок на устройстве. Историю хранит сервер Google, а он не подключён.';
    else {
      try {
        const r = await live.request('marks', { from: ui.date, to: ui.date, kind: ui.kind });
        records = recordsFromMarks(r.rows);
      } catch (e) { problem = `Не удалось получить историю: ${e.message}`; }
    }
  }
  if (!alive) return undefined;
  const v = roundView(s, ui.date, ui.kind, records || (fresh ? null : []));
  const info = dayInfo(s, ui.date);

  // ---- заголовок и действия
  const exportDay = async () => {
    try {
      const rows = dayRows(s, ui.date, ui.kind, records || (fresh ? null : []));
      const prefix = EXPORT_PREFIX[ui.kind];
      downloadBlob(exportFilename(prefix), new Blob([roundWorkbook(rows, { kind: ui.kind })], { type: XLSX_MIME }));
      toast(`Файл сохранён: ${rows.length} строк`);
      if (live) live.request('exportlog', { exportKind: prefix, from: ui.date, to: ui.date, rows: rows.length }).catch(() => toast('Файл сохранён, но запись в журнал не удалась', 'error'));
    } catch (e) { toastError(e); }
  };
  el.append(pageHead({
    title: 'Обзор дня',
    sub: `${longDate(ui.date)} · ${(ROUND_KINDS.find((k) => k.key === ui.kind) || {}).label}${info.holiday ? ' · выходной день' : ''}${info.dutyLabel ? ` · дежурные: ${info.dutyLabel}` : ''}`,
    actions: [btn('Скачать день (.xlsx)', exportDay, 'primary', { icon: 'download', id: 'exportDayBtn' }), link('Отчёты', '#/admin/reports', '', { icon: 'chart' })],
  }));
  if (problem) el.append(notice('warn', problem));
  if (info.holiday) el.append(notice('info', info.note ? `Выходной: ${info.note}.` : 'В календаре этот день отмечен как выходной.'));

  // ---- фильтры
  const dateInput = h('input', { type: 'date', value: ui.date, max: today, 'aria-label': 'Дата', onchange: () => { if (dateInput.value) { ui.date = dateInput.value > today ? today : dateInput.value; ctx.refresh(); } } });
  const stepBtn = (days, label, ic) => btn('', () => { const d = shiftDate(ui.date, days); if (d <= today) { ui.date = d; ctx.refresh(); } }, 'sm ghost', { icon: ic, 'aria-label': label, title: label });
  const kindSel = field({ label: 'Проверка', name: 'dayKind', value: ui.kind, options: ROUND_KINDS.map((k) => ({ value: k.key, label: k.label })) });
  kindSel.input.addEventListener('change', () => { ui.kind = kindSel.get(); ctx.refresh(); });
  const classSel = field({ label: 'Класс', name: 'dayClass', value: ui.classId, options: [{ value: '', label: 'Все классы' }, ...v.groups.map((g) => ({ value: g.id, label: g.name }))] });
  classSel.input.addEventListener('change', () => { ui.classId = classSel.get(); ctx.refresh(); });
  const statusSel = field({ label: 'Статус', name: 'dayStatus', value: ui.status, options: STATUS_OPTIONS });
  statusSel.input.addEventListener('change', () => { ui.status = statusSel.get(); ctx.refresh(); });
  const bys = [...new Set(v.groups.flatMap((g) => g.students.map((x) => x.by).filter(Boolean)))].sort();
  const bySel = field({ label: 'Ответственный', name: 'dayBy', value: ui.by, options: [{ value: '', label: 'Любой' }, ...bys.map((b) => ({ value: b, label: b }))] });
  bySel.input.addEventListener('change', () => { ui.by = bySel.get(); ctx.refresh(); });
  const q = h('input', { type: 'search', value: ui.q, placeholder: 'Ученик', 'aria-label': 'Поиск ученика', oninput: () => { ui.q = q.value; drawList(); } });
  el.append(h('div', { class: 'filters-bar no-print' },
    h('div', { class: 'date-step' }, stepBtn(-1, 'Предыдущий день', 'chevron-left'), dateInput, stepBtn(1, 'Следующий день', 'chevron-right'), btn('Сегодня', () => { ui.date = today; ctx.refresh(); }, 'sm ghost')),
    kindSel.el, classSel.el, statusSel.el, bySel.el, h('div', { class: 'field' }, q)));

  // ---- сводка одной строкой
  const t = v.totals;
  el.append(h('div', { class: 'summary-line', 'aria-label': 'Итоги дня' },
    h('span', null, 'Отмечено ', h('b', null, `${t.marked} из ${t.total}`)),
    h('span', null, 'На месте ', h('b', null, String(t.byPlace.sleeping))),
    ...ROUND_PLACES.filter((p) => p.key !== 'sleeping').map((p) => h('span', null, `${p.label} `, h('b', null, String(t.byPlace[p.key])))),
    h('span', null, 'Не отмечено ', h('b', null, String(t.total - t.marked))),
    h('span', null, 'Классов не закрыто ', h('b', null, String(v.classesLeft)))));

  // ---- по классам
  const groups = v.groups.filter((g) => !ui.classId || g.id === ui.classId);
  if (!groups.length) {
    el.append(h('div', { class: 'panel' }, emptyState('Нет данных', 'В этом году пока нет учеников в классах.', [], 'users')));
    return undefined;
  }
  const last = (g) => g.students.filter((x) => x.place && x.at).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const cnt = (g, k) => g.students.filter((x) => x.place === k).length;
  const rows = groups.map((g) => ({ g, last: last(g) }));
  const sum = (f) => groups.reduce((n, g) => n + f(g), 0);
  rows.push({ total: true, g: { name: 'Итого', total: sum((g) => g.total), marked: sum((g) => g.marked), cnt: (k) => sum((g) => cnt(g, k)) } });
  el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'По классам')),
    dataTable({
      caption: 'Обход по классам', rows, persistKey: 'day-classes', rowClass: (r) => (r.total ? 'total-row' : r.g.done ? '' : r.g.marked ? '' : 'muted-row'),
      columns: [
        { key: 'cls', label: 'Класс', render: (r) => (r.total ? r.g.name : h('strong', null, r.g.name)) },
        { key: 'room', label: 'Каб.', render: (r) => (r.total ? '' : r.g.room || '—') },
        { key: 'tutor', label: 'Воспитатель', render: (r) => (r.total ? '' : r.g.tutor ? fullName(r.g.tutor) : h('span', { class: 'muted' }, 'не назначен')) },
        { key: 'total', label: 'Учеников', num: true, render: (r) => String(r.g.total) },
        { key: 'marked', label: 'Отмечено', num: true, render: (r) => String(r.g.marked) },
        { key: 'here', label: 'На месте', num: true, render: (r) => String(r.total ? r.g.cnt('sleeping') : cnt(r.g, 'sleeping')) },
        ...ROUND_PLACES.filter((p) => p.key !== 'sleeping').map((p) => ({ key: p.key, label: p.label, num: true, render: (r) => String(r.total ? r.g.cnt(p.key) : cnt(r.g, p.key)) })),
        { key: 'last', label: 'Последняя отметка', render: (r) => (r.total ? '' : r.last ? whenBy(r.last.at, r.last.by) : '—') },
      ],
    })));

  // ---- список учеников (фильтры статуса, ответственного и имени)
  const listHolder = h('div');
  const countEl = h('span', { class: 'meta' });
  el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'Ученики'), countEl), listHolder));
  function drawList() {
    const needle = ui.q.trim().toLowerCase();
    const list = groups.flatMap((g) => g.students.map((x) => ({ ...x, cls: g.name }))).filter((x) => matchStatus(x, ui.status) && (!ui.by || x.by === ui.by) && (!needle || fullName(x.student).toLowerCase().includes(needle)));
    countEl.textContent = `Показано: ${list.length}`;
    listHolder.replaceChildren(dataTable({
      caption: 'Ученики и статусы', rows: list, persistKey: 'day-students', pageSize: 50, resetKey: `${ui.date}|${ui.kind}|${ui.classId}|${ui.status}|${ui.by}|${ui.q}`,
      empty: 'Никого не найдено. Измените фильтры.',
      columns: [
        { key: 'name', label: 'Ученик', value: (r) => fullName(r.student), sortable: true, render: (r) => fullName(r.student) },
        { key: 'cls', label: 'Класс', sortable: true },
        { key: 'place', label: 'Статус', render: (r) => placeBadge(r.place) },
        { key: 'reason', label: 'Причина', render: (r) => r.reason || h('span', { class: 'muted' }, '—') },
        { key: 'at', label: 'Время', sortable: true, value: (r) => r.at || '', render: (r) => hm(r.at) || '—' },
        { key: 'by', label: 'Ответственный', sortable: true, render: (r) => r.by || h('span', { class: 'muted' }, '—') },
      ],
    }));
  }
  drawList();

  // ---- действия за день (журнал сервера)
  if (live) {
    const hist = h('div', { class: 'muted' }, 'Загрузка…');
    el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'История действий за день'), link('Весь журнал', `#/admin/logs?date=${ui.date}`, 'sm ghost')), h('div', { class: 'panel-body' }, hist)));
    const from = new Date(`${ui.date}T00:00:00`);
    const to = new Date(from.getTime() + 86400000);
    live.request('log', { fromAt: from.toISOString(), toAt: to.toISOString(), limit: 12, events: ['round-set', 'round-change', 'export', 'access-allow', 'access-deny', 'access-revoke', 'access-role', 'clear', 'promotion'] }).then((r) => {
      if (!alive) return;
      const items = r.rows.map(parseAuditRow);
      hist.className = '';
      hist.replaceChildren(items.length ? h('ul', { class: 'activity' }, items.map((e) => h('li', null,
        h('span', { class: 'what' }, h('span', { class: 'kind' }, `${e.actor || '—'}: `), `${EVENT_LABELS[e.event] || e.event} — ${describeAudit(e, s)}`),
        h('span', { class: 'when', title: formatDate(e.at.slice(0, 10)) }, hm(e.at))))) : h('p', { class: 'muted' }, 'За этот день записей пока нет.'));
    }).catch((e) => { if (alive) { hist.className = 'muted'; hist.textContent = `Журнал недоступен: ${e.message}`; } });
  }
  return () => { alive = false; };
}
