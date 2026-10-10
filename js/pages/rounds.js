// Обход: по каждому ученику — где он (болеет / с дома / нет / ночует). Вид проверки: вечер, утро, дополнительная.
// Рассчитано на телефон: крупные кнопки, классы-«гармошки», отметка одним касанием; время и имя отметившего видны у каждого.
import { h } from '../ui/dom.js';
import { pageHead, btn, link, emptyState, notice } from '../ui/common.js';
import { toast, toastError } from '../ui/toast.js';
import { roundView, copyPlan, shiftDate, ROUND_PLACES, ROUND_LABEL, ROUND_REASONS, ROUND_KINDS, REASON_MAX, earliestRoundDate, isHere } from '../domain/rounds.js';
import { dayInfo } from '../domain/calendar.js';
import { openModal, confirmAction } from '../ui/modal.js';
import { icon } from '../ui/icons.js';
import { field } from '../ui/form.js';
import { fullName, shortName } from '../domain/people.js';
import { todayISO, formatDate } from '../domain/dates.js';
import { nStudents } from '../domain/plural.js';
import { hm } from '../ui/round-ui.js';

export const title = 'Обход';

const KIND_TITLE = { evening: 'Вечерний обход', morning: 'Утренняя проверка', extra: 'Дополнительная проверка' };
const FILTERS = [{ key: 'all', label: 'Все' }, { key: 'open', label: 'Не отмечены' }, { key: 'away', label: 'Отсутствуют' }];
const SEARCH_LIMIT = 60;

// Состояние экрана живёт между перерисовками (чужая правка перерисовывает страницу): открытые классы, дата, вид, фильтр, поиск.
const ui = { open: new Set(), date: null, kind: 'evening', filter: 'all', q: '', fx: { done: null, open: null, tap: null }, prev: {} };

const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (c) => c.toUpperCase());
const clockText = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const matches = (x, f) => (f === 'open' ? !x.place : f === 'away' ? !!x.place && !isHere(x.place) : true);

