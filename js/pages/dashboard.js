// Главная: «что сейчас происходит в лицее» — что требует внимания, ключевые числа, вечерний обход, данные и посетители, последние изменения.
import { h } from '../ui/dom.js';
import { pageHead, btn, link, emptyState, badge } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { toast, toastError } from '../ui/toast.js';
import { confirmAction } from '../ui/modal.js';
import { yearView, staffCounts } from '../domain/stats.js';
import { nStudents, nClasses } from '../domain/plural.js';
import { roundView } from '../domain/rounds.js';
import { recentChanges } from '../domain/activity.js';
import { todayISO, formatDateTime } from '../domain/dates.js';
import { describeSync } from '../services/sync.js';
import { describeLive } from '../services/live.js';
import { listRequests } from '../services/access.js';
import { loadDemo } from '../services/demo.js';

export const title = 'Главная';

// Показатель — ссылка на свой раздел: подпись сверху, число, пояснение. «Знаменатель» (15 из 15) приглушён; флажок у подписи — чего-то не хватает.
const stat = (href, label, value, sub, { of = null, flag = false } = {}) => h('a', { class: 'stat', href },
  h('div', { class: 'label' }, flag ? h('span', { class: 'flag', title: 'Есть что назначить' }) : null, label),
  h('div', { class: 'value' }, String(value), of == null ? null : h('span', { class: 'of' }, `/${of}`)),
  sub ? h('div', { class: 'sub' }, sub) : null);
