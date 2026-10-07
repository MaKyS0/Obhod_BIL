import { h } from '../ui/dom.js';
import { pageHead, btn, badge, demoBadge } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { field, classOptions } from '../ui/form.js';
import { openModal, confirmAction } from '../ui/modal.js';
import { openStudentCard } from '../ui/student-dialogs.js';
import { toast, toastError } from '../ui/toast.js';
import { yearView, studentHistory } from '../domain/stats.js';
import { fullName, norm } from '../domain/people.js';
import { formatDate } from '../domain/dates.js';
import { yearLabel } from '../domain/years.js';
import { nStudents } from '../domain/plural.js';

export const title = 'Архив';
const memo = { tab: 'graduated', q: '' };

export function render(ctx) {
  const { state: s, repo, view: el } = ctx;
  const list = s.students.filter((x) => x.status !== 'active');
  const grads = list.filter((x) => x.status === 'graduated');
  const left = list.filter((x) => x.status === 'left');
  el.append(pageHead({ title: 'Архив', sub: `Выпускники и выбывшие ученики · данные не удаляются · всего ${nStudents(list.length)}` }));
  el.append(h('div', { class: 'tabs', role: 'tablist' },
    [['graduated', `Выпускники (${grads.length})`], ['left', `Выбывшие (${left.length})`]].map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(memo.tab === k), onclick: () => { memo.tab = k; ctx.refresh(); } }, l))));

  const rowsAll = memo.tab === 'graduated' ? grads : left;
  const q = h('input', { type: 'search', value: memo.q, placeholder: 'Поиск по ФИО', 'aria-label': 'Поиск по ФИО', oninput: () => { memo.q = q.value; draw(); } });
  const holder = h('div');
  const lastClass = (st) => {
    const hist = studentHistory(s, st.id).filter((x) => x.cls);
    return hist.length ? hist[hist.length - 1].cls.name : '';
  };
  function draw() {
    const t = norm(memo.q).split(' ').filter(Boolean);
    const rows = rowsAll.filter((x) => !t.length || t.every((w) => norm(fullName(x)).includes(w)));
    holder.replaceChildren(dataTable({
      caption: 'Архив учеников', rows, sortKey: 'name', empty: 'В архиве пока никого нет',
      columns: [
        { key: 'name', label: 'ФИО', sortable: true, value: (r) => fullName(r), render: (r) => h('span', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openStudentCard(ctx, r); } }, fullName(r)), ' ', demoBadge(r)) },
        { key: 'cls', label: 'Последний класс', render: (r) => lastClass(r) || '—' },
        { key: 'when', label: memo.tab === 'graduated' ? 'Год выпуска' : 'Выбыл', sortable: true, value: (r) => (memo.tab === 'graduated' ? r.graduatedYearId || '' : r.leftDate || ''), render: (r) => (memo.tab === 'graduated' ? yearLabel(r.graduatedYearId) : `${formatDate(r.leftDate)}${r.leftReason ? ` — ${r.leftReason}` : ''}`) },
        { key: 'st', label: 'Статус', render: (r) => badge(r.status === 'graduated' ? 'Выпускник' : 'Выбыл', r.status === 'graduated' ? 'info' : 'warn') },
        { key: 'act', label: 'Действия', actions: true, render: (r) => h('span', null,
          btn('Вернуть в класс', () => openRestore(ctx, r), 'sm'),
          btn('Удалить навсегда', async () => {
            const ok = await confirmAction({ title: 'Удалить навсегда', message: `Запись «${fullName(r)}» и вся её история будут стёрты безвозвратно.`, details: ['Это действие нельзя отменить.', 'Перед удалением резервная копия не создаётся автоматически — скачайте её в «Настройках», если сомневаетесь.'], confirmLabel: 'Удалить навсегда', typeToConfirm: 'УДАЛИТЬ' });
            if (!ok) return;
            try { await repo.removeStudent(r.id, 'delete'); toast('Запись удалена'); } catch (e) { toastError(e); }
          }, 'danger-outline sm')) },
      ],
    }));
  }
  draw();
  el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, memo.tab === 'graduated' ? 'Выпускники' : 'Выбывшие ученики'), h('div', { class: 'toolbar', style: 'margin:0' }, q)), holder));
}

function openRestore(ctx, st) {
  const v = yearView(ctx.state, ctx.state.settings.currentYearId);
  const sel = field({ label: 'Класс в текущем учебном году', name: 'to', options: classOptions(v, { empty: '— без класса —' }) });
  openModal({
    title: `Вернуть в список: ${fullName(st)}`,
    body: h('div', null, h('p', { class: 'muted' }, 'Ученик снова станет действующим и появится в выбранном классе текущего учебного года.'), sel.el),
    actions: [{ label: 'Отмена', kind: 'secondary' }, { label: 'Вернуть', kind: 'primary', run: async () => { await ctx.repo.restoreStudent(st.id, sel.get() || null); toast('Ученик возвращён'); } }],
  });
}
