// Диалоги работы с учениками: карточка, форма, перевод, удаление / отчисление.
import { h } from './dom.js';
import { openModal, confirmAction } from './modal.js';
import { field, classOptions, radioCard, checkbox } from './form.js';
import { toast } from './toast.js';
import { studentStatusBadge, demoBadge } from './common.js';
import { yearView, studentHistory, currentEnrollment } from '../domain/stats.js';
import { fullName } from '../domain/people.js';
import { formatDate, todayISO } from '../domain/dates.js';
import { yearLabel } from '../domain/years.js';
import { getIndex } from '../domain/state.js';

const currentView = (ctx) => yearView(ctx.state, ctx.state.settings.currentYearId);

export function openStudentForm(ctx, { student = null, classId = '' } = {}) {
  const view = currentView(ctx);
  const enr = student ? currentEnrollment(ctx.state, student.id, ctx.state.settings.currentYearId) : null;
  const f = {
    lastName: field({ label: 'Фамилия', name: 'lastName', value: student?.lastName || '', required: true }),
    firstName: field({ label: 'Имя', name: 'firstName', value: student?.firstName || '', required: true }),
    middleName: field({ label: 'Отчество', name: 'middleName', value: student?.middleName || '' }),
    birthDate: field({ label: 'Дата рождения', name: 'birthDate', type: 'date', value: student?.birthDate || '', attrs: { max: todayISO() }, hint: 'Необязательно' }),
    classId: field({ label: 'Класс', name: 'classId', value: enr ? enr.classId || '' : classId, options: classOptions(view, { empty: '— без класса —' }) }),
    notes: field({ label: 'Примечание', name: 'notes', type: 'textarea', value: student?.notes || '' }),
  };
  const canMove = !student || student.status === 'active';
  const body = h('div', null, h('div', { class: 'field-row' }, f.lastName.el, f.firstName.el), f.middleName.el, h('div', { class: 'field-row' }, f.birthDate.el, canMove ? f.classId.el : null), f.notes.el);
  const read = () => ({ lastName: f.lastName.get(), firstName: f.firstName.get(), middleName: f.middleName.get(), birthDate: f.birthDate.get(), notes: f.notes.get(), classId: f.classId.get() });
  const save = async (force = false) => {
    Object.values(f).forEach((x) => x.error(''));
    try {
      if (student) await ctx.repo.updateStudent(student.id, canMove ? read() : { ...read(), classId: undefined }, { force });
      else await ctx.repo.addStudent(read(), { force });
      toast(student ? 'Изменения сохранены' : 'Ученик добавлен');
      return true;
    } catch (e) {
      if (e.code === 'DUPLICATE') {
        const ok = await confirmAction({ title: 'Возможный дубликат', message: `${e.message}. Всё равно сохранить?`, confirmLabel: 'Сохранить', kind: 'primary' });
        if (ok) return save(true);
        return false;
      }
      if (e.code === 'USER') {
        const target = /Фамилию|фамилию/.test(e.message) ? f.lastName : /Дата|будущем/.test(e.message) ? f.birthDate : null;
        if (target) target.error(e.message);
      }
      throw e;
    }
  };
  openModal({
    title: student ? 'Редактирование ученика' : 'Новый ученик',
    body,
    actions: [{ label: 'Отмена', kind: 'secondary' }, { label: student ? 'Сохранить' : 'Добавить', kind: 'primary', run: async () => (await save()) && undefined }],
  });
}

export function openMoveStudent(ctx, student) {
  const view = currentView(ctx);
  const enr = currentEnrollment(ctx.state, student.id, ctx.state.settings.currentYearId);
  const sel = field({ label: 'Новый класс', name: 'to', value: enr?.classId || '', options: classOptions(view, { empty: '— без класса —' }) });
  openModal({
    title: `Перевод: ${fullName(student)}`,
    body: h('div', null, h('p', { class: 'muted' }, `Перевод внутри ${yearLabel(ctx.state.settings.currentYearId)} учебного года. Прежний класс сохранится в истории ученика.`), sel.el),
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      { label: 'Перевести', kind: 'primary', run: async () => {
        await ctx.repo.moveStudent(student.id, sel.get() || null);
        toast('Ученик переведён');
      } },
    ],
  });
}

