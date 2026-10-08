// Календарь (администратор): выходные дни и кто дежурит. Выходные не считаются в отчётах; дежурный показывается на экране обхода.
import { h } from '../ui/dom.js';
import { pageHead, btn, badge } from '../ui/common.js';
import { field, checkbox } from '../ui/form.js';
import { openModal } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { dayInfo, DAY_NOTE_MAX, DUTY_MAX } from '../domain/calendar.js';
import { fullName } from '../domain/people.js';
import { todayISO } from '../domain/dates.js';

export const title = 'Календарь и дежурства';

const ui = { month: null }; // 'YYYY-MM'
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const monthShift = (ym, n) => { const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const daysIn = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

export function render(ctx) {
  const { state: s, view: el, repo } = ctx;
  const today = todayISO();
  if (!ui.month) ui.month = today.slice(0, 7);
  const ym = ui.month;
  const go = (n) => { ui.month = monthShift(ym, n); ctx.refresh(); };

  el.append(pageHead({
    title: 'Календарь и дежурства',
    sub: `${MONTHS[Number(ym.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase())} ${ym.slice(0, 4)}`,
    actions: [btn('', () => go(-1), 'ghost', { icon: 'chevron-left', 'aria-label': 'Предыдущий месяц', title: 'Предыдущий месяц' }), btn('Сегодня', () => { ui.month = today.slice(0, 7); ctx.refresh(); }, 'ghost'), btn('', () => go(1), 'ghost', { icon: 'chevron-right', 'aria-label': 'Следующий месяц', title: 'Следующий месяц' })],
  }));

  const rows = [];
  for (let d = 1; d <= daysIn(ym); d++) {
    const date = `${ym}-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${date}T12:00:00`).getDay();
    const info = dayInfo(s, date);
    const weekend = wd === 0 || wd === 6;
    rows.push(h('tr', { 'data-date': date, class: `${info.holiday ? 'is-holiday' : ''}${date === today ? ' is-today' : ''}` },
      h('td', { class: 'nowrap' }, h('strong', null, String(d)), ' ', h('span', { class: weekend ? 'muted' : '' }, WEEKDAYS[wd])),
      h('td', null, info.holiday ? badge('Выходной', 'warn') : h('span', { class: 'muted' }, 'обычный день')),
      h('td', null, info.dutyLabel || h('span', { class: 'muted' }, '—')),
      h('td', null, info.note || h('span', { class: 'muted' }, '—')),
      h('td', { class: 'cell-actions' }, btn('Изменить', () => edit(date), 'sm', { 'data-edit': date }))));
  }
  el.append(h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data', 'aria-label': 'Дни месяца' },
    h('thead', null, h('tr', null, ['День', 'Статус', 'Дежурные', 'Заметка', ''].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows)))));

  function edit(date) {
    const info = dayInfo(s, date);
    const holiday = checkbox({ label: 'Выходной или праздничный день', checked: info.holiday, hint: 'Такой день не учитывается в отчётах обхода' });
    const note = field({ label: 'Заметка', name: 'dayNote', value: info.note, attrs: { maxlength: DAY_NOTE_MAX }, placeholder: 'Например: каникулы, праздник' });
    const staff = s.staff.filter((x) => !x.archived).slice().sort((a, b) => (fullName(a) < fullName(b) ? -1 : 1));
    const chosen = new Set(info.rec ? info.rec.dutyStaffIds || [] : []);
    const boxes = staff.map((x) => ({ x, cb: checkbox({ label: fullName(x), checked: chosen.has(x.id) }) }));
    const duty = h('fieldset', { class: 'duty-pick' }, h('legend', null, `Кто дежурит (до ${DUTY_MAX})`), boxes.length ? boxes.map((b) => b.cb.el) : h('p', { class: 'muted' }, 'В разделе «Персонал» пока никого нет — можно вписать имя вручную ниже.'));
    const text = field({ label: 'Дежурный не из списка', name: 'dutyText', value: info.dutyText, attrs: { maxlength: DAY_NOTE_MAX }, placeholder: 'Например: воспитатель из соседнего корпуса' });
    openModal({
      title: new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }),
      body: h('div', null, holiday.el, note.el, duty, text.el),
      actions: [
        {
          label: 'Сохранить', kind: 'primary',
          run: async () => {
            const ids = boxes.filter((b) => b.cb.get()).map((b) => b.x.id);
            if (ids.length > DUTY_MAX) { toastError(new Error(`Можно выбрать не больше ${DUTY_MAX} дежурных`)); return false; }
            try { await repo.setDay(date, { holiday: holiday.get(), note: note.get(), dutyStaffIds: ids, dutyText: text.get() }); toast('Сохранено'); ctx.refresh(); } catch (e) { toastError(e); return false; }
            return undefined;
          },
        },
        { label: 'Отмена', kind: 'secondary' },
      ],
    });
  }
}
