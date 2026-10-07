// «Последние изменения» для главной: события собираются из меток времени самих записей (отдельного журнала нет).
// Серии однотипных событий (например, импорт списка) склеиваются в одну строку.
import { fullName } from './people.js';
import { yearLabel } from './years.js';
import { formatDate } from './dates.js';
import { nStudents, nStaff } from './plural.js';

const WINDOW_MS = 3 * 60 * 1000; // события одного вида в пределах 3 минут считаются одной операцией

function collect(state) {
  const ev = [];
  for (const s of state.students) {
    if (s.createdAt) ev.push({ at: s.createdAt, kind: 'student-add', name: fullName(s) });
    if (s.updatedAt && s.updatedAt > (s.createdAt || '')) ev.push({ at: s.updatedAt, kind: s.status === 'left' ? 'student-left' : s.status === 'graduated' ? 'student-grad' : 'student-edit', name: fullName(s) });
  }
  for (const s of state.staff) {
    if (s.createdAt) ev.push({ at: s.createdAt, kind: 'staff-add', name: fullName(s) });
    if (s.updatedAt && s.updatedAt > (s.createdAt || '')) ev.push({ at: s.updatedAt, kind: 'staff-edit', name: fullName(s) });
  }
  for (const p of state.promotions) {
    if (p.executedAt) ev.push({ at: p.executedAt, kind: 'promotion', name: `${yearLabel(p.fromYearId)} → ${yearLabel(p.toYearId)}` });
    if (p.undone && p.undoneAt) ev.push({ at: p.undoneAt, kind: 'promotion-undo', name: `${yearLabel(p.toYearId)}` });
  }
  const byDate = new Map();
  for (const r of state.rounds || []) {
    if (!r.updatedAt) continue;
    const g = byDate.get(r.date) || { at: r.updatedAt, count: 0 };
    g.count++;
    if (r.updatedAt > g.at) g.at = r.updatedAt;
    byDate.set(r.date, g);
  }
  for (const [date, g] of byDate) ev.push({ at: g.at, kind: 'round', name: formatDate(date), count: g.count });
  return ev.sort((a, b) => (a.at < b.at ? 1 : -1));
}

const TEXT = {
  'student-add': (n, name) => (n === 1 ? ['Добавлен ученик', name] : [`Добавлено учеников: ${n}`, '']),
  'student-edit': (n, name) => (n === 1 ? ['Изменены данные ученика', name] : [`Изменены данные: ${nStudents(n)}`, '']),
  'student-left': (n, name) => (n === 1 ? ['Ученик выбыл', name] : [`Выбыло: ${nStudents(n)}`, '']),
  'student-grad': (n, name) => (n === 1 ? ['Выпускник', name] : [`Выпуск: ${nStudents(n)}`, '']),
  'staff-add': (n, name) => (n === 1 ? ['Добавлен сотрудник', name] : [`Добавлено сотрудников: ${n}`, '']),
  'staff-edit': (n, name) => (n === 1 ? ['Изменены данные сотрудника', name] : [`Изменены данные: ${nStaff(n)}`, '']),
  promotion: (n, name) => ['Переход на новый учебный год', name],
  'promotion-undo': (n, name) => ['Отменён переход на учебный год', name],
  round: (n, name, count) => [`Вечерний обход ${name}`, `отметок: ${count}`],
};

/** Возвращает [{ at, title, detail }] — не больше limit самых свежих операций. */
export function recentChanges(state, limit = 8) {
  const groups = [];
  const open = new Map(); // вид события → текущая серия: однотипные события в пределах окна склеиваются, даже если между ними были другие
  for (const e of collect(state)) {
    const g = open.get(e.kind);
    if (g && e.kind !== 'promotion' && e.kind !== 'round' && Date.parse(g.lastAt) - Date.parse(e.at) < WINDOW_MS) {
      g.n++;
      g.lastAt = e.at;
      continue;
    }
    const fresh = { kind: e.kind, at: e.at, lastAt: e.at, n: 1, name: e.name, count: e.count };
    open.set(e.kind, fresh);
    groups.push(fresh);
  }
  groups.sort((a, b) => (a.at < b.at ? 1 : -1));
  return groups.slice(0, limit).map((g) => {
    const [title, detail] = TEXT[g.kind](g.n, g.name, g.count);
    return { at: g.at, kind: g.kind, title, detail };
  });
}
