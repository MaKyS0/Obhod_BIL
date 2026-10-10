// Отчёты обхода (администратор): по школе и по классу за выбранный период. Данные считает сервер по истории отметок;
// выходные дни из календаря не учитываются. Из того же периода можно скачать подробный файл .xlsx.
import { h } from '../ui/dom.js';
import { pageHead, btn, notice, skeleton } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { field } from '../ui/form.js';
import { barChart } from '../ui/charts.js';
import { toast, toastError } from '../ui/toast.js';
import { downloadBlob } from '../services/download.js';
import { ROUND_KINDS, shiftDate } from '../domain/rounds.js';
import { marksRows, roundWorkbook, exportFilename, EXPORT_PREFIX } from '../domain/round-export.js';
import { XLSX_MIME } from '../domain/xlsx.js';
import { fullName } from '../domain/people.js';
import { todayISO, formatDate } from '../domain/dates.js';

export const title = 'Отчёты обхода';

const PRESETS = [
  { key: 'today', label: 'Сегодня' },
  { key: 'week', label: '7 дней' },
  { key: 'month', label: '30 дней' },
  { key: 'cur', label: 'Этот месяц' },
  { key: 'custom', label: 'Свой период' },
];
const ui = { preset: 'week', from: '', to: '', kind: 'evening', classId: '' };

function period(today) {
  if (ui.preset === 'today') return [today, today];
  if (ui.preset === 'week') return [shiftDate(today, -6), today];
  if (ui.preset === 'month') return [shiftDate(today, -29), today];
  if (ui.preset === 'cur') return [`${today.slice(0, 7)}-01`, today];
  return [ui.from || shiftDate(today, -6), ui.to || today];
}
const shortDay = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

