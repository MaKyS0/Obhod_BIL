import { h } from '../ui/dom.js';
import { pageHead, btn, notice, badge } from '../ui/common.js';
import { openModal, confirmAction } from '../ui/modal.js';
import { field, radioCard, checkbox } from '../ui/form.js';
import { toast, toastError } from '../ui/toast.js';
import { saveBackupFile } from '../services/backup-file.js';
import { syncNow } from '../services/sync.js';
import { yearView } from '../domain/stats.js';
import { canUndo } from '../domain/promotion.js';
import { fullName } from '../domain/people.js';
import { nextYearId, yearLabel } from '../domain/years.js';
import { nStudents } from '../domain/plural.js';
import { formatDateTime } from '../domain/dates.js';

export const title = 'Новый учебный год';

export function render(ctx) {
  const { state: s, repo, view: el } = ctx;
  const cur = s.settings.currentYearId;
  const next = nextYearId(cur);
  const v = yearView(s, cur);

  el.append(pageHead({ title: 'Новый учебный год', sub: 'Ежегодный перевод учеников в следующие классы с сохранением истории' }));

  el.append(h('div', { class: 'card big-action' },
    h('p', null, 'Текущий учебный год: ', h('strong', null, yearLabel(cur)), '. Новый учебный год: ', h('strong', null, yearLabel(next)), '.'),
    h('p', { class: 'muted' }, 'Перед переходом вы увидите предварительный отчёт и сможете создать резервную копию. Старый год сохранится в разделе «История», последний переход можно отменить.'),
    h('button', { type: 'button', class: 'btn btn-primary btn-lg', id: 'startYearBtn', onclick: () => openWizard(ctx) }, 'Начать новый учебный год'),
  ));

  if (v.pending.length) {
    el.append(notice('warn', `${nStudents(v.pending.length)} ожидают оформления выпуска (вы выбрали «оставить в текущем году» при прошлом переходе). `, btn('Оформить выпуск', async () => {
      if (!(await confirmAction({ title: 'Оформить выпуск', message: `${nStudents(v.pending.length)} будут перемещены в архив как выпускники.`, confirmLabel: 'Оформить выпуск', kind: 'primary' }))) return;
      try { toast(`Выпуск оформлен: ${await repo.finalizeGraduation()}`); } catch (e) { toastError(e); }
    }, 'sm')));
  }

  // Отмена последнего перехода
  if (canUndo(s)) {
    const p = s.promotions.find((x) => x.id === s.settings.lastPromotionId);
    el.append(h('div', { class: 'card' }, h('h2', null, 'Отменить последний переход'),
      h('p', null, `Последний переход: ${yearLabel(p.fromYearId)} → ${yearLabel(p.toYearId)}, выполнен ${formatDateTime(p.executedAt)}.`),
      s.settings.changesSincePromotion ? notice('warn', `После перехода внесено изменений: ${s.settings.changesSincePromotion}. При отмене данные, добавленные уже в новом году, будут потеряны.`) : null,
      btn('Отменить переход…', () => undo(ctx), 'danger-outline')));
  }

  // Журнал переходов
  if (s.promotions.length) {
    el.append(h('div', { class: 'card flush', style: 'margin-top:16px' }, h('div', { class: 'card-head' }, h('h2', null, 'Журнал переходов')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data responsive' },
        h('thead', null, h('tr', null, h('th', null, 'Дата'), h('th', null, 'Переход'), h('th', { class: 'num' }, 'Переведено'), h('th', { class: 'num' }, 'Выпуск'), h('th', null, 'Статус'))),
        h('tbody', null, s.promotions.slice().sort((a, b) => b.executedAt.localeCompare(a.executedAt)).map((p) => h('tr', null,
          h('td', { 'data-label': 'Дата' }, formatDateTime(p.executedAt)),
          h('td', { 'data-label': 'Переход' }, `${yearLabel(p.fromYearId)} → ${yearLabel(p.toYearId)}`),
          h('td', { class: 'num', 'data-label': 'Переведено' }, String(p.counts?.promoted ?? 0)),
          h('td', { class: 'num', 'data-label': 'Выпуск' }, String(p.counts?.graduates ?? 0)),
          h('td', { 'data-label': 'Статус' }, p.undone ? badge('Отменён', 'warn') : badge('Выполнен', 'ok')),
        ))),
      )),
    ));
  }
}