const section = (title, body, action = null) => h('section', { class: 'dash-sec' }, h('div', { class: 'card-head' }, h('h2', null, title), action), body);
const secLink = (label, href) => h('a', { class: 'sec-link', href }, label, icon('chevron-right', 14));
const pad = (n) => String(n).padStart(2, '0');
// Короткое время для ленты: сегодня — часы и минуты, раньше — число и месяц.
function shortWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`;
}
const longDate = () => new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '').replace(/^./, (c) => c.toUpperCase());

export function render(ctx) {
  const { state: s, repo, view: el, access } = ctx;
  const yid = s.settings.currentYearId;
  const v = yearView(s, yid);
  const sc = staffCounts(s);
  const archived = s.students.filter((x) => x.status !== 'active').length;
  const round = roundView(s, todayISO());
  let alive = true;

  el.append(pageHead({
    title: 'Главная',
    sub: `${longDate()} · ${s.settings.lyceumName}`,
    actions: [link('Вечерний обход', '#/rounds', 'primary', { icon: 'moon' })],
  }));

  if (!v.total && !v.unassigned.length) {
    el.append(h('div', { class: 'panel', style: 'margin-bottom:18px' }, emptyState('База учеников пуста', 'Импортируйте список из CSV или JSON, добавьте учеников вручную или загрузите демонстрационные данные, чтобы посмотреть, как всё работает.', [
      link('Загрузить данные лицея (зашифрованные)', '#/import?source=repo', 'primary'),
      link('Импортировать из файла', '#/import'),
      link('Добавить в классе', '#/classes'),
      btn('Загрузить DEMO-данные', async () => { try { const r = await loadDemo(repo); toast(`Загружено DEMO: ${nStudents(r.students)}, сотрудников: ${r.staff}`); } catch (e) { toastError(e); } }),
    ], 'users')));
  }

  // ---- Требует внимания ----
  const items = [];
  const attn = (kind, text, action) => items.push(h('li', { class: kind }, icon(kind === 'info' ? 'info' : 'alert', 16), h('span', { class: 'grow' }, text), action));
  if (repo.hasDemo()) {
    attn('warn', 'В базе есть демонстрационные данные (DEMO) — они нужны только для проверки работы сайта.', btn('Удалить DEMO-данные', async () => {
      if (!(await confirmAction({ title: 'Удалить DEMO-данные', message: 'Будут удалены все ученики и сотрудники с пометкой DEMO. Ваши собственные данные не пострадают. Перед удалением будет создана резервная копия.', confirmLabel: 'Удалить DEMO' }))) return;
      try { await repo.deleteDemo(); toast('DEMO-данные удалены'); } catch (e) { toastError(e); }
    }, 'sm'));
  }
  if (v.pending.length) {
    attn('warn', `${nStudents(v.pending.length)} ожидают оформления выпуска.`, btn('Оформить выпуск', async () => {
      if (!(await confirmAction({ title: 'Оформить выпуск', message: `${nStudents(v.pending.length)} будут перемещены в архив как выпускники.`, confirmLabel: 'Оформить выпуск', kind: 'primary' }))) return;
      try { toast(`Выпуск оформлен: ${await repo.finalizeGraduation()}`); } catch (e) { toastError(e); }
    }, 'sm'));
  }
  if (v.unassigned.length) attn('info', `${nStudents(v.unassigned.length)} без класса.`, link('Показать', '#/students?status=noclass', 'sm'));
  if (v.total > 0 && (v.classesWithoutTeacher.length || v.classesWithoutTutor.length)) {
    attn('info', `Без классного руководителя: ${v.classesWithoutTeacher.length}, без воспитателя: ${v.classesWithoutTutor.length} из ${nClasses(v.classCount)}.`, link('Назначить', '#/staff', 'sm'));
  }
  if (v.total > 0 && round.totals.marked < round.totals.total && new Date().getHours() >= 19) {
    attn('info', `Вечерний обход не завершён: не отмечено ${round.totals.total - round.totals.marked} из ${round.totals.total}.`, link('Продолжить', '#/rounds', 'sm'));
  }
  const live = ctx.live;
  const sync = live ? describeLive(live.status) : describeSync(s.settings);
  if (sync.kind === 'error') attn('danger', sync.text, link('Настройки', '#/settings', 'sm'));
  const attnHolder = h('div');
  const paintAttention = (extra = []) => {
    const all = [...extra, ...items];
    attnHolder.replaceChildren(all.length
      ? h('div', { class: 'attention-box' }, h('div', { class: 'attention-head' }, 'Требует внимания', h('span', { class: 'n' }, String(all.length))), h('ul', { class: 'attention', 'aria-label': 'Требует внимания' }, all))
      : v.total ? h('div', { class: 'attention-ok' }, icon('check', 16), 'Замечаний нет: данные в порядке, обход и назначения заполнены.') : null);
  };
  paintAttention();
  el.append(attnHolder);

  // ---- Ключевые числа ----
  el.append(h('div', { class: 'kpis' },
    stat('#/students', 'Ученики', v.total, `${nClasses(v.classCount)} · ${v.grades.length} параллелей`),
    stat('#/staff', 'Классные руководители', v.teachersAssigned, `в штате: ${sc.teachers}`, { of: v.classCount, flag: v.classesWithoutTeacher.length > 0 }),
    stat('#/staff', 'Воспитатели', v.tutorsAssigned, `в штате: ${sc.tutors}`, { of: v.classCount, flag: v.classesWithoutTutor.length > 0 }),
    stat('#/rounds', 'Обход сегодня', round.totals.total ? round.totals.marked : '—', round.totals.total ? `классов готово: ${round.doneClasses} из ${round.groups.length}` : 'нет учеников', { of: round.totals.total || null }),
    stat('#/archive', 'В архиве', archived, 'выпускники и выбывшие'),
  ));

  // ---- Левая колонка: обход и параллели ----
  const t = round.totals;
  const pct = t.total ? Math.round((t.marked / t.total) * 100) : 0;
  const cell = (cls, label, n) => h('div', { class: `rm-cell ${cls}` }, h('b', null, String(n)), h('span', null, label));
  const roundBox = h('div', { class: 'round-meter' },
    h('div', { class: 'rm-top' }, h('span', null, 'Отмечено ', h('b', null, `${t.marked} из ${t.total}`)), h('span', null, `${pct}%`)),
    h('div', { class: 'round-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': t.total, 'aria-valuenow': t.marked, 'aria-label': 'Отмечено на вечернем обходе' }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'rm-grid' },
      cell('rm-sleeping', 'Ночует', t.byPlace.sleeping),
      cell('rm-sick', 'Болеет', t.byPlace.sick),
      cell('rm-home', 'С дома', t.byPlace.home),
      cell('rm-none', 'Не отмечено', t.total - t.marked)));
  const max = Math.max(1, ...v.grades.map((g) => g.count));
  const grades = h('table', { class: 'mini-table' },
    h('thead', null, h('tr', null, h('th', null, 'Параллель'), h('th', { class: 'num' }, 'Классов'), h('th', { class: 'num' }, 'Учеников'), h('th', { class: 'bar-cell', 'aria-hidden': 'true' }))),
    h('tbody', null, v.grades.map((g) => h('tr', null,
      h('td', null, h('strong', null, `${g.grade} классы`)),
      h('td', { class: 'num' }, String(g.classCount)),
      h('td', { class: 'num' }, String(g.count)),
      h('td', { class: 'bar-cell' }, h('div', { class: 'bar', role: 'presentation' }, h('span', { style: `width:${(g.count / max) * 100}%` })))))));

  // ---- Правая колонка: данные, посетители, изменения ----
  const lastBackup = s.settings.lastExportAt || s.settings.lastBackupAt;
  const facts = h('dl', { class: 'facts' },
    h('dt', null, 'Синхронизация'), h('dd', null, badge(sync.text.replace(/^Общая база: /, ''), `plain ${sync.kind === 'ok' ? 'ok' : sync.kind === 'error' ? 'danger' : sync.kind === 'warn' ? 'warn' : ''}`.trim())),
    h('dt', null, 'Обновлено'), h('dd', null, live && live.status.lastOkAt ? formatDateTime(new Date(live.status.lastOkAt).toISOString()) : s.settings.lastSyncAt ? formatDateTime(s.settings.lastSyncAt) : '—'),
    h('dt', null, 'Резервная копия'), h('dd', null, lastBackup ? formatDateTime(lastBackup) : 'не создавалась'),
    h('dt', null, 'Хранилище'), h('dd', null, ctx.store.db.kind === 'indexeddb' ? 'этот браузер + общая база' : 'только память'));
  if (live && live.status.pending) facts.append(h('dt', null, 'Ждёт отправки'), h('dd', null, `${live.status.pending}`));

  const visitors = h('div', { class: 'muted' }, 'Загрузка…');
  if (access.endpoint && access.owner) {
    listRequests(access.endpoint, s.settings.sheetsToken).then(({ requests }) => {
      if (!alive) return;
      const by = (st) => requests.filter((r) => r.status === st);
      const pending = by('pending');
      access.pending = pending.length;
      access.onPending?.(pending.length);
      visitors.className = '';
      visitors.replaceChildren(h('dl', { class: 'facts' },
        h('dt', null, 'Ожидают решения'), h('dd', null, pending.length ? h('a', { href: '#/access' }, String(pending.length)) : '0'),
        h('dt', null, 'Допущено'), h('dd', null, String(by('allowed').length)),
        h('dt', null, 'Отклонено / отозвано'), h('dd', null, String(by('denied').length + by('revoked').length))));
      if (pending.length) paintAttention([h('li', { class: 'info' }, icon('user-plus', 16), h('span', { class: 'grow' }, `Запросов на доступ: ${pending.length}`), link('Решить', '#/access', 'sm'))]);
    }).catch(() => { if (alive) { visitors.className = 'muted'; visitors.textContent = 'Нет связи с сервером допуска'; } });
  }

  const changes = recentChanges(s, 7);
  const activity = changes.length
    ? h('ul', { class: 'activity' }, changes.map((c) => h('li', null,
      h('span', { class: 'what' }, h('span', { class: 'kind' }, c.title), c.detail ? [': ', c.detail] : null),
      h('span', { class: 'when', title: formatDateTime(c.at) }, shortWhen(c.at)))))
    : h('p', { class: 'muted' }, 'Изменений пока нет.');

  el.append(h('div', { class: 'dash' },
    h('div', { class: 'dash-panel' },
      section('Вечерний обход · сегодня', roundBox, secLink('Открыть', '#/rounds')),
      section('Параллели', v.grades.length ? grades : h('p', { class: 'muted' }, 'Классов пока нет.'), secLink('Все классы', '#/classes'))),
    h('div', { class: 'dash-panel dash-side' },
      section('Данные', facts, secLink('Настройки', '#/settings?section=data')),
      access.endpoint && access.owner ? section('Посетители', visitors, secLink('Доступ', '#/access')) : null,
      section('Последние изменения', activity))));

  return () => { alive = false; };
}
