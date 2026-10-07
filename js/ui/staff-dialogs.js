// Диалоги персонала: форма, назначение на класс, удаление / архивирование.
import { h } from './dom.js';
import { openModal } from './modal.js';
import { field, classOptions, radioCard } from './form.js';
import { toast } from './toast.js';
import { yearView } from '../domain/stats.js';
import { fullName, ROLE_LABEL } from '../domain/people.js';
import { nClasses } from '../domain/plural.js';

export function openStaffForm(ctx, { role = 'teacher', staff = null } = {}) {
  const r = staff ? staff.role : role;
  const view = yearView(ctx.state, ctx.state.settings.currentYearId);
  const f = {
    lastName: field({ label: 'Фамилия', name: 'lastName', value: staff?.lastName || '', required: true }),
    firstName: field({ label: 'Имя', name: 'firstName', value: staff?.firstName || '', required: true }),
    middleName: field({ label: 'Отчество', name: 'middleName', value: staff?.middleName || '' }),
    phone: field({ label: 'Телефон', name: 'phone', type: 'tel', value: staff?.phone || '' }),
    email: field({ label: 'Email', name: 'email', type: 'email', value: staff?.email || '' }),
    subject: field({ label: r === 'teacher' ? 'Предмет' : 'Смена / примечание', name: 'subject', value: staff?.subject || '' }),
    classId: field({ label: 'Назначить на класс', name: 'classId', value: '', options: classOptions(view, { empty: '— не назначать —' }), hint: 'Если у класса уже есть назначенный сотрудник, он будет заменён.' }),
    notes: field({ label: 'Примечание', name: 'notes', type: 'textarea', value: staff?.notes || '' }),
  };
  const body = h('div', null, h('div', { class: 'field-row' }, f.lastName.el, f.firstName.el), f.middleName.el, h('div', { class: 'field-row' }, f.phone.el, f.email.el), f.subject.el, staff ? null : f.classId.el, f.notes.el);
  openModal({
    title: `${staff ? 'Редактирование' : 'Новый сотрудник'}: ${ROLE_LABEL[r].toLowerCase()}`,
    body,
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      { label: staff ? 'Сохранить' : 'Добавить', kind: 'primary', run: async () => {
        const data = { role: r, lastName: f.lastName.get(), firstName: f.firstName.get(), middleName: f.middleName.get(), phone: f.phone.get(), email: f.email.get(), subject: f.subject.get(), notes: f.notes.get(), classId: f.classId.get() };
        if (staff) await ctx.repo.updateStaff(staff.id, data);
        else await ctx.repo.addStaff(data);
        toast(staff ? 'Изменения сохранены' : 'Сотрудник добавлен');
      } },
    ],
  });
}

export function openAssign(ctx, staff) {
  const view = yearView(ctx.state, ctx.state.settings.currentYearId);
  const key = staff.role === 'teacher' ? 'teacher' : 'tutor';
  const options = view.classes.map((c) => ({ value: c.id, label: `${c.name} — ${c[key] ? `сейчас: ${fullName(c[key])}` : 'свободно'}` }));
  const sel = field({ label: 'Класс', name: 'cls', value: options[0]?.value || '', options });
  openModal({
    title: `Назначить: ${fullName(staff)}`,
    body: h('div', null, h('p', { class: 'muted' }, `${ROLE_LABEL[staff.role]}. Если у выбранного класса уже есть ${ROLE_LABEL[staff.role].toLowerCase()}, он будет заменён.`), sel.el),
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      { label: 'Назначить', kind: 'primary', run: async () => {
        const prev = await ctx.repo.assign(sel.get(), staff.role, staff.id);
        toast(prev ? `Назначено. ${fullName(prev)} снят(а) с этого класса` : 'Назначено');
      } },
    ],
  });
}

// Удаление: предупреждение о текущих классах; в архив — по умолчанию.
export function openDeleteStaff(ctx, staff) {
  const info = ctx.repo.staffInfo(staff.id);
  const names = info.current.map((c) => c.name);
  const archiveR = radioCard({ name: 'mode', value: 'archive', checked: true, title: 'Переместить в архив', text: 'Рекомендуется. Сотрудник снимается с классов текущего года, но остаётся в истории прошлых лет.' });
  const deleteR = radioCard({ name: 'mode', value: 'delete', title: 'Удалить навсегда', text: info.hasPast ? 'Недоступно: сотрудник упоминается в истории прошлых лет.' : 'Запись будет стёрта безвозвратно.' });
  if (info.hasPast) deleteR.input.disabled = true;
  openModal({
    title: 'Удаление сотрудника',
    danger: true,
    body: h(
      'div',
      null,
      h('p', null, h('strong', null, fullName(staff)), ` — ${ROLE_LABEL[staff.role].toLowerCase()}`),
      names.length
        ? h('div', { class: 'notice warn' }, `Сейчас назначен на ${nClasses(names.length)}: `, h('strong', null, names.join(', ')), '. После удаления эти классы останутся без ', staff.role === 'teacher' ? 'классного руководителя.' : 'воспитателя.')
        : h('p', { class: 'muted' }, 'Сейчас ни на один класс не назначен.'),
      archiveR.el,
      deleteR.el,
    ),
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      { label: 'Подтвердить', kind: 'danger', run: async () => {
        if (deleteR.input.checked) {
          await ctx.repo.deleteStaff(staff.id);
          toast('Сотрудник удалён');
        } else {
          await ctx.repo.archiveStaff(staff.id);
          toast('Сотрудник перемещён в архив');
        }
      } },
    ],
  });
}
