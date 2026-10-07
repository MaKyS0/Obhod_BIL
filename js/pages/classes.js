import { h } from '../ui/dom.js';
import { pageHead, btn, link, notice, personName } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { dataTable } from '../ui/table.js';
import { openModal } from '../ui/modal.js';
import { field } from '../ui/form.js';
import { toast } from '../ui/toast.js';
import { yearView } from '../domain/stats.js';
import { allClassSlots, className } from '../domain/classes.js';
import { roundView } from '../domain/rounds.js';
import { fullName, norm } from '../domain/people.js';
import { todayISO } from '../domain/dates.js';
import { nStudents, nClasses } from '../domain/plural.js';
import { yearLabel } from '../domain/years.js';

export const title = 'Классы';
const memo = { grade: '', q: '', noStaff: false };

export function render(ctx) {
  const { state: s, view: el } = ctx;
  const yid = s.settings.currentYearId;
  const v = yearView(s, yid);
  const existing = new Set(v.classes.map((c) => c.name));
  const missing = allClassSlots(s.settings).filter((x) => !existing.has(className(x.grade, x.letter)));
  const round = new Map(roundView(s, todayISO()).groups.map((g) => [g.id, g]));

  el.append(pageHead({
    title: 'Классы',
    sub: `Учебный год ${yearLabel(yid)} · ${nClasses(v.classCount)} · ${nStudents(v.total)}`,
    actions: [btn('Добавить класс', () => openAddClass(ctx, missing), 'primary', { icon: 'plus', disabled: !missing.length, title: missing.length ? '' : 'Все классы уже созданы' })],
  }));
  if (v.unassigned.length) el.append(notice('info', `${nStudents(v.unassigned.length)} без класса. `, h('a', { href: '#/students?status=noclass' }, 'Показать')));

  const q = h('input', { type: 'search', value: memo.q, placeholder: 'Класс или ФИО руководителя', 'aria-label': 'Поиск по классам', oninput: () => { memo.q = q.value; draw(); } });
  const grade = h('select', { 'aria-label': 'Параллель', onchange: () => { memo.grade = grade.value; draw(); } },
    h('option', { value: '' }, 'Все параллели'), v.grades.map((g) => h('option', { value: String(g.grade), selected: String(g.grade) === memo.grade }, `${g.grade} классы`)));
  const noStaff = h('input', { type: 'checkbox', checked: memo.noStaff, onchange: () => { memo.noStaff = noStaff.checked; draw(); } });
  const holder = h('div');
  const count = h('span', { class: 'count', 'aria-live': 'polite' });

  function draw() {
    const t = norm(memo.q).split(' ').filter(Boolean);
    const rows = v.classes.filter((c) => {
      if (memo.grade && String(c.grade) !== memo.grade) return false;
      if (memo.noStaff && c.teacher && c.tutor) return false;
      if (t.length) {
        const hay = norm(`${c.name} ${c.teacher ? fullName(c.teacher) : ''} ${c.tutor ? fullName(c.tutor) : ''}`);
        if (!t.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    count.textContent = `Классов: ${rows.length}`;
    holder.replaceChildren(dataTable({
      caption: 'Классы текущего учебного года',
      rows,
      sortKey: 'name',
      resetKey: `${memo.q}|${memo.grade}|${memo.noStaff}`,
      empty: v.classes.length ? 'Классов по условиям не найдено.' : 'Классов пока нет. Добавьте класс.',
      columns: [
        { key: 'name', label: 'Класс', sortable: true, value: (c) => c.grade * 10 + c.letter.charCodeAt(0) / 100, render: (c) => h('a', { href: `#/class/${encodeURIComponent(c.id)}`, 'data-class': c.name }, h('strong', null, c.name)) },
        { key: 'count', label: 'Учеников', num: true, sortable: true, value: (c) => c.count },
        { key: 'teacher', label: 'Классный руководитель', sortable: true, value: (c) => (c.teacher ? fullName(c.teacher) : ''), render: (c) => personName(c.teacher) },
        { key: 'tutor', label: 'Воспитатель', sortable: true, value: (c) => (c.tutor ? fullName(c.tutor) : ''), render: (c) => personName(c.tutor) },
        { key: 'round', label: 'Обход сегодня', value: (c) => (round.get(c.id) ? round.get(c.id).marked / Math.max(1, round.get(c.id).total) : 0), sortable: true, render: (c) => {
          const g = round.get(c.id);
          if (!g) return h('span', { class: 'muted' }, '—');
          return h('span', { class: `badge ${g.done ? 'ok' : g.marked ? 'warn' : ''}`.trim() }, g.done ? 'Готов' : `${g.marked} из ${g.total}`);
        } },
        { key: 'act', label: 'Действия', actions: true, render: (c) => link('Открыть', `#/class/${encodeURIComponent(c.id)}`, 'sm', { icon: 'chevron-right' }) },
      ],
    }));
  }
  draw();
  el.append(h('div', { class: 'card flush' },
    h('div', { class: 'table-tools' },
      h('div', { class: 'grow search-box' }, icon('search', 16), q), grade,
      h('label', { class: 'check', style: 'margin:0' }, noStaff, h('span', null, 'Без руководителя или воспитателя')), count),
    holder));
}

function openAddClass(ctx, missing) {
  const sel = field({ label: 'Класс', name: 'slot', options: missing.map((m) => ({ value: `${m.grade}${m.letter}`, label: `${m.grade}${m.letter}` })) });
  openModal({
    title: 'Добавить класс',
    body: h('div', null, h('p', { class: 'muted' }, 'Класс будет создан в текущем учебном году. В списке — классы, которых сейчас нет (не созданы или в архиве).'), sel.el),
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      { label: 'Добавить', kind: 'primary', run: async () => {
        const v = sel.get();
        await ctx.repo.addClass(Number(v.slice(0, -1)), v.slice(-1));
        toast(`Класс ${v} добавлен`);
      } },
    ],
  });
}
