import { h } from '../ui/dom.js';
import { pageHead, btn, classLink, personName, notice } from '../ui/common.js';
import { openModal } from '../ui/modal.js';
import { field } from '../ui/form.js';
import { toast } from '../ui/toast.js';
import { yearView } from '../domain/stats.js';
import { allClassSlots, className } from '../domain/classes.js';
import { nStudents, nClasses } from '../domain/plural.js';
import { yearLabel } from '../domain/years.js';

export const title = 'Классы';

export function render(ctx) {
  const { state: s, repo, view: el } = ctx;
  const yid = s.settings.currentYearId;
  const v = yearView(s, yid);
  const existing = new Set(v.classes.map((c) => c.name));
  const missing = allClassSlots(s.settings).filter((x) => !existing.has(className(x.grade, x.letter)));

  el.append(pageHead({
    title: 'Классы',
    sub: `Учебный год ${yearLabel(yid)} · ${nClasses(v.classCount)} · ${nStudents(v.total)}`,
    actions: [btn('Добавить класс', () => openAddClass(ctx, missing), 'primary', { disabled: !missing.length, title: missing.length ? '' : 'Все классы уже созданы' })],
  }));
  if (v.unassigned.length) el.append(notice('info', `${nStudents(v.unassigned.length)} без класса. `, h('a', { href: '#/students?status=noclass' }, 'Показать')));

  const groups = h('div', { class: 'class-groups' });
  for (const g of v.grades) {
    const list = v.classes.filter((c) => c.grade === g.grade);
    groups.append(h('section', { 'aria-labelledby': `g${g.grade}` },
      h('div', { class: 'group-title' }, h('h2', { id: `g${g.grade}` }, `${g.grade} класс`), h('span', { class: 'muted' }, `${nClasses(g.classCount)} · ${nStudents(g.count)}`)),
      h('div', { class: 'class-cards' }, list.map((c) => h('a', { class: 'class-card', href: `#/class/${encodeURIComponent(c.id)}`, 'data-class': c.name },
        h('div', { class: 'title' }, c.name),
        h('div', { class: 'count' }, nStudents(c.count)),
        h('dl', null, h('dt', null, 'Классный руководитель'), h('dd', null, personName(c.teacher)), h('dt', null, 'Воспитатель'), h('dd', null, personName(c.tutor))),
      ))),
    ));
  }
  el.append(groups);
  void classLink;
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
