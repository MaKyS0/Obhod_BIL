import { h } from '../ui/dom.js';
import { pageHead, btn, studentStatusBadge, demoBadge, link } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { field, classOptions } from '../ui/form.js';
import { openStudentForm, openMoveStudent, openDeleteStudent, openStudentCard } from '../ui/student-dialogs.js';
import { yearView } from '../domain/stats.js';
import { fullName, norm } from '../domain/people.js';
import { formatDate } from '../domain/dates.js';
import { nStudents } from '../domain/plural.js';
import { yearLabel } from '../domain/years.js';

export const title = 'Ученики';
const LIMIT = 300;
const memo = { q: '', grade: '', classId: '', status: '' };

export function render(ctx) {
  const { state: s, view: el, query } = ctx;
  const yid = s.settings.currentYearId;
  const v = yearView(s, yid);
  if ('status' in query) memo.status = query.status;
  if ('q' in query) memo.q = query.q;

  const all = [
    ...v.classes.flatMap((c) => c.students.map((x) => ({ ...x, cls: c.cls, grade: c.grade }))),
    ...v.unassigned.map((x) => ({ ...x, cls: null, grade: 0 })),
    ...v.pending.map((x) => ({ ...x, cls: null, grade: 0 })),
  ];

  el.append(pageHead({
    title: 'Ученики',
    sub: `Учебный год ${yearLabel(yid)} · всего ${nStudents(all.length)}`,
    actions: [btn('Добавить ученика', () => openStudentForm(ctx), 'primary'), link('Импорт списком', '#/import')],
  }));

  const q = h('input', { type: 'search', value: memo.q, placeholder: 'Поиск по ФИО', 'aria-label': 'Поиск по ФИО', oninput: () => { memo.q = q.value; draw(); } });
  const grade = field({ label: 'Параллель', name: 'grade', value: memo.grade, options: [{ value: '', label: 'Все параллели' }, ...v.grades.map((g) => ({ value: String(g.grade), label: `${g.grade} классы` }))] });
  const klass = field({ label: 'Класс', name: 'klass', value: memo.classId, options: classOptions(v, { empty: 'Все классы' }) });
  const status = field({ label: 'Статус', name: 'status', value: memo.status, options: [{ value: '', label: 'Все' }, { value: 'studying', label: 'Учатся (в классе)' }, { value: 'noclass', label: 'Без класса' }, { value: 'pending', label: 'Ожидают выпуска' }] });
  for (const [f, k] of [[grade, 'grade'], [klass, 'classId'], [status, 'status']]) f.input.addEventListener('change', () => { memo[k] = f.get(); draw(); });
  const holder = h('div');
  const count = h('div', { class: 'muted', style: 'margin:0 0 8px', 'aria-live': 'polite' });

  function draw() {
    const t = norm(memo.q).split(' ').filter(Boolean);
    const rows = all.filter((r) => {
      if (memo.grade && String(r.grade) !== memo.grade) return false;
      if (memo.classId && r.cls?.id !== memo.classId) return false;
      if (memo.status === 'studying' && !r.cls) return false;
      if (memo.status === 'noclass' && !(r.enr.status === 'studying' && !r.cls)) return false;
      if (memo.status === 'pending' && r.enr.status !== 'pending-graduation') return false;
      if (t.length) {
        const hay = norm(`${fullName(r.student)} ${r.cls ? r.cls.name : ''}`);
        if (!t.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const shown = rows.slice(0, LIMIT);
    count.textContent = rows.length > LIMIT ? `Показано ${LIMIT} из ${rows.length}. Уточните поиск или фильтры.` : `Найдено: ${rows.length}`;
    holder.replaceChildren(dataTable({
      caption: 'Список учеников',
      rows: shown,
      sortKey: 'name',
      empty: all.length ? 'Никого не найдено. Измените условия поиска.' : 'Учеников пока нет. Добавьте ученика или импортируйте список.',
      columns: [
        { key: 'name', label: 'ФИО', sortable: true, value: (r) => fullName(r.student), render: (r) => h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStudentCard(ctx, r.student); } }, fullName(r.student)), ' ', demoBadge(r.student)) },
        { key: 'cls', label: 'Класс', sortable: true, value: (r) => (r.cls ? r.grade * 10 + r.cls.letter.charCodeAt(0) / 100 : 999), render: (r) => (r.cls ? h('a', { href: `#/class/${encodeURIComponent(r.cls.id)}` }, r.cls.name) : h('span', { class: 'muted' }, '—')) },
        { key: 'birth', label: 'Дата рождения', sortable: true, value: (r) => r.student.birthDate || '', render: (r) => (r.student.birthDate ? formatDate(r.student.birthDate) : '—') },
        { key: 'status', label: 'Статус', render: (r) => studentStatusBadge(r.student, r.enr) },
        { key: 'act', label: 'Действия', actions: true, render: (r) => h('span', null,
          btn('Изменить', () => openStudentForm(ctx, { student: r.student }), 'sm'),
          btn('Перевести', () => openMoveStudent(ctx, r.student), 'sm'),
          btn('Удалить', () => openDeleteStudent(ctx, r.student), 'danger-outline sm')) },
      ],
    }));
  }
  draw();
  const filters = h('details', { class: 'filters-box', open: window.matchMedia('(min-width: 640px)').matches },
    h('summary', null, 'Фильтры'),
    h('div', { class: 'field-row' }, grade.el, klass.el, status.el));
  el.append(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('div', { class: 'grow' }, q)), filters, count, holder));
}
