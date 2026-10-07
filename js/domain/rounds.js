// Вечерний обход: где ученик вечером. Запись обхода — id `дата:ученик`, одна отметка на ученика в день.
import { yearView } from './stats.js';
import { pad } from './dates.js';

export const ROUND_PLACES = [
  { key: 'sick', label: 'Болеет' },
  { key: 'home', label: 'С дома' },
  { key: 'sleeping', label: 'Ночует' },
];
export const ROUND_LABEL = Object.fromEntries(ROUND_PLACES.map((p) => [p.key, p.label]));
// Быстрые причины для частых случаев (можно ввести и свою). Для «Ночует» готовых причин нет — только своя.
export const ROUND_REASONS = {
  sick: ['Температура', 'Простуда', 'Болит живот', 'Болит голова', 'В медпункте', 'В больнице'],
  home: ['Отпущен родителями', 'Семейные обстоятельства', 'Выходной', 'Поездка / соревнования'],
  sleeping: [],
};
export const REASON_MAX = 120;
export const cleanReason = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
export const isPlace = (v) => Object.prototype.hasOwnProperty.call(ROUND_LABEL, v);

// Сколько дней хранятся отметки (сегодня + два предыдущих дня): база остаётся лёгкой, старые отметки удаляются сами.
export const ROUND_KEEP_DAYS = 3;

export const roundId = (date, studentId) => `${date}:${studentId}`;

export function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Самая ранняя дата, на которую ещё можно поставить отметку. */
export const earliestRoundDate = (today) => shiftDate(today, -(ROUND_KEEP_DAYS - 1));

/**
 * Состояние обхода на дату: группы по классам текущего года.
 * done — в классе есть ученики и все отмечены (экран красит такой класс в зелёный).
 */
export function roundView(state, date) {
  const marks = new Map();
  const reasons = new Map();
  for (const r of state.rounds || []) {
    if (r.date !== date || !isPlace(r.place)) continue; // запись с неизвестным местом (чужие данные) игнорируется
    marks.set(r.studentId, r.place);
    if (typeof r.reason === 'string' && r.reason) reasons.set(r.studentId, r.reason.slice(0, REASON_MAX));
  }
  const v = yearView(state, state.settings.currentYearId);
  const totals = { total: 0, marked: 0, byPlace: Object.fromEntries(ROUND_PLACES.map((p) => [p.key, 0])) };
  const groupOf = (id, name, list) => {
    const students = list.map(({ student }) => ({ student, place: marks.get(student.id) || null, reason: reasons.get(student.id) || '' }));
    const marked = students.filter((x) => x.place).length;
    for (const x of students) if (x.place) totals.byPlace[x.place]++;
    totals.total += students.length;
    totals.marked += marked;
    return { id, name, students, total: students.length, marked, done: students.length > 0 && marked === students.length };
  };
  const groups = v.classes.filter((c) => c.count > 0).map((c) => groupOf(c.id, c.name, c.students));
  if (v.unassigned.length) groups.push(groupOf('_none', 'Без класса', v.unassigned.slice().sort((a, b) => (a.student.lastName + a.student.firstName < b.student.lastName + b.student.firstName ? -1 : 1))));
  return { date, groups, totals, doneClasses: groups.filter((g) => g.done).length };
}