// Удаление: по умолчанию отчисление в архив; удаление навсегда — только после явного подтверждения.
export function openDeleteStudent(ctx, student) {
  const enr = currentEnrollment(ctx.state, student.id, ctx.state.settings.currentYearId);
  const cls = enr?.classId ? getIndex(ctx.state).classes.get(enr.classId) : null;
  const archiveR = radioCard({ name: 'mode', value: 'left', checked: true, title: 'Отчислить (переместить в архив)', text: 'Рекомендуется. Ученик исчезнет из списков класса, но данные и история сохранятся — его можно вернуть из архива.', onChange: sync });
  const deleteR = radioCard({ name: 'mode', value: 'delete', title: 'Удалить навсегда', text: 'Запись и вся история классов будут стёрты безвозвратно. Подходит только для ошибочно добавленных учеников.', onChange: sync });
  const reason = field({ label: 'Причина (необязательно)', name: 'reason', hint: 'Например: переезд, перевод в другую школу' });
  const sure = checkbox({ label: 'Я понимаю, что удалённые данные восстановить нельзя' });
  const sureWrap = h('div', { hidden: true, class: 'notice danger' }, sure.el);
  function sync() {
    const del = deleteR.input.checked;
    sureWrap.hidden = !del;
    reason.el.hidden = del;
    m.buttons[1].textContent = del ? 'Удалить навсегда' : 'Отчислить в архив';
    m.buttons[1].className = `btn ${del ? 'btn-danger' : 'btn-primary'}`;
  }
  const m = openModal({
    title: 'Удаление ученика',
    danger: true,
    body: h('div', null, h('p', null, h('strong', null, fullName(student)), cls ? ` — класс ${cls.name}` : ''), archiveR.el, deleteR.el, reason.el, sureWrap),
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      { label: 'Отчислить в архив', kind: 'primary', run: async () => {
        if (deleteR.input.checked) {
          if (!sure.get()) {
            toast('Подтвердите, что понимаете последствия удаления', 'error');
            return false;
          }
          await ctx.repo.removeStudent(student.id, 'delete');
          toast('Ученик удалён навсегда');
        } else {
          await ctx.repo.removeStudent(student.id, 'left', reason.get());
          toast('Ученик перемещён в архив');
        }
      } },
    ],
  });
}

export function openStudentCard(ctx, student) {
  const s = ctx.state;
  const idx = getIndex(s);
  const enr = currentEnrollment(s, student.id, s.settings.currentYearId);
  const cls = enr?.classId ? idx.classes.get(enr.classId) : null;
  const hist = studentHistory(s, student.id);
  const body = h(
    'div',
    { class: 'stack' },
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'ФИО'), h('dd', null, fullName(student), ' ', demoBadge(student)),
      h('dt', null, 'Дата рождения'), h('dd', null, student.birthDate ? formatDate(student.birthDate) : '—'),
      h('dt', null, 'Статус'), h('dd', null, studentStatusBadge(student, enr)),
      h('dt', null, 'Класс сейчас'), h('dd', null, cls ? cls.name : '—'),
      student.status === 'graduated' ? [h('dt', null, 'Выпуск'), h('dd', null, yearLabel(student.graduatedYearId))] : null,
      student.status === 'left' ? [h('dt', null, 'Выбыл'), h('dd', null, `${formatDate(student.leftDate)}${student.leftReason ? ` — ${student.leftReason}` : ''}`)] : null,
      h('dt', null, 'Примечание'), h('dd', null, student.notes || '—'),
    ),
    h(
      'div',
      null,
      h('h3', { style: 'margin-bottom:6px' }, 'История классов'),
      hist.length
        ? h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, 'Учебный год'), h('th', null, 'Класс'), h('th', null, 'Статус'))), h('tbody', null, hist.map(({ enr: e, cls: c }) => h('tr', null, h('td', null, yearLabel(e.yearId)), h('td', null, c ? c.name : '—'), h('td', null, ({ studying: 'Учился', graduated: 'Окончил', left: 'Выбыл', 'pending-graduation': 'Ожидает выпуска' })[e.status] || e.status)))))
        : h('p', { class: 'muted' }, 'Записей нет'),
    ),
  );
  openModal({ title: 'Карточка ученика', body, actions: [], closeLabel: 'Закрыть' });
}
