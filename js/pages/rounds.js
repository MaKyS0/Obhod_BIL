// Вечерний обход: по каждому ученику — где он вечером (болеет / с дома / ночует). Класс, где отмечены все, становится зелёным.
// Рассчитано на телефон: крупные кнопки, классы-«гармошки», отметка одним касанием.
import { h } from '../ui/dom.js';
import { pageHead, btn, emptyState } from '../ui/common.js';
import { toastError } from '../ui/toast.js';
import { roundView, ROUND_PLACES, ROUND_LABEL, ROUND_REASONS, REASON_MAX, earliestRoundDate } from '../domain/rounds.js';
import { openModal } from '../ui/modal.js';
import { field } from '../ui/form.js';
import { fullName } from '../domain/people.js';
import { todayISO, formatDate } from '../domain/dates.js';
import { nStudents } from '../domain/plural.js';

export const title = 'Вечерний обход';

// Состояние экрана живёт между перерисовками (чужая правка перерисовывает страницу): открытые классы, дата, фильтр.
const ui = { open: new Set(), date: null, onlyOpen: false };

export function render(ctx) {
  const { repo, view: el } = ctx;
  const today = todayISO();
  const min = earliestRoundDate(today);
  if (!ui.date || ui.date < min || ui.date > today) ui.date = today;

  const head = pageHead({ title: 'Вечерний обход', sub: '…' });
  const sub = head.querySelector('.sub');
  const summary = h('div', { class: 'card round-summary' });
  const list = h('div', { class: 'round-list' });
  const controls = h('div', { class: 'card round-controls' });
  el.append(head, controls, summary, list);

  const dateInput = h('input', { type: 'date', value: ui.date, min, max: today, 'aria-label': 'Дата обхода', onchange: () => { ui.date = dateInput.value >= min && dateInput.value <= today ? dateInput.value : today; draw(); } });
  const onlyToggle = h('input', { type: 'checkbox', checked: ui.onlyOpen, onchange: () => { ui.onlyOpen = onlyToggle.checked; draw(); } });

  controls.append(
    h('label', { class: 'round-date' }, h('span', null, 'Дата'), dateInput),
    h('label', { class: 'check round-only' }, onlyToggle, h('span', null, 'Только неотмеченные')));

  async function mark(studentIds, place) {
    try {
      await repo.setRounds(studentIds, ui.date, place);
    } catch (e) {
      toastError(e);
    }
  }

  function draw() {
    const v = roundView(ctx.state, ui.date);
    const { totals } = v;
    sub.textContent = `${ui.date === today ? 'Сегодня' : formatDate(ui.date)} · отмечено ${totals.marked} из ${totals.total} · готово классов: ${v.doneClasses} из ${v.groups.length}`;

    const pct = totals.total ? Math.round((totals.marked / totals.total) * 100) : 0;
    summary.replaceChildren(
      h('div', { class: 'round-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': totals.total, 'aria-valuenow': totals.marked, 'aria-label': 'Отмечено учеников' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'round-counts' },
        ...ROUND_PLACES.map((p) => h('span', { class: `rc rc-${p.key}` }, `${p.label}: `, h('b', null, String(totals.byPlace[p.key])))),
        h('span', { class: 'rc rc-none' }, 'Не отмечено: ', h('b', { id: 'roundUnmarked' }, String(totals.total - totals.marked)))),
    );

    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rk : null;
    const groups = ui.onlyOpen ? v.groups.filter((g) => !g.done) : v.groups;
    if (!v.groups.length) {
      list.replaceChildren(h('div', { class: 'card' }, emptyState('Нет учеников', 'Сначала добавьте или импортируйте учеников — они появятся здесь по классам.')));
      return;
    }
    if (!groups.length) {
      list.replaceChildren(h('div', { class: 'card round-alldone' }, h('h2', null, 'Обход завершён'), h('p', null, 'Во всех классах отмечены все ученики.')));
      return;
    }
    list.replaceChildren(...groups.map((g) => classSection(g)));
    if (focusKey) {
      const again = list.querySelector(`[data-rk="${CSS.escape(focusKey)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function classSection(g) {
    const opened = ui.open.has(g.id);
    const head = h('button', { type: 'button', class: 'round-head', 'aria-expanded': opened ? 'true' : 'false', 'data-class': g.id, onclick: () => { if (ui.open.has(g.id)) ui.open.delete(g.id); else ui.open.add(g.id); draw(); } },
      h('span', { class: 'round-class-name' }, g.name),
      h('span', { class: 'round-class-count' }, g.done ? `готово · ${nStudents(g.total)}` : `${g.marked} из ${g.total}`),
      h('span', { class: 'round-chevron', 'aria-hidden': 'true' }, opened ? '▴' : '▾'));
    const sec = h('section', { class: 'round-class', 'data-done': g.done ? 'true' : 'false', 'data-class': g.id }, head);
    if (!opened) return sec;

    const rest = g.students.filter((x) => !x.place).map((x) => x.student.id);
    const body = h('div', { class: 'round-body' });
    if (rest.length > 1) {
      body.append(h('div', { class: 'round-bulk' }, btn(`Всем неотмеченным (${rest.length}): Ночует`, () => bulk(g, rest), 'sm', { 'data-bulk': g.id })));
    }
    for (const { student, place, reason } of g.students) {
      body.append(h('div', { class: 'round-row', 'data-place': place || '', 'data-student': student.id },
        h('span', { class: 'round-name' }, fullName(student)),
        h('div', { class: 'round-btns', role: 'group', 'aria-label': `Где ${fullName(student)}` },
          ...ROUND_PLACES.map((p) => h('button', {
            type: 'button', class: `rp rp-${p.key}`, 'aria-pressed': place === p.key ? 'true' : 'false', 'data-rk': `${student.id}:${p.key}`,
            onclick: () => tap(g, student.id, place === p.key ? null : p.key),
          }, p.label))),
        place ? h('button', { type: 'button', class: `round-reason${reason ? ' has' : ''}`, 'data-reason-for': student.id, onclick: () => askReason(student, place, reason) }, reason ? [h('span', { class: 'rr-label' }, 'Причина: '), reason] : '＋ Причина') : null));
    }
    sec.append(body);
    return sec;
  }

  // Причина к отметке: одно касание по готовой причине или своя строка.
  function askReason(student, place, current) {
    const save = async (text, ctxm) => {
      try {
        await repo.setRoundReason(student.id, ui.date, text);
        ctxm.close(true);
        draw();
      } catch (e) {
        toastError(e);
      }
    };
    const custom = field({ label: 'Другая причина', name: 'roundReason', value: current || '', attrs: { maxlength: REASON_MAX }, placeholder: 'Например: был у врача' });
    let mctx = null;
    const presets = ROUND_REASONS[place] || [];
    const body = h('div', null,
      h('p', { class: 'muted' }, `${fullName(student)} — ${ROUND_LABEL[place].toLowerCase()}`),
      presets.length ? h('div', { class: 'reason-chips', role: 'group', 'aria-label': 'Готовые причины' }, presets.map((t) => h('button', { type: 'button', class: `reason-chip${t === current ? ' on' : ''}`, onclick: () => save(t, mctx) }, t))) : null,
      custom.el);
    mctx = openModal({
      title: 'Причина',
      body,
      actions: [
        { label: 'Сохранить', kind: 'primary', run: async () => { await repo.setRoundReason(student.id, ui.date, custom.get()); draw(); } },
        ...(current ? [{ label: 'Убрать причину', kind: 'danger-outline', run: async () => { await repo.setRoundReason(student.id, ui.date, ''); draw(); } }] : []),
        { label: 'Отмена', kind: 'secondary' },
      ],
    });
  }

  // Отметка → запись → перерисовка. Когда класс стал «готов», он сворачивается: следующий класс — сразу под ним.
  async function tap(g, studentId, place) {
    const wasDone = g.done;
    await mark([studentId], place);
    const now = roundView(ctx.state, ui.date).groups.find((x) => x.id === g.id);
    if (now && now.done && !wasDone) ui.open.delete(g.id);
    draw();
  }

  async function bulk(g, ids) {
    await mark(ids, 'sleeping');
    const now = roundView(ctx.state, ui.date).groups.find((x) => x.id === g.id);
    if (now && now.done) ui.open.delete(g.id);
    draw();
  }

  draw();
}
