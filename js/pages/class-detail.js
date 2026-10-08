import { h } from '../ui/dom.js';
import { pageHead, btn, link, notice, studentStatusBadge, demoBadge } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { field } from '../ui/form.js';
import { confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { openStudentForm, openMoveStudent, openDeleteStudent, openStudentCard } from '../ui/student-dialogs.js';
import { yearView } from '../domain/stats.js';
import { getIndex } from '../domain/state.js';
import { fullName, norm, ROLE_LABEL } from '../domain/people.js';
import { formatDate } from '../domain/dates.js';
import { nStudents } from '../domain/plural.js';
import { yearLabel } from '../domain/years.js';
import { cmp } from '../domain/collate.js';

export const title = 'Класс';

export function render(ctx) {
  const { state: s, repo, view: el, params } = ctx;
  const cls = getIndex(s).classes.get(params.id);
  if (!cls) {
    el.append(notice('danger', 'Класс не найден. ', h('a', { href: '#/classes' }, 'К списку классов')));
    return;
  }
  if (cls.yearId !== s.settings.currentYearId) {
    el.append(notice('warn', `Этот класс относится к прошлому учебному году (${yearLabel(cls.yearId)}). `, h('a', { href: `#/history/${cls.yearId}` }, 'Открыть в разделе «История»')));
    return;
  }
  const v = yearView(s, s.settings.currentYearId);
  const c = v.classes.find((x) => x.id === cls.id) || { students: [], count: 0, teacher: null, tutor: null, cls };

  el.append(pageHead({
    crumbs: [h('a', { href: '#/classes' }, 'Классы'), ` / ${cls.name}`],
    title: `Класс ${cls.name}`,
    sub: `Учебный год ${yearLabel(cls.yearId)} · ${nStudents(c.count)}`,
    actions: [btn('Добавить ученика', () => openStudentForm(ctx, { classId: cls.id }), 'primary'), btn('Печать списка', () => window.print())],
  }));
  el.append(h('div', { class: 'print-only' }, h('h2', null, `${s.settings.lyceumName} — класс ${cls.name}, ${yearLabel(cls.yearId)}`), h('p', null, `Классный руководитель: ${c.teacher ? fullName(c.teacher) : '—'}. Воспитатель: ${c.tutor ? fullName(c.tutor) : '—'}.`)));

  // Руководство класса
  const staffSelect = (role) => {
    const list = s.staff.filter((x) => x.role === role && !x.archived).sort((a, b) => cmp(fullName(a), fullName(b)));
    const cur = role === 'teacher' ? c.teacher : c.tutor;
    const f = field({ label: ROLE_LABEL[role], name: role, value: cur ? cur.id : '', options: [{ value: '', label: '— не назначен —' }, ...list.map((x) => ({ value: x.id, label: fullName(x) }))] });
    f.input.addEventListener('change', async () => {
      try {
        if (f.get()) await repo.assign(cls.id, role, f.get());
        else await repo.unassign(cls.id, role);
        toast(f.get() ? 'Назначение сохранено' : 'Назначение снято');
      } catch (e) {
        toastError(e);
      }
    });
    return f.el;
  };
  const room = field({ label: 'Кабинет', name: 'room', value: cls.room || '', hint: 'Показывается в обходе рядом с классом, например 230', attrs: { maxlength: 20 } });
  const notes = field({ label: 'Дополнительные данные', name: 'notes', type: 'textarea', value: cls.notes, hint: 'Например: профиль, особенности класса' });
  el.append(h('div', { class: 'grid-2 no-print' },
    h('div', { class: 'card panel' }, h('h2', null, 'Руководство класса'), staffSelect('teacher'), staffSelect('tutor'), s.staff.length ? null : h('p', { class: 'muted' }, 'Сначала добавьте сотрудников в разделе «Персонал».'), h('a', { href: '#/staff' }, 'Перейти в раздел «Персонал»')),
    h('div', { class: 'card panel' }, h('h2', null, 'О классе'),
      h('dl', { class: 'kv', style: 'margin-bottom:12px' }, h('dt', null, 'Учебный год'), h('dd', null, yearLabel(cls.yearId)), h('dt', null, 'Учеников'), h('dd', null, String(c.count))),
      room.el, notes.el,
      h('div', { class: 'row' }, btn('Сохранить', async () => { try { await repo.updateClass(cls.id, { notes: notes.get(), room: room.get() }); toast('Сохранено'); } catch (e) { toastError(e); } }, 'sm'),
        btn('Архивировать класс', async () => {
          const ok = await confirmAction({ title: 'Архивировать класс', message: c.count ? `В классе ${cls.name} есть ученики (${c.count}). Сначала переведите их в другие классы.` : `Класс ${cls.name} будет скрыт из списков текущего года (данные истории сохранятся). Назначенные руководители будут сняты.`, confirmLabel: 'Архивировать', kind: c.count ? 'primary' : 'danger' });
          if (!ok || c.count) return;
          try { await repo.archiveClass(cls.id); toast('Класс архивирован'); location.hash = '#/classes'; } catch (e) { toastError(e); }
        }, 'danger-outline sm')),
    ),
  ));

  // Список учеников
  const q = h('input', { type: 'search', placeholder: 'Поиск в классе', 'aria-label': 'Поиск в классе', oninput: draw });
  const holder = h('div');
  function draw() {
    const t = norm(q.value);
    const rows = c.students.filter((x) => !t || t.split(' ').every((w) => norm(fullName(x.student)).includes(w)));
    holder.replaceChildren(dataTable({
      caption: `Ученики класса ${cls.name}`,
      rows,
      sortKey: 'name',
      empty: c.students.length ? 'Никого не найдено' : 'В классе пока нет учеников',
      columns: [
        { key: 'n', label: '№', num: true, render: (r) => String(rows.indexOf(r) + 1) },
        { key: 'name', label: 'ФИО', sortable: true, value: (r) => fullName(r.student), render: (r) => h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStudentCard(ctx, r.student); } }, fullName(r.student)), ' ', demoBadge(r.student)) },
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
  el.append(h('div', { class: 'card flush', style: 'margin-top:16px' }, h('div', { class: 'card-head no-print' }, h('h2', null, `Ученики (${c.count})`), h('div', { class: 'toolbar', style: 'margin:0' }, q)), holder));
  void link;
}
