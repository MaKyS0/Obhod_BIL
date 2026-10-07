import { h } from '../ui/dom.js';
import { pageHead, notice, personName, demoBadge, badge } from '../ui/common.js';
import { field } from '../ui/form.js';
import { yearView } from '../domain/stats.js';
import { compareYears, yearLabel } from '../domain/years.js';
import { fullName } from '../domain/people.js';
import { formatDate } from '../domain/dates.js';
import { nStudents, nClasses } from '../domain/plural.js';

export const title = 'История';

export function render(ctx) {
  const { state: s, view: el, params } = ctx;
  const years = s.years.slice().sort((a, b) => compareYears(b.id, a.id));
  const yid = params.yearId && years.some((y) => y.id === params.yearId) ? params.yearId : s.settings.currentYearId;
  const year = years.find((y) => y.id === yid);
  const v = yearView(s, yid);
  const isCurrent = yid === s.settings.currentYearId;

  const sel = field({ label: 'Учебный год', name: 'year', value: yid, options: years.map((y) => ({ value: y.id, label: `${yearLabel(y.id)}${y.id === s.settings.currentYearId ? ' (текущий)' : ''}` })) });
  sel.input.addEventListener('change', () => (location.hash = `#/history/${sel.get()}`));
  el.append(pageHead({ title: 'История', sub: 'Состояние лицея на конец выбранного учебного года: классы, ученики, руководители' }));
  el.append(h('div', { class: 'card', style: 'max-width:420px;margin-bottom:16px' }, sel.el));

  if (params.yearId && !years.some((y) => y.id === params.yearId)) el.append(notice('warn', `Учебный год ${yearLabel(params.yearId)} в базе не найден. Показан текущий год.`));
  el.append(h('div', { class: 'history-banner' }, isCurrent ? 'Это текущий учебный год — данные ещё меняются. Редактирование — в разделах «Классы», «Ученики», «Персонал».' : `Архивные данные за ${yearLabel(yid)} учебный год. Только просмотр — изменить их нельзя.`));

  el.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'value' }, String(v.total)), h('div', { class: 'label' }, 'Учеников')),
    h('div', { class: 'stat' }, h('div', { class: 'value' }, String(v.classCount)), h('div', { class: 'label' }, 'Классов')),
    h('div', { class: 'stat' }, h('div', { class: 'value' }, String(v.teachersAssigned)), h('div', { class: 'label' }, 'Классных руководителей')),
    h('div', { class: 'stat' }, h('div', { class: 'value' }, String(v.tutorsAssigned)), h('div', { class: 'label' }, 'Воспитателей')),
  ));
  el.append(h('div', { class: 'card' }, h('h2', null, 'Параллели'), v.grades.map((g) => h('div', { class: 'grade-line' },
    h('div', { class: 'name' }, `${g.grade} классы`),
    h('div', { class: 'bar' }, h('span', { style: `width:${(g.count / Math.max(1, ...v.grades.map((x) => x.count))) * 100}%` })),
    h('div', { class: 'meta' }, `${nClasses(g.classCount)} · ${nStudents(g.count)}`)))));

  const blocks = v.classes.map((c) => h('details', { class: 'class-block' },
    h('summary', null, h('strong', { style: 'min-width:36px' }, c.name), h('span', null, nStudents(c.count)), h('span', { class: 'muted' }, `КР: `, personName(c.teacher), ' · Воспитатель: ', personName(c.tutor))),
    h('div', { class: 'inner' }, c.students.length
      ? h('table', { class: 'data responsive' }, h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'ФИО'), h('th', null, 'Дата рождения'), h('th', null, 'Итог года'))),
        h('tbody', null, c.students.map((x, i) => h('tr', null,
          h('td', { 'data-label': '№' }, String(i + 1)),
          h('td', { 'data-label': 'ФИО' }, fullName(x.student), ' ', demoBadge(x.student)),
          h('td', { 'data-label': 'Дата рождения' }, x.student.birthDate ? formatDate(x.student.birthDate) : '—'),
          h('td', { 'data-label': 'Итог года' }, x.enr.status === 'graduated' ? badge('Выпуск', 'info') : x.enr.heldBack ? badge('Второй год', 'warn') : '—')))))
      : h('p', { class: 'muted' }, 'В классе не было учеников'))));
  el.append(h('div', { class: 'card flush', style: 'margin-top:16px' }, h('div', { class: 'card-head' }, h('h2', null, `Классы ${yearLabel(yid)}`)), v.classes.length ? blocks : h('div', { class: 'empty' }, 'В этом году нет классов')));
  void year;
}