async function undo(ctx) {
  const plan = ctx.repo.previewUndo();
  if (!plan.ok) return toastError(new Error(plan.error));
  const details = [
    `Будет удалён учебный год ${yearLabel(plan.to)} со всеми его классами и назначениями.`,
    `Текущим снова станет ${yearLabel(plan.from)}; выпускники вернутся в 11 классы.`,
    'Перед отменой будет создана резервная копия.',
  ];
  if (plan.lostChanges) details.push(`Изменений после перехода: ${plan.lostChanges} — они будут потеряны.`);
  if (plan.deletedStudents) details.push(`Учеников, добавленных после перехода, будет удалено: ${plan.deletedStudents}.`);
  const ok = await confirmAction({ title: 'Отмена перехода', message: `Отменить переход ${yearLabel(plan.from)} → ${yearLabel(plan.to)}?`, details, confirmLabel: 'Отменить переход' });
  if (!ok) return;
  try {
    await ctx.repo.undoPromotion();
    toast(`Переход отменён. Текущий год: ${yearLabel(plan.from)}`);
  } catch (e) { toastError(e); }
}

function openWizard(ctx) {
  const { repo } = ctx;
  const cur = ctx.state.settings.currentYearId;
  const next = nextYearId(cur);
  const opts = { graduation: 'archive', staffMode: 'follow', holdBack: new Set() };
  let plan = null;
  const previewBox = h('div');
  const warnBox = h('div');
  const gradBox = h('div');

  const typed = field({ label: `Для подтверждения введите новый учебный год: ${yearLabel(next)}`, name: 'typed', placeholder: yearLabel(next) });
  const same = () => typed.get().trim().replace(/[-—/]/g, '–') === yearLabel(next);
  typed.input.addEventListener('input', () => refreshConfirm());

  const staffR = [
    radioCard({ name: 'staff', value: 'follow', checked: true, title: 'Руководители переходят вместе с классом', text: '7A → 8A: классный руководитель и воспитатель остаются у своих учеников. Выпускные классы остаются без руководителя.', onChange: () => { opts.staffMode = 'follow'; replan(); } }),
    radioCard({ name: 'staff', value: 'stay', title: 'Руководители остаются за своим классом', text: 'Руководитель 8A остаётся в 8A, но в новом году — с другими учениками.', onChange: () => { opts.staffMode = 'stay'; replan(); } }),
  ];
  const gradR = [
    radioCard({ name: 'grad', value: 'archive', checked: true, title: 'Архивировать выпуск', text: 'Ученики 11 классов получают статус «Выпускник» и перемещаются в архив. Данные не удаляются.', onChange: () => { opts.graduation = 'archive'; replan(); } }),
    radioCard({ name: 'grad', value: 'defer', title: 'Оставить в текущем году', text: 'Выпуск не оформляется: ученики останутся в списке без класса со статусом «Ожидает выпуска». Оформить выпуск можно позже.', onChange: () => { opts.graduation = 'defer'; replan(); } }),
  ];

  // Второй год
  const holdWrap = h('details', { class: 'no-print' }, h('summary', { style: 'cursor:pointer;font-weight:600' }, 'Оставить отдельных учеников на второй год'));
  const holdInfo = h('p', { class: 'muted' }, 'Не выбрано');
  const classPick = field({ label: 'Класс', name: 'holdClass', options: yearView(ctx.state, cur).classes.map((c) => ({ value: c.id, label: `${c.name} (${c.count})` })) });
  const holdList = h('div', { style: 'max-height:200px;overflow:auto' });
  function drawHold() {
    const c = yearView(ctx.state, cur).classes.find((x) => x.id === classPick.get());
    holdList.replaceChildren(...(c ? c.students.map((x) => {
      const cb = checkbox({ label: fullName(x.student), checked: opts.holdBack.has(x.student.id), onChange: () => { if (cb.get()) opts.holdBack.add(x.student.id); else opts.holdBack.delete(x.student.id); holdInfo.textContent = opts.holdBack.size ? `Остаются на второй год: ${opts.holdBack.size}` : 'Не выбрано'; replan(); } });
      return cb.el;
    }) : []));
  }
  classPick.input.addEventListener('change', drawHold);
  holdWrap.append(h('div', { style: 'padding-top:8px' }, classPick.el, holdList, holdInfo));
  drawHold();

  function replan() {
    plan = repo.previewPromotion({ graduation: opts.graduation, staffMode: opts.staffMode, holdBack: [...opts.holdBack] });
    drawPlan();
    refreshConfirm();
  }

  function drawPlan() {
    previewBox.replaceChildren();
    warnBox.replaceChildren();
    gradBox.replaceChildren();
    if (!plan.ok) {
      previewBox.append(notice('danger', plan.error));
      return;
    }
    previewBox.append(
      h('h3', { style: 'margin:8px 0' }, `Переход на учебный год ${yearLabel(plan.to)}`),
      h('ul', { class: 'preview-list', 'aria-label': 'Предварительный список переходов' }, plan.rows.map((r) => h('li', { class: `${r.count === 0 ? 'zero' : ''} ${r.kind !== 'promote' && r.count ? 'grad' : ''}`.trim() }, h('span', null, r.text)))),
      h('p', { class: 'muted', style: 'margin-top:8px' }, `Переводится: ${plan.totals.promoted}, выпуск: ${plan.totals.graduates + plan.totals.pending}, остаются на второй год: ${plan.totals.held}. Классы 7-й параллели нового набора создаются пустыми.`),
    );
    plan.warnings.forEach((w) => warnBox.append(notice('info', w))); // ожидаемые последствия, а не тревога: жёлтым остаётся только выпуск
    if (plan.hasGraduates) {
      gradBox.append(notice('warn', h('strong', null, 'Ученики 11 классов выпускаются.'), ' Переместить их в архив?'));
    }
  }

  function refreshConfirm() {
    const ok = plan && plan.ok && same();
    if (m) m.setDisabled(1, !ok);
  }

  const backupBox = h('div', { class: 'notice info' }, 'Резервная копия базы будет создана автоматически перед переходом (хранится в браузере, раздел «Настройки»). ',
    btn('Скачать копию в файл', async () => { await saveBackupFile(repo); toast('Резервная копия сохранена'); }, 'sm'));

  const body = h('div', null,
    h('dl', { class: 'kv', style: 'margin-bottom:12px' }, h('dt', null, 'Текущий учебный год'), h('dd', null, h('strong', null, yearLabel(cur))), h('dt', null, 'Новый учебный год'), h('dd', null, h('strong', null, yearLabel(next)))),
    previewBox, warnBox, gradBox,
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Выпуск 11 классов'), gradR.map((x) => x.el)),
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Руководители классов'), staffR.map((x) => x.el)),
    holdWrap, h('div', { style: 'margin-top:12px' }, backupBox), typed.el);

  const m = openModal({
    title: 'Начать новый учебный год',
    wide: true,
    body,
    actions: [
      { label: 'Отменить', kind: 'secondary' },
      { label: 'Подтвердить переход', kind: 'primary', disabled: true, run: async (mctx) => {
        if (!plan.ok || !same()) return false;
        let applied;
        try {
          applied = await repo.runPromotion(plan, { backup: true });
        } catch (e) {
          if (e.code === 'STALE') { mctx.close(null); ctx.refresh(); }
          throw e;
        }
        toast(`Выполнен переход на ${yearLabel(applied.to)} учебный год`);
        location.hash = '#/';
        const st = ctx.state.settings;
        if (st.sheetsUrl && st.autoSync) syncNow(ctx.store, repo, { reason: 'promotion' }).then((r) => (r.ok ? toast('Данные отправлены в Google Таблицы') : toast(`Google Таблицы: ${r.error}`, 'error')));
      } },
    ],
  });
  replan();
}
