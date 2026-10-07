import { h } from '../ui/dom.js';
import { pageHead, btn, classLink, personName } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { field } from '../ui/form.js';
import { downloadText } from '../services/download.js';
import { toast } from '../ui/toast.js';
import { yearView, staffReport, generalReport } from '../domain/stats.js';
import { studentsCsv, classesCsv, staffCsv, generalCsv } from '../domain/exports.js';
import { compareYears, yearLabel } from '../domain/years.js';
import { fullName } from '../domain/people.js';
import { todayISO, formatDate } from '../domain/dates.js';

export const title = 'Отчёты';
const memo = { tab: 'general' };

export function render(ctx) {
  const { state: s, view: el, query } = ctx;
  const years = s.years.slice().sort((a, b) => compareYears(b.id, a.id));
  const yid = query.year && years.some((y) => y.id === query.year) ? query.year : s.settings.currentYearId;
  const v = yearView(s, yid);

  const sel = field({ label: 'Учебный год', name: 'year', value: yid, options: years.map((y) => ({ value: y.id, label: yearLabel(y.id) })) });
  sel.input.addEventListener('change', () => ctx.router.go(`#/reports?year=${sel.get()}`, { replace: true }));
  el.append(pageHead({ title: 'Отчёты', sub: 'Формируются автоматически из данных сайта', actions: [btn('Печать', () => window.print(), '')] }));
  el.append(h('div', { class: 'print-only' }, h('h2', null, `${s.settings.lyceumName} — отчёт, учебный год ${yearLabel(yid)}`), h('p', null, `Сформирован ${formatDate(todayISO())}`)));
  el.append(h('div', { class: 'card no-print', style: 'max-width:420px;margin-bottom:16px' }, sel.el));

  const tabsDef = [['general', 'Общий отчёт'], ['classes', 'По классам'], ['staff', 'По персоналу']];
  el.append(h('div', { class: 'tabs', role: 'tablist' }, tabsDef.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(memo.tab === k), onclick: () => { memo.tab = k; ctx.refresh(); } }, l))));

  const csvBtn = (name, text) => btn('Скачать CSV', () => { downloadText(`${name}-${yid}.csv`, text, 'text/csv;charset=utf-8'); toast('Файл сохранён'); }, 'sm', { class: 'btn btn-sm no-print' });

  if (memo.tab === 'general') {
    const rows = generalReport(v).map(([k, val]) => ({ k, val: k === 'Учебный год' ? yearLabel(val) : val }));
    el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'Общий отчёт'), csvBtn('общий-отчёт', generalCsv(s, yid))),
      dataTable({ caption: 'Общий отчёт', rows, empty: 'Нет данных', columns: [{ key: 'k', label: 'Показатель' }, { key: 'val', label: 'Значение', num: true }] })));
  } else if (memo.tab === 'classes') {
    const rows = v.classes;
    el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'Отчёт по классам'), h('div', { class: 'row' }, csvBtn('классы', classesCsv(s, yid)), btn('Список учеников CSV', () => { downloadText(`ученики-${yid}.csv`, studentsCsv(s, yid), 'text/csv;charset=utf-8'); toast('Файл сохранён'); }, 'sm', { class: 'btn btn-sm no-print' }))),
      dataTable({ caption: 'Отчёт по классам', rows, sortKey: null, empty: 'В этом году нет классов', columns: [
        { key: 'name', label: 'Класс', sortable: true, value: (r) => r.grade * 10 + r.letter.charCodeAt(0) / 100, render: (r) => classLink(r.cls) },
        { key: 'count', label: 'Учеников', num: true, sortable: true },
        { key: 'teacher', label: 'Классный руководитель', value: (r) => (r.teacher ? fullName(r.teacher) : ''), render: (r) => personName(r.teacher) },
        { key: 'tutor', label: 'Воспитатель', value: (r) => (r.tutor ? fullName(r.tutor) : ''), render: (r) => personName(r.tutor) },
      ] }),
      h('div', { style: 'padding:10px 16px;font-weight:600' }, `Итого: ${v.total} учеников в ${v.classCount} классах`)));
  } else {
    const rows = staffReport(s, yid);
    el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'Отчёт по персоналу'), csvBtn('персонал', staffCsv(s, yid))),
      dataTable({ caption: 'Отчёт по персоналу', rows, empty: 'Персонал не добавлен', columns: [
        { key: 'name', label: 'ФИО', sortable: true },
        { key: 'roleLabel', label: 'Должность', sortable: true },
        { key: 'classes', label: 'Класс', render: (r) => (r.classes.length ? r.classes.join(', ') : h('span', { class: 'muted' }, '—')) },
        { key: 'count', label: 'Закреплено классов', num: true, sortable: true },
      ] })));
  }
}
