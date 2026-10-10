// Вечерний обход: где ученик вечером. Запись обхода — id `дата:ученик`, одна отметка на ученика в день.
import { yearView } from './stats.js';
import { pad } from './dates.js';

// Места: «Ночует» — на месте (зелёный), остальные — нет на месте (красные оттенки). short — подпись на узкой кнопке.
export const ROUND_PLACES = [
  { key: 'sick', label: 'Болеет', short: 'Болеет' },
  { key: 'home', label: 'С дома', short: 'С дома' },
  { key: 'absent', label: 'Отсутствует', short: 'Нет' },
  { key: 'sleeping', label: 'Ночует', short: 'Ночует' },
];
export const AWAY_PLACES = ['sick', 'home', 'absent'];
export const isHere = (place) => place === 'sleeping';

// Виды проверки: вечерняя (основная, id записи не менялся), утренняя и дополнительная.
export const ROUND_KINDS = [
  { key: 'evening', label: 'Вечер' },
  { key: 'morning', label: 'Утро' },
  { key: 'extra', label: 'Доп.' },
];
export const isKind = (v) => ROUND_KINDS.some((k) => k.key === v);
export const kindOf = (rec) => (rec && isKind(rec.kind) ? rec.kind : 'evening');
export const ROUND_LABEL = Object.fromEntries(ROUND_PLACES.map((p) => [p.key, p.label]));
// Быстрые причины для частых случаев (можно ввести и свою). Для «Ночует» готовых причин нет — только своя.
export const ROUND_REASONS = {
  sick: ['Температура', 'Простуда', 'Болит живот', 'Болит голова', 'В медпункте', 'В больнице'],
  home: ['Отпущен родителями', 'Семейные обстоятельства', 'Выходной', 'Поездка / соревнования'],
  absent: ['Не найден', 'Ушёл без разрешения', 'На занятиях / в кружке', 'Выясняется'],
  sleeping: [],
};
export const REASON_MAX = 120;
export const cleanReason = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
export const isPlace = (v) => Object.prototype.hasOwnProperty.call(ROUND_LABEL, v);

// Сколько дней хранятся отметки (сегодня + два предыдущих дня): база остаётся лёгкой, старые отметки удаляются сами.
export const ROUND_KEEP_DAYS = 3;

// Вечерняя отметка — `дата:ученик` (как всегда); утренняя и дополнительная — `дата:вид:ученик`.
export const roundId = (date, studentId, kind = 'evening') => (kind === 'evening' || !isKind(kind) ? `${date}:${studentId}` : `${date}:${kind}:${studentId}`);

export function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Самая ранняя дата, на которую ещё можно поставить отметку. */
export const ROUND_KEEP = { evening: ROUND_KEEP_DAYS, morning: 2, extra: 2 }; // сколько дней хранятся отметки каждого вида
export const earliestRoundDate = (today, kind = 'evening') => shiftDate(today, -((ROUND_KEEP[kind] || ROUND_KEEP_DAYS) - 1));

/**
 * «Заполнить как вчера»: кому из неотмеченных на дату `to` можно поставить статус (и причину) отметки за дату `from` того же вида проверки.
 * classId — только один класс (по умолчанию все). Возвращает [{ studentId, classId, place, reason }].
 */
export function copyPlan(state, from, to, kind = 'evening', classId = null) {
  const src = new Map();
  for (const g of roundView(state, from, kind).groups) for (const x of g.students) if (x.place) src.set(x.student.id, x);
  const plan = [];
  for (const g of roundView(state, to, kind).groups) for (const x of g.students) {
    if (classId && g.id !== classId) continue;
    const prev = src.get(x.student.id);
    if (!x.place && prev) plan.push({ studentId: x.student.id, classId: g.id === '_none' ? null : g.id, place: prev.place, reason: isHere(prev.place) ? '' : prev.reason });
  }
  return plan;
}

/**
 * Состояние обхода на дату: группы по классам текущего года.
 * done — в классе есть ученики и все отмечены (экран красит такой класс в зелёный).
 */
// records — готовые записи отметок вместо state.rounds (для дат, которых в общей базе уже нет: итоги из истории на сервере).
export function roundView(state, date, kind = 'evening', records = null) {
  const marks = new Map();
  const reasons = new Map();
  const meta = new Map();
  for (const r of records || state.rounds || []) {
    if (r.date !== date || kindOf(r) !== kind || !isPlace(r.place)) continue; // запись с неизвестным местом или другого вида проверки не в счёт
    marks.set(r.studentId, r.place);
    if (typeof r.reason === 'string' && r.reason) reasons.set(r.studentId, r.reason.slice(0, REASON_MAX));
    meta.set(r.studentId, { at: typeof r.at === 'string' ? r.at : r.updatedAt || '', by: typeof r.by === 'string' ? r.by : '' });
  }
  const v = yearView(state, state.settings.currentYearId);
  const totals = { total: 0, marked: 0, byPlace: Object.fromEntries(ROUND_PLACES.map((p) => [p.key, 0])) };
  const groupOf = (id, name, list, cls = null) => {
    const students = list.map(({ student }) => ({ student, place: marks.get(student.id) || null, reason: reasons.get(student.id) || '', at: (meta.get(student.id) || {}).at || '', by: (meta.get(student.id) || {}).by || '' }));
    const marked = students.filter((x) => x.place).length;
    for (const x of students) if (x.place) totals.byPlace[x.place]++;
    totals.total += students.length;
    totals.marked += marked;
    return { id, name, room: (cls && cls.room) || '', teacher: (cls && cls.teacher) || null, tutor: (cls && cls.tutor) || null, students, total: students.length, marked, done: students.length > 0 && marked === students.length };
  };
  const groups = v.classes.filter((c) => c.count > 0).map((c) => groupOf(c.id, c.name, c.students, { room: c.cls.room, teacher: c.teacher, tutor: c.tutor }));
  if (v.unassigned.length) groups.push(groupOf('_none', 'Без класса', v.unassigned.slice().sort((a, b) => (a.student.lastName + a.student.firstName < b.student.lastName + b.student.firstName ? -1 : 1))));
  totals.away = AWAY_PLACES.reduce((n, k) => n + totals.byPlace[k], 0);
  return { date, kind, groups, totals, doneClasses: groups.filter((g) => g.done).length, classesLeft: groups.filter((g) => !g.done).length };
}
