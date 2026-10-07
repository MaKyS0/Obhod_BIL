import { h } from '../ui/dom.js';
import { pageHead, btn, link, notice, classLink, personName, emptyState, yl } from '../ui/common.js';
import { barChart } from '../ui/charts.js';
import { toast, toastError } from '../ui/toast.js';
import { confirmAction } from '../ui/modal.js';
import { yearView, staffCounts } from '../domain/stats.js';
import { nStudents, nClasses } from '../domain/plural.js';
import { loadDemo } from '../services/demo.js';

export const title = 'Главная';

export function render(ctx) {
  const { state: s, repo, view: el } = ctx;
  const yid = s.settings.currentYearId;
  const v = yearView(s, yid);
  const sc = staffCounts(s);
  const archived = s.students.filter((x) => x.status !== 'active').length;
  const charts = [];

  el.append(pageHead({
    title: 'Главная',
    sub: `${s.settings.lyceumName} · учебный год ${yl(yid)}`,
    actions: [link('Начать новый учебный год', '#/new-year', 'primary')],
  }));

  const alerts = [];
  if (repo.hasDemo()) {
    alerts.push(h('div', { class: 'banner warn' }, h('div', null, h('strong', null, 'В базе есть демонстрационные данные (DEMO). '), 'Они нужны только для проверки работы сайта.'), btn('Удалить DEMO-данные', async () => {
      if (!(await confirmAction({ title: 'Удалить DEMO-данные', message: 'Будут удалены все ученики и сотрудники с пометкой DEMO. Ваши собственные данные не пострадают. Перед удалением будет создана резервная копия.', confirmLabel: 'Удалить DEMO' }))) return;
      try { await repo.deleteDemo(); toast('DEMO-данные удалены'); } catch (e) { toastError(e); }
    }, 'sm')));
  }
  if (v.pending.length) {
    alerts.push(h('div', { class: 'banner warn' }, h('div', null, `${nStudents(v.pending.length)} ожидают оформления выпуска.`), btn('Оформить выпуск', async () => {
      if (!(await confirmAction({ title: 'Оформить выпуск', message: `${nStudents(v.pending.length)} будут перемещены в архив как выпускники.`, confirmLabel: 'Оформить выпуск', kind: 'primary' }))) return;
      try { toast(`Выпуск оформлен: ${await repo.finalizeGraduation()}`); } catch (e) { toastError(e); }
    }, 'sm')));
  }
  if (v.unassigned.length) alerts.push(h('div', { class: 'banner info' }, h('div', null, `${nStudents(v.unassigned.length)} без класса.`), link('Показать', '#/students?status=noclass', 'sm')));
  if (v.total > 0 && (v.classesWithoutTeacher.length || v.classesWithoutTutor.length)) {
    alerts.push(h('div', { class: 'banner info' }, h('div', null, `Без классного руководителя: ${v.classesWithoutTeacher.length}, без воспитателя: ${v.classesWithoutTutor.length} из ${nClasses(v.classCount)}.`), link('Назначить', '#/staff', 'sm')));
  }
  alerts.forEach((a) => el.append(a));

  if (!v.total && !v.unassigned.length) {
    el.append(h('div', { class: 'card', style: 'margin-top:16px' }, emptyState('База учеников пуста', 'Импортируйте список из CSV или JSON, добавьте учеников вручную или загрузите демонстрационные данные, чтобы посмотреть, как всё работает.', [
      link('Загрузить данные лицея (зашифрованные)', '#/import?source=repo', 'primary'),
      link('Импортировать из файла', '#/import'),
      link('Добавить в классе', '#/classes'),
      btn('Загрузить DEMO-данные', async () => { try { const r = await loadDemo(repo); toast(`Загружено DEMO: ${nStudents(r.students)}, сотрудников: ${r.staff}`); } catch (e) { toastError(e); } }),
    ])));
  }

  el.append(h('div', { class: 'stats', style: 'margin-top:16px' },
    stat(v.total, 'Учеников', yl(yid)),
    stat(v.classCount, 'Классов', `${v.grades.length} параллелей`),
    stat(sc.teachers, 'Классных руководителей', `назначено на классы: ${v.teachersAssigned}`),
    stat(sc.tutors, 'Воспитателей', `назначено на классы: ${v.tutorsAssigned}`),
    stat(archived, 'В архиве', 'выпускники и выбывшие'),
  ));

  const max = Math.max(1, ...v.grades.map((g) => g.count));
  el.append(h('div', { class: 'card' }, h('h2', null, 'Параллели'),
    v.grades.map((g) => h('div', { class: 'grade-line' },
      h('div', { class: 'name' }, `${g.grade} классы`),
      h('div', { class: 'bar', role: 'presentation' }, h('span', { style: `width:${(g.count / max) * 100}%` })),
      h('div', { class: 'meta' }, `${nClasses(g.classCount)} · ${nStudents(g.count)}`),
    )),
  ));

  const byGrade = barChart({ labels: v.grades.map((g) => `${g.grade} классы`), data: v.grades.map((g) => g.count), title: 'Учеников по параллелям' });
  const byClass = barChart({ labels: v.classes.map((c) => c.name), data: v.classes.map((c) => c.count), title: 'Учеников по классам', horizontal: true, tall: true });
  charts.push(byGrade, byClass);
  el.append(h('div', { class: 'grid-2', style: 'margin-top:16px' },
    h('div', { class: 'card' }, h('h2', null, 'Учеников по параллелям'), byGrade.el),
    h('div', { class: 'card' }, h('h2', null, 'Учеников по классам'), byClass.el),
  ));

  el.append(h('div', { class: 'card flush', style: 'margin-top:16px' },
    h('div', { class: 'card-head' }, h('h2', null, 'Классы'), link('Все классы', '#/classes', 'sm')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data responsive' },
      h('thead', null, h('tr', null, h('th', null, 'Класс'), h('th', { class: 'num' }, 'Учеников'), h('th', null, 'Классный руководитель'), h('th', null, 'Воспитатель'))),
      h('tbody', null, v.classes.map((c) => h('tr', null,
        h('td', { 'data-label': 'Класс' }, classLink(c.cls)),
        h('td', { class: 'num', 'data-label': 'Учеников' }, c.count),
        h('td', { 'data-label': 'Классный руководитель' }, personName(c.teacher)),
        h('td', { 'data-label': 'Воспитатель' }, personName(c.tutor)),
      ))),
    )),
  ));
  return () => charts.forEach((c) => c.destroy());
}

function stat(value, label, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label), sub ? h('div', { class: 'sub' }, sub) : null);
}