export function render(ctx) {
  const { repo, view: el, access } = ctx;
  const myName = () => (access && access.name) || '';
  const today = todayISO();
  let min = earliestRoundDate(today, ui.kind);
  if (!ui.date || ui.date < min || ui.date > today) ui.date = today;

  const head = pageHead({ title: KIND_TITLE[ui.kind], sub: '\u00a0' });
  const sub = head.querySelector('.sub');
  const clock = h('time', { class: 'round-clock', id: 'roundClock' }, clockText());
  const bar = h('i');
  const progress = h('div', { class: 'round-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-label': 'Отмечено учеников' }, bar);
  const stats = h('div', { class: 'round-stats' });
  const notes = h('div', { class: 'round-notes' });
  // Для скринридера: одно понятное сообщение при каждом изменении счётчиков (а не россыпь голых чисел)
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-atomic': 'true', id: 'roundLive' });
  const list = h('div', { class: 'round-list' });

  const kinds = h('div', { class: 'seg', role: 'group', 'aria-label': 'Вид проверки' }, ROUND_KINDS.map((k) => h('button', {
    type: 'button', 'aria-pressed': ui.kind === k.key ? 'true' : 'false', 'data-kind': k.key,
    onclick: () => { if (ui.kind === k.key) return; ui.kind = k.key; ui.open.clear(); ctx.refresh(); },
  }, k.label)));
  const dateInput = h('input', { type: 'date', value: ui.date, min, max: today, 'aria-label': 'Дата обхода', onchange: () => { ui.date = dateInput.value >= min && dateInput.value <= today ? dateInput.value : today; ctx.refresh(); } });
  const search = h('input', { type: 'search', class: 'round-search', id: 'roundSearch', value: ui.q, placeholder: 'Найти ученика', 'aria-label': 'Найти ученика', enterkeyhint: 'search', autocomplete: 'off', oninput: () => { ui.q = search.value; draw(); } });
  const chips = h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': 'Показать' }, FILTERS.map((f) => h('button', {
    type: 'button', 'data-filter': f.key, 'aria-pressed': ui.filter === f.key ? 'true' : 'false',
    onclick: () => { ui.filter = f.key; for (const b of chips.children) b.setAttribute('aria-pressed', b.dataset.filter === f.key ? 'true' : 'false'); draw(); },
  }, f.label)));
  // Листание дней кнопками: на телефоне это быстрее, чем календарь браузера
  const stepBtn = (days, label, ic) => {
    const to = shiftDate(ui.date, days);
    return btn('', () => { ui.date = to; ctx.refresh(); }, 'ghost', { icon: ic, 'aria-label': label, title: label, disabled: to < min || to > today, 'data-step': String(days) });
  };
  const copyBtn = btn('Заполнить как вчера', () => copyFromPrev(), '', { icon: 'undo', id: 'copyPrevBtn' });
  el.append(head,
    h('div', { class: 'round-bar' }, kinds, clock),
    h('div', { class: 'round-datebar' }, stepBtn(-1, 'Предыдущий день', 'chevron-left'), h('label', { class: 'round-date' }, h('span', { class: 'sr-only' }, 'Дата'), dateInput), stepBtn(1, 'Следующий день', 'chevron-right')),
    notes, live, h('div', { class: 'round-sum' }, stats, progress),
    h('div', { class: 'round-find' }, h('div', { class: 'round-search-wrap' }, icon('search', 16), search), chips, copyBtn),
    list);

  const tick = setInterval(() => { clock.textContent = clockText(); }, 15000);

  async function mark(studentIds, place) {
    try {
      await repo.setRounds(studentIds, ui.date, place, { kind: ui.kind, by: myName() });
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  }

  function draw() {
    const v = roundView(ctx.state, ui.date, ui.kind);
    const info = dayInfo(ctx.state, ui.date);
    const { totals } = v;
    sub.textContent = `${longDate(ui.date)}${ui.date === today ? '' : ' · прошедший день'}`;

    live.textContent = `Отмечено ${totals.marked} из ${totals.total}. Осталось классов: ${v.classesLeft}. Нет на месте: ${totals.away}.`;
    notes.replaceChildren(
      h('div', { class: 'duty-line' }, h('span', { class: 'k' }, 'Дежурный:'), info.dutyLabel ? h('strong', null, info.dutyLabel) : h('span', { class: 'muted' }, 'не назначен')),
      ...(info.holiday ? [notice('info', info.note ? `В календаре отмечен выходной: ${info.note}. Обход можно проводить как обычно.` : 'В календаре этот день отмечен как выходной. Обход можно проводить как обычно.')] : []));

    const pct = totals.total ? Math.round((totals.marked / totals.total) * 100) : 0;
    bar.style.transform = `scaleX(${pct / 100})`;
    progress.setAttribute('aria-valuemax', String(totals.total));
    progress.setAttribute('aria-valuenow', String(totals.marked));
    const num = (key, value, id) => {
      const changed = key in ui.prev && ui.prev[key] !== value;
      ui.prev[key] = value;
      return h('b', { class: changed ? 'bump' : null, id }, String(value));
    };
    stats.replaceChildren(
      h('div', { class: 'rs-main' },
        h('span', null, 'Осталось классов: ', num('left', v.classesLeft, 'roundLeft'), ` из ${v.groups.length}`),
        h('span', null, 'Отмечено: ', num('marked', totals.marked, 'roundMarked'), ` из ${totals.total}`),
        h('span', { class: 'rs-away' }, 'Нет на месте: ', num('away', totals.away, 'roundAway'))),
      h('div', { class: 'rs-badges' },
        ...ROUND_PLACES.filter((p) => !isHere(p.key)).map((p) => h('span', { class: `rc rc-${p.key}` }, `${p.label}: `, num(p.key, totals.byPlace[p.key]))),
        h('span', { class: 'rc rc-sleeping' }, `${ROUND_LABEL.sleeping}: `, num('sleeping', totals.byPlace.sleeping)),
        h('span', { class: 'rc rc-none' }, 'Не отмечено: ', num('none', totals.total - totals.marked, 'roundUnmarked'))));

    // «Заполнить как вчера»: доступно, если за предыдущий день есть отметки для ещё неотмеченных учеников
    const prevDate = shiftDate(ui.date, -1);
    const plan = copyPlan(ctx.state, prevDate, ui.date, ui.kind);
    const label = ui.date === today ? 'вчера' : `за ${formatDate(prevDate).slice(0, 5)}`;
    copyBtn.querySelector('span').textContent = `Заполнить как ${label}`;
    copyBtn.disabled = !plan.length;
    copyBtn.title = plan.length ? `Неотмеченным (${plan.length}) поставить статус как ${label}` : `Нечего копировать: за ${formatDate(prevDate)} нет отметок для неотмеченных учеников`;

    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rk : null;
    if (!v.groups.length) {
      list.replaceChildren(h('div', { class: 'card' }, access && access.admin
        ? emptyState('База учеников пуста', 'Добавьте или импортируйте учеников — они появятся здесь по классам. Для знакомства с сайтом можно загрузить DEMO-данные в «Настройках».', [link('Импорт и экспорт', '#/import', 'primary'), link('Ученики', '#/students', ''), link('Настройки', '#/settings', '')])
        : emptyState('Список учеников пока пуст', 'Попросите администратора добавить учеников — они появятся здесь по классам.')));
      return;
    }
    const needle = ui.q.trim().toLowerCase();
    if (needle) {
      const found = v.groups.flatMap((g) => g.students.map((x) => ({ ...x, group: g }))).filter((x) => matches(x, ui.filter) && fullName(x.student).toLowerCase().includes(needle));
      if (!found.length) list.replaceChildren(h('p', { class: 'round-none' }, 'Никого не найдено. Проверьте написание или выберите «Все».'));
      else {
        const shown = found.slice(0, SEARCH_LIMIT);
        list.replaceChildren(h('div', { class: 'round-class found' }, h('div', { class: 'round-body' }, shown.map((x) => studentRow(x.group, x, true))), found.length > shown.length ? h('p', { class: 'round-none' }, `Показано ${shown.length} из ${found.length}. Уточните запрос.`) : null));
      }
      restoreFocus(focusKey);
      return;
    }
    const groups = v.groups.map((g) => ({ g, rows: g.students.filter((x) => matches(x, ui.filter)) })).filter(({ rows }) => rows.length);
    if (!groups.length) {
      list.replaceChildren(ui.filter === 'open'
        ? h('div', { class: 'card round-alldone' }, h('h2', null, 'Обход завершён'), h('p', null, 'Во всех классах отмечены все ученики.'))
        : h('p', { class: 'round-none' }, 'Сейчас никто не отмечен как отсутствующий.'));
      return;
    }
    list.replaceChildren(...groups.map(({ g, rows }) => classSection(g, rows)));
    ui.fx = { done: null, open: null, tap: null }; // разовые эффекты сыграли — дальше перерисовки идут без них
    restoreFocus(focusKey);
  }

  function restoreFocus(key) {
    if (!key) return;
    const again = list.querySelector(`[data-rk="${CSS.escape(key)}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  function classSection(g, rows) {
    const opened = ui.filter === 'away' || ui.open.has(g.id);
    const meta = [g.room ? `каб. ${g.room}` : '', g.tutor ? `воспитатель ${shortName(g.tutor)}` : '', g.teacher ? `кл. рук. ${shortName(g.teacher)}` : ''].filter(Boolean);
    const copyN = copyPlan(ctx.state, shiftDate(ui.date, -1), ui.date, ui.kind, g.id).length;
    const head = h('button', { type: 'button', class: 'round-head', 'aria-expanded': opened ? 'true' : 'false', 'data-class': g.id, onclick: () => { if (ui.open.has(g.id)) ui.open.delete(g.id); else { ui.open.add(g.id); ui.fx.open = g.id; } draw(); } },
      h('span', { class: 'round-class-name' }, g.name, g.done ? icon('check', 18) : null),
      h('span', { class: 'round-class-meta' }, meta.length ? meta.join(' · ') : h('span', { class: 'muted' }, g.done ? 'готово' : '')),
      h('span', { class: 'round-class-count' }, `${g.marked}/${g.total}`),
      h('span', { class: 'round-chevron', 'aria-hidden': 'true' }, icon(opened ? 'chevron-up' : 'chevron-down', 18)));
    // Кнопка рядом с заголовком класса (не внутри него): доступна и у свёрнутого класса
    const copy = copyN ? btn('Как вчера', () => copyFromPrev(g), 'sm', { icon: 'undo', 'data-copy': g.id, title: `Заполнить класс ${g.name} как ${ui.date === today ? 'вчера' : 'за предыдущий день'}: неотмеченных ${copyN}`, 'aria-label': `Заполнить класс ${g.name} как вчера: неотмеченных ${copyN}` }) : null;
    const sec = h('section', { class: `round-class${ui.fx.done === g.id ? ' just-done' : ''}`, 'data-done': g.done ? 'true' : 'false', 'data-class': g.id }, h('div', { class: 'round-head-row' }, head, copy));
    if (!opened) return sec;

    const rest = g.students.filter((x) => !x.place).map((x) => x.student.id);
    const body = h('div', { class: `round-body${ui.fx.open === g.id ? ' opening' : ''}` });
    for (const x of rows) body.append(studentRow(g, x, false));
    if (rest.length > 1 && ui.filter !== 'away') body.append(h('div', { class: 'round-bulk' }, btn(`Всем неотмеченным (${rest.length}): Ночует`, () => bulk(g, rest), 'primary', { 'data-bulk': g.id })));
    sec.append(body);
    return sec;
  }

  function studentRow(g, x, withClass) {
    const { student, place, reason } = x;
    const who = [x.at ? hm(x.at) : '', x.by].filter(Boolean).join(' · ');
    return h('div', { class: 'round-row', 'data-place': place || '', 'data-student': student.id },
      h('div', { class: 'round-who' },
        h('span', { class: 'round-name' }, fullName(student), withClass ? h('span', { class: 'round-in' }, g.name) : null),
        who ? h('span', { class: 'round-when', title: 'Когда и кто отметил' }, who) : null),
      h('div', { class: 'round-btns', role: 'group', 'aria-label': `Где ${fullName(student)}` },
        ...ROUND_PLACES.map((p) => h('button', {
          type: 'button', class: `rp rp-${p.key}${ui.fx.tap === `${student.id}:${p.key}` ? ' tapped' : ''}`, 'aria-pressed': place === p.key ? 'true' : 'false', 'data-rk': `${student.id}:${p.key}`, 'aria-label': `${fullName(student)}: ${p.label}`,
          onclick: () => tap(g, x, place === p.key ? null : p.key),
        }, h('span', { class: 'rp-full' }, p.label), h('span', { class: 'rp-short' }, p.short)))),
      place ? h('button', { type: 'button', class: `round-reason${reason ? ' has' : ''}`, 'data-reason-for': student.id, onclick: () => askReason(student, place, reason) }, reason ? [h('span', { class: 'rr-label' }, 'Причина: '), reason] : [icon('plus', 14), 'Причина']) : null);
  }

  // Причина к отметке: одно касание по готовой причине или своя строка; «Без причины» просто закрывает окно.
  function askReason(student, place, current) {
    const save = async (text, ctxm) => {
      try {
        await repo.setRoundReason(student.id, ui.date, text, { kind: ui.kind });
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
        { label: 'Сохранить', kind: 'primary', run: async () => { await repo.setRoundReason(student.id, ui.date, custom.get(), { kind: ui.kind }); draw(); } },
        ...(current ? [{ label: 'Убрать причину', kind: 'danger-outline', run: async () => { await repo.setRoundReason(student.id, ui.date, '', { kind: ui.kind }); draw(); } }] : []),
        { label: current ? 'Закрыть' : 'Без причины', kind: 'secondary' },
      ],
    });
  }

  // Отметка → запись → перерисовка. Когда класс стал «готов», он сворачивается: следующий класс — сразу под ним.
  // Чужую отметку (поставил другой человек) перезаписываем только после подтверждения.
  async function tap(g, x, place) {
    const other = x.place && x.by && myName() && x.by !== myName();
    if (other && place !== x.place) {
      const ok = await confirmAction({ title: 'Изменить чужую отметку', message: `${fullName(x.student)}: «${ROUND_LABEL[x.place]}» отметил(а) ${x.by}${x.at ? ` в ${hm(x.at)}` : ''}. Изменить?`, confirmLabel: 'Изменить', kind: 'primary' });
      if (!ok) return;
    }
    const wasDone = g.done;
    if (!(await mark([x.student.id], place))) return;
    const now = roundView(ctx.state, ui.date, ui.kind).groups.find((y) => y.id === g.id);
    if (place) ui.fx.tap = `${x.student.id}:${place}`;
    if (now && now.done && !wasDone) { ui.open.delete(g.id); ui.fx.done = g.id; }
    draw();
    if (place && !isHere(place)) {
      const cur = ctx.state.rounds.find((r) => r.studentId === x.student.id && r.date === ui.date && (r.kind || 'evening') === ui.kind);
      askReason(x.student, place, cur ? cur.reason || '' : '');
    }
  }

  // Копия вчерашнего обхода неотмеченным: показываем, что именно будет поставлено, и просим подтвердить.
  async function copyFromPrev(g = null) {
    const prevDate = shiftDate(ui.date, -1);
    const plan = copyPlan(ctx.state, prevDate, ui.date, ui.kind, g ? g.id : null);
    if (!plan.length) return;
    const by = {};
    for (const p of plan) by[p.place] = (by[p.place] || 0) + 1;
    const ok = await confirmAction({
      title: g ? `Класс ${g.name}: как вчера` : 'Заполнить как вчера',
      message: `Неотмеченным ученикам${g ? ` класса ${g.name}` : ''} (${plan.length}) будет поставлен тот же статус, что и ${ui.date === today ? 'вчера' : `за ${formatDate(prevDate)}`}. Уже отмеченные не изменятся.`,
      details: ROUND_PLACES.filter((p) => by[p.key]).map((p) => `${p.label}: ${by[p.key]}`),
      confirmLabel: `Заполнить: ${plan.length}`, kind: 'primary',
    });
    if (!ok) return;
    try {
      const n = await repo.copyRounds(prevDate, ui.date, { kind: ui.kind, by: myName(), classId: g ? g.id : null });
      toast(`Отмечено учеников: ${n}`);
    } catch (e) { toastError(e); }
    draw();
  }

  async function bulk(g, ids) {
    const ok = await confirmAction({ title: 'Отметить весь класс', message: `Отметить «${ROUND_LABEL.sleeping}» у всех неотмеченных в классе ${g.name}: ${nStudents(ids.length)}?`, confirmLabel: `Отметить: ${ids.length}`, kind: 'primary' });
    if (!ok) return;
    await mark(ids, 'sleeping');
    const now = roundView(ctx.state, ui.date, ui.kind).groups.find((y) => y.id === g.id);
    if (now && now.done) { ui.open.delete(g.id); ui.fx.done = g.id; }
    draw();
  }

  draw();
  return () => clearInterval(tick);
}
