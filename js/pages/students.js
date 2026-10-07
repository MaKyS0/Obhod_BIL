import { h } from '../ui/dom.js';
import { pageHead, btn, studentStatusBadge, demoBadge, link } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dataTable } from '../ui/table.js';
import { field, classOptions } from '../ui/form.js';
import { openStudentForm, openMoveStudent, openDeleteStudent, openStudentCard } from '../ui/student-dialogs.js';
import { yearView } from '../domain/stats.js';
import { fullName, norm } from '../domain/people.js';
import { formatDate } from '../domain/dates.js';
import { nStudents } from '../domain/plural.js';
import { yearLabel } from '../domain/years.js';

export const title = 'Ученики';
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
    actions: [btn('Добавить ученика', () => openStudentForm(ctx), 'primary', { icon: 'plus' }), link('Импорт списком', '#/import', '', { icon: 'upload' })],
  }));

  const q = h('input', { type: 'search', value: memo.q, placeholder: 'Поиск по ФИО', 'aria-label': 'Поиск по ФИО', oninput: () => { memo.q = q.value; draw(); } });
  const grade = field({ label: 'Параллель', name: 'grade', value: memo.grade, options: [{ value: '', label: 'Все параллели' }, ...v.grades.map((g) => ({ value: String(g.grade), label: `${g.grade} классы` }))] });
  const klass = field({ label: 'Класс', name: 'klass', value: memo.classId, options: classOptions(v, { empty: 'Все классы' }) });
  const status = field({ label: 'Статус', name: 'status', value: memo.status, options: [{ value: '', label: 'Все' }, { value: 'studying', label: 'Учатся (в классе)' }, { value: 'noclass', label: 'Без класса' }, { value: 'pending', label: 'Ожидают выпуска' }] });
  for (const [f, k] of [[grade, 'grade'], [klass, 'classId'], [status, 'status']]) f.input.addEventListener('change', () => { memo[k] = f.get(); draw(); });
  const holder = h('div');
  const count = h('span', { class: 'count', 'aria-live': 'polite' });

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
    count.textContent = `Найдено: ${rows.length}`;
    holder.replaceChildren(dataTable({
      caption: 'Список учеников',
      rows,
      sortKey: 'name',
      pageSize: 50,
      resetKey: `${memo.q}|${memo.grade}|${memo.classId}|${memo.status}`,
      selectable: { id: (r) => r.student.id, actions: [
        { key: 'move', label: 'Перевести…', icon: 'move', run: (chosen, done) => bulkMove(ctx, chosen.map((x) => x.student), done) },
        { key: 'leave', label: 'Отчислить в архив', icon: 'archive', kind: 'danger-outline', run: (chosen, done) => bulkLeave(ctx, chosen.map((x) => x.student), done) },
      ] },
      empty: all.length ? 'Никого не найдено. Измените условия поиска.' : 'Учеников пока нет. Добавьте ученика или импортируйте список.',
      columns: [
        { key: 'name', label: 'ФИО', sortable: true, value: (r) => fullName(r.student), render: (r) => h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStudentCard(ctx, r.student); } }, fullName(r.student)), ' ', demoBadge(r.student)) },
        { key: 'cls', label: 'Класс', sortable: true, value: (r) => (r.cls ? r.grade * 10 + r.cls.letter.charCodeAt(0) / 100 : 999), render: (r) => (r.cls ? h('a', { href: `#/class/${encodeURIComponent(r.cls.id)}` }, r.cls.name) : h('span', { class: 'muted' }, '—')) },
        { key: 'birth', label: 'Дата рождения', sortable: true, value: (r) => r.student.birthDate || '', render: (r) => (r.student.birthDate ? formatDate(r.student.birthDate) : '—') },
        { key: 'status', label: 'Статус', render: (r) => studentStatusBadge(r.student, r.enr) },
        { key: 'act', label: 'Действия', actions: true, render: (r) => h('span', null,
          btn('Изменить', () => openStudentForm(ctx, { student: r.student }), 'sm', { icon: 'edit' }),
          btn('Перевести', () => openMoveStudent(ctx, r.student), 'sm', { icon: 'move' }),
          btn('Удалить', () => openDeleteStudent(ctx, r.student), 'danger-outline sm', { icon: 'trash' })) },
      ],
    }));
  }
  draw();
  const filters = h('details', { class: 'filters-box', open: window.matchMedia('(min-width: 640px)').matches },
    h('summary', null, 'Фильтры'),
    h('div', { class: 'field-row' }, grade.el, klass.el, status.el));
  el.append(h('div', { class: 'card flush' },
    h('div', { class: 'table-tools' }, h('div', { class: 'grow search-box' }, icon('search', 16), q), count),
    h('div', { style: 'padding:10px 14px 0;border-bottom:1px solid var(--border)' }, filters),
    holder));
}

// Массовые действия над выбранными учениками: одно подтверждение, затем по очереди (каждая правка — обычная операция сайта).
function bulkMove(ctx, students, done) {
  const v = yearView(ctx.state, ctx.state.settings.currentYearId);
  const sel = field({ label: 'Новый класс', name: 'bulkTo', options: classOptions(v, { empty: '— без класса —' }) });
  openModal({
    title: `Перевести: ${nStudents(students.length)}`,
    body: h('div', null, h('p', { class: 'muted' }, 'Выбранные ученики будут переведены в указанный класс текущего учебного года. История переводов сохранится.'), sel.el),
    actions: [{ label: 'Отмена', kind: 'secondary' }, { label: 'Перевести', kind: 'primary', run: async () => {
      let n = 0;
      for (const st of students) { await ctx.repo.moveStudent(st.id, sel.get() || null); n++; }
      toast(`Переведено: ${nStudents(n)}`);
      done();
    } }],
  });
}

async function bulkLeave(ctx, students, done) {
  const ok = await confirmAction({ title: 'Отчислить в архив', message: `Выбрано: ${nStudents(students.length)}. Они будут перемещены в архив (данные не удаляются, их можно вернуть).`, confirmLabel: 'Отчислить в архив' });
  if (!ok) return;
  try {
    for (const st of students) await ctx.repo.removeStudent(st.id, 'left');
    toast(`В архив: ${nStudents(students.length)}`);
    done();
  } catch (e) { toastError(e); }
}
