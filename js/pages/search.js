import { h } from '../ui/dom.js';
import { pageHead, classLink, personName, demoBadge, badge, link } from '../ui/common.js';
import { searchAll } from '../domain/search.js';
import { fullName, ROLE_LABEL } from '../domain/people.js';
import { nStudents } from '../domain/plural.js';
import { openStudentCard } from '../ui/student-dialogs.js';
import { dataTable } from '../ui/table.js';

export const title = 'Поиск';

export function render(ctx) {
  const { state: s, view: el, query } = ctx;
  const q = (query.q || '').trim();
  const r = searchAll(s, q);
  el.append(pageHead({ title: 'Поиск', sub: q ? `«${q}» — найдено: ${r.total}` : 'Введите запрос в строке поиска сверху' }));
  if (!q) return;
  if (!r.total) return void el.append(h('div', { class: 'card empty' }, h('h3', null, 'Ничего не найдено'), h('p', null, 'Проверьте написание или попробуйте часть фамилии, номер класса («8Б» вводите как 8B).')));

  if (r.classes.length) el.append(h('div', { class: 'card flush search-group' }, h('div', { class: 'card-head' }, h('h2', null, `Классы (${r.classes.length})`)),
    dataTable({ rows: r.classes, columns: [
      { key: 'name', label: 'Класс', render: (c) => classLink(c.cls) },
      { key: 'count', label: 'Учеников', num: true },
      { key: 'teacher', label: 'Классный руководитель', render: (c) => personName(c.teacher) },
      { key: 'tutor', label: 'Воспитатель', render: (c) => personName(c.tutor) },
    ] })));
  if (r.students.length) el.append(h('div', { class: 'card flush search-group' }, h('div', { class: 'card-head' }, h('h2', null, `Ученики (${nStudents(r.students.length)})`)),
    dataTable({ rows: r.students, columns: [
      { key: 'name', label: 'ФИО', render: (x) => h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStudentCard(ctx, x.student); } }, fullName(x.student)), ' ', demoBadge(x.student)) },
      { key: 'cls', label: 'Класс', render: (x) => (x.cls ? classLink(x.cls) : '—') },
      { key: 'st', label: 'Статус', render: (x) => (x.student.status === 'active' ? badge('Учится', 'ok') : badge(x.student.status === 'graduated' ? 'Выпускник (архив)' : 'Выбыл (архив)', 'warn')) },
    ] })));
  if (r.staff.length) el.append(h('div', { class: 'card flush search-group' }, h('div', { class: 'card-head' }, h('h2', null, `Персонал (${r.staff.length})`), link('Открыть раздел', '#/staff', 'sm')),
    dataTable({ rows: r.staff, columns: [
      { key: 'name', label: 'ФИО', render: (x) => h('span', null, fullName(x.staff), ' ', demoBadge(x.staff), x.staff.archived ? badge('Архив', 'warn') : null) },
      { key: 'role', label: 'Должность', render: (x) => ROLE_LABEL[x.staff.role] },
      { key: 'classes', label: 'Классы', render: (x) => (x.classes.length ? x.classes.join(', ') : '—') },
    ] })));
}
