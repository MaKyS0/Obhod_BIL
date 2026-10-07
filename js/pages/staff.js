import { h } from '../ui/dom.js';
import { pageHead, btn, demoBadge, badge } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { confirmAction } from '../ui/modal.js';
import { dataTable } from '../ui/table.js';
import { field } from '../ui/form.js';
import { toast, toastError } from '../ui/toast.js';
import { openStaffForm, openAssign, openDeleteStaff } from '../ui/staff-dialogs.js';
import { yearView } from '../domain/stats.js';
import { getIndex } from '../domain/state.js';
import { fullName, norm, ROLE_LABEL, ROLE_LABEL_PLURAL } from '../domain/people.js';
import { cmp } from '../domain/collate.js';
import { yearLabel } from '../domain/years.js';

export const title = 'Персонал';
const memo = { role: 'teacher', q: '', archived: false };

export function render(ctx) {
  const { state: s, repo, view: el, query } = ctx;
  if (query.role === 'teacher' || query.role === 'tutor') memo.role = query.role;
  const role = memo.role;
  const yid = s.settings.currentYearId;
  const v = yearView(s, yid);
  const idx = getIndex(s);

  el.append(pageHead({
    title: 'Персонал',
    sub: `Классные руководители и воспитатели · учебный год ${yearLabel(yid)}`,
    actions: [btn(role === 'teacher' ? 'Добавить классного руководителя' : 'Добавить воспитателя', () => openStaffForm(ctx, { role }), 'primary', { icon: 'plus' })],
  }));

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ['teacher', 'tutor'].map((r) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(r === role), onclick: () => { memo.role = r; ctx.refresh(); } },
    `${ROLE_LABEL_PLURAL[r]} (${s.staff.filter((x) => x.role === r && !x.archived).length})`)));
  el.append(tabs);

  // Назначения по классам
  const key = role === 'teacher' ? 'teacher' : 'tutor';
  const staffList = s.staff.filter((x) => x.role === role && !x.archived).sort((a, b) => cmp(fullName(a), fullName(b)));
  const grid = h('div', { class: 'assign-grid' });
  for (const c of v.classes) {
    const f = field({ label: `Класс ${c.name}`, name: `a-${c.name}`, value: c[key] ? c[key].id : '', options: [{ value: '', label: '— не назначен —' }, ...staffList.map((x) => ({ value: x.id, label: fullName(x) }))] });
    f.el.style.margin = '0';
    const label = f.el.querySelector('label');
    label.className = 'sr-only';
    f.input.addEventListener('change', async () => {
      try {
        if (f.get()) await repo.assign(c.id, role, f.get());
        else await repo.unassign(c.id, role);
        toast(f.get() ? 'Назначено' : 'Назначение снято');
      } catch (e) { toastError(e); }
    });
    grid.append(h('div', { class: 'an' }, c.name), f.el);
  }
  const assignCard = h('div', { class: 'card' }, h('h2', null, `Назначения: ${ROLE_LABEL[role].toLowerCase()}`), h('p', { class: 'muted' }, `Один ${ROLE_LABEL[role].toLowerCase()} на класс. Выбор в списке сохраняется сразу.`), grid);

  // Список сотрудников
  const q = h('input', { type: 'search', value: memo.q, placeholder: 'Поиск по ФИО', 'aria-label': 'Поиск по ФИО', oninput: () => { memo.q = q.value; draw(); } });
  const arch = h('input', { type: 'checkbox', checked: memo.archived, onchange: () => { memo.archived = arch.checked; draw(); } });
  const holder = h('div');
  const assigns = idx.assignmentsByYear.get(yid) || [];
  function draw() {
    const t = norm(memo.q).split(' ').filter(Boolean);
    const rows = s.staff.filter((x) => x.role === role && (memo.archived || !x.archived) && (!t.length || t.every((w) => norm(fullName(x)).includes(w))));
    holder.replaceChildren(dataTable({
      caption: ROLE_LABEL_PLURAL[role],
      rows,
      sortKey: 'name',
      resetKey: `${role}|${memo.q}|${memo.archived}`,
      selectable: { id: (r) => r.id, actions: [{ key: 'archive', label: 'В архив', icon: 'archive', kind: 'danger-outline', run: async (chosen, done) => {
        const live = chosen.filter((x) => !x.archived);
        if (!live.length) return toast('Выбранные сотрудники уже в архиве', 'error');
        if (!(await confirmAction({ title: 'Отправить в архив', message: `Сотрудников: ${live.length}. С них будут сняты назначения на классы; запись можно вернуть из архива.`, confirmLabel: 'В архив' }))) return;
        try { for (const x of live) await repo.archiveStaff(x.id); toast(`В архив: ${live.length}`); done(); } catch (e) { toastError(e); }
      } }] },
      empty: 'Сотрудников не найдено',
      columns: [
        { key: 'name', label: 'ФИО', sortable: true, value: (r) => fullName(r), render: (r) => h('span', null, fullName(r), ' ', demoBadge(r), r.archived ? badge('Архив', 'warn') : null) },
        { key: 'contacts', label: 'Контакты', render: (r) => [r.phone, r.email].filter(Boolean).join(' · ') || '—' },
        { key: 'classes', label: 'Классы', render: (r) => {
          const mine = assigns.filter((a) => a.staffId === r.id).map((a) => idx.classes.get(a.classId)).filter(Boolean).sort((a, b) => a.grade - b.grade || cmp(a.letter, b.letter));
          return mine.length ? h('div', { class: 'chips' }, mine.map((c) => h('span', { class: 'chip' }, h('a', { href: `#/class/${encodeURIComponent(c.id)}` }, c.name), h('button', { type: 'button', 'aria-label': `Снять назначение с класса ${c.name}`, title: 'Снять назначение', onclick: async () => { try { await repo.unassign(c.id, r.role); toast('Назначение снято'); } catch (e) { toastError(e); } } }, icon('x', 12))))) : h('span', { class: 'muted' }, 'не назначен');
        } },
        { key: 'act', label: 'Действия', actions: true, render: (r) => r.archived
          ? btn('Вернуть из архива', async () => { try { await repo.restoreStaff(r.id); toast('Сотрудник возвращён'); } catch (e) { toastError(e); } }, 'sm')
          : h('span', null, btn('Назначить', () => openAssign(ctx, r), 'sm', { icon: 'user-plus' }), btn('Изменить', () => openStaffForm(ctx, { staff: r }), 'sm', { icon: 'edit' }), btn('Удалить', () => openDeleteStaff(ctx, r), 'danger-outline sm', { icon: 'trash' })) },
      ],
    }));
  }
  draw();
  el.append(h('div', { class: 'card flush' },
    h('div', { class: 'table-tools' }, h('div', { class: 'grow search-box' }, icon('search', 16), q), h('label', { class: 'check', style: 'margin:0' }, arch, h('span', null, 'Показать архивных'))),
    holder));
  el.append(h('div', { style: 'margin-top:26px' }, assignCard));
}