export function render(ctx) {
  const { state: s, view: el, live } = ctx;
  el.append(pageHead({ title: 'Отчёты обхода', sub: 'Как проходил обход за период: по школе и по классам' }));
  if (!live) {
    el.append(notice('info', 'Итоги за период считает сервер Google по истории отметок. Сервер не подключён (', h('code', null, 'js/config.js'), '), поэтому за период отчёт построить нельзя. Итоги за сегодня — на странице «Обзор дня».'));
    return undefined;
  }
  const today = todayISO();
  let alive = true;
  let seq = 0;

  const classes = (s.classes || []).filter((c) => c.yearId === s.settings.currentYearId && !c.archived).slice().sort((a, b) => (a.grade - b.grade) || String(a.letter).localeCompare(String(b.letter)));
  const presetSel = field({ label: 'Период', name: 'repPreset', value: ui.preset, options: PRESETS.map((p) => ({ value: p.key, label: p.label })) });
  const fromIn = field({ label: 'С', name: 'repFrom', type: 'date', value: period(today)[0], attrs: { max: today } });
  const toIn = field({ label: 'По', name: 'repTo', type: 'date', value: period(today)[1], attrs: { max: today } });
  const kindSel = field({ label: 'Проверка', name: 'repKind', value: ui.kind, options: ROUND_KINDS.map((k) => ({ value: k.key, label: k.label })) });
  const classSel = field({ label: 'Отчёт', name: 'repClass', value: ui.classId, options: [{ value: '', label: 'По всей школе' }, ...classes.map((c) => ({ value: c.id, label: `Класс ${c.name}` }))] });
  const custom = () => presetSel.get() === 'custom';
  const paintDates = () => { fromIn.el.hidden = !custom(); toIn.el.hidden = !custom(); };
  presetSel.input.addEventListener('change', () => { ui.preset = presetSel.get(); const [f, t] = period(today); fromIn.set(f); toIn.set(t); paintDates(); });
  paintDates();

  const body = h('div', { 'aria-live': 'polite' });
  const readRange = () => {
    ui.preset = presetSel.get();
    if (ui.preset === 'custom') { ui.from = fromIn.get(); ui.to = toIn.get(); }
    ui.kind = kindSel.get();
    ui.classId = classSel.get();
    const [from, to] = period(today);
    if (from > to) throw new Error('Начало периода позже конца');
    if (to > today) throw new Error('Период не может заканчиваться в будущем');
    return { from, to };
  };

  async function show() {
    let rg;
    try { rg = readRange(); } catch (e) { toastError(e); return; }
    const mine = ++seq;
    body.replaceChildren(skeleton(5, 'Считаем отчёт'), h('p', { class: 'meta' }, 'Сервер Google может отвечать до полуминуты.'));
    try {
      const r = await live.request('stats', { ...rg, kind: ui.kind, classId: ui.classId });
      if (!alive || mine !== seq) return;
      draw(rg, r);
    } catch (e) {
      if (!alive || mine !== seq) return;
      body.replaceChildren(notice('danger', e.code === 'too-many' ? 'Слишком большой период: выберите короче.' : `Не удалось получить отчёт: ${e.message}`));
    }
  }

  function draw(rg, r) {
    const sum = (rows, i) => rows.reduce((n, x) => n + x[i], 0);
    const here = sum(r.perDay, 1), sick = sum(r.perDay, 2), home = sum(r.perDay, 3), absent = sum(r.perDay, 4);
    const all = here + sick + home + absent;
    const pct = (n) => (all ? `${Math.round((n / all) * 1000) / 10}%` : '—');
    const className = (id) => !id ? 'Без класса' : (classes.find((c) => c.id === id) || (s.classes || []).find((c) => c.id === id) || { name: id }).name;
    const studentName = (id) => { const x = (s.students || []).find((st) => st.id === id); return x ? fullName(x) : 'Ученик удалён из базы'; };
    const nodes = [];
    nodes.push(h('div', { class: 'summary-line' },
      h('span', null, 'Период ', h('b', null, `${formatDate(rg.from)}${rg.to !== rg.from ? ` – ${formatDate(rg.to)}` : ''}`)),
      h('span', null, 'Дней с отметками ', h('b', null, String(r.days))),
      h('span', null, 'Выходных в периоде ', h('b', null, String(r.holidays))),
      h('span', null, 'Отметок ', h('b', null, String(all))),
      h('span', null, 'Ночевали ', h('b', null, `${here} (${pct(here)})`)),
      h('span', null, 'Болели ', h('b', null, String(sick))),
      h('span', null, 'С дома ', h('b', null, String(home))),
      h('span', null, 'Отсутствовали ', h('b', null, String(absent)))));
    if (!r.perDay.length) {
      nodes.push(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('h3', null, 'За этот период отметок нет'), h('p', null, 'Сервер хранит историю с момента, когда начал вести её после обновления скрипта. Выберите другой период.'))));
      body.replaceChildren(...nodes);
      return;
    }
    if (r.perDay.length <= 45) {
      const chart = barChart({ labels: r.perDay.map((x) => shortDay(x[0])), data: r.perDay.map((x) => x[2] + x[3] + x[4]), label: 'Не ночевали', title: 'Не ночевали в лицее по дням' });
      nodes.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Кого не было на ночёвке, по дням')), h('div', { class: 'panel-body' }, chart.el)));
    }
    const dayCols = (label) => [
      { key: 'k', label, sortable: true, value: (x) => x.k, render: (x) => x.label },
      { key: 'here', label: 'Ночевали', num: true, sortable: true },
      { key: 'sick', label: 'Болели', num: true, sortable: true },
      { key: 'home', label: 'С дома', num: true, sortable: true },
      { key: 'absent', label: 'Отсутствовали', num: true, sortable: true },
      { key: 'pct', label: 'Не было, %', num: true, value: (x) => x.pct, render: (x) => (x.total ? `${Math.round(x.pct * 10) / 10}%` : '—') },
    ];
    const toRow = (x, label) => { const total = x[1] + x[2] + x[3] + x[4]; return { k: x[0], label, here: x[1], sick: x[2], home: x[3], absent: x[4], total, pct: total ? ((x[2] + x[3] + x[4]) / total) * 100 : 0 }; };
    nodes.push(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'По дням')),
      dataTable({ caption: 'Итоги по дням', rows: r.perDay.slice().reverse().map((x) => toRow(x, formatDate(x[0]))), sortKey: null, columns: dayCols('Дата'), persistKey: 'rep-days', pageSize: 31 })));
    if (!ui.classId) {
      nodes.push(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'По классам')),
        dataTable({ caption: 'Итоги по классам', rows: r.perClass.map((x) => toRow(x, className(x[0]))), sortKey: null, columns: dayCols('Класс'), persistKey: 'rep-classes', pageSize: 40 })));
    } else if (r.perStudent.length) {
      nodes.push(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, `Ученики класса ${className(ui.classId)}`)),
        dataTable({ caption: 'Итоги по ученикам', rows: r.perStudent.map((x) => toRow(x, studentName(x[0]))), sortKey: null, columns: dayCols('Ученик'), persistKey: 'rep-students', pageSize: 40 })));
    }
    body.replaceChildren(...nodes);
  }

  async function download() {
    let rg;
    try { rg = readRange(); } catch (e) { toastError(e); return; }
    const prefix = EXPORT_PREFIX[ui.kind];
    try {
      const r = await live.request('marks', { ...rg, kind: ui.kind, classId: ui.classId, purpose: 'export', exportKind: ui.classId ? 'класс-период' : 'школа-период' });
      const rows = marksRows(s, r.rows);
      if (!rows.length) { toast('За выбранный период отметок нет — файл не создан', 'error'); return; }
      downloadBlob(exportFilename(prefix), new Blob([roundWorkbook(rows, { sheetName: 'Обход', kind: ui.kind })], { type: XLSX_MIME }));
      toast(`Файл сохранён: ${rows.length} строк`);
    } catch (e) { toastError(e); }
  }

  el.append(h('form', { class: 'filters-bar no-print', onsubmit: (e) => { e.preventDefault(); show(); } },
    presetSel.el, fromIn.el, toIn.el, kindSel.el, classSel.el,
    h('div', { class: 'filters-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', id: 'repShow' }, 'Показать'), btn('Скачать .xlsx', download, '', { icon: 'download', id: 'repDownload' }))));
  el.append(body);
  show();
  return () => { alive = false; };
}
