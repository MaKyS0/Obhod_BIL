// Строки для выгрузки обхода в Excel. Всё берётся из общей базы (state), ничего не выдумывается: неотмеченные ученики — «Не отмечен».
import { roundView, ROUND_LABEL, ROUND_KINDS } from './rounds.js';
import { fullName } from './people.js';
import { buildXlsx, excelTime } from './xlsx.js';
import { pad } from './dates.js';

export const ROUND_COLUMNS = [
  { header: 'Дата', width: 12, type: 'date' },
  { header: 'Время', width: 8, type: 'time' },
  { header: 'Ученик', width: 34, type: 'string' },
  { header: 'Класс', width: 8, type: 'string' },
  { header: 'Статус', width: 14, type: 'string' },
  { header: 'Причина', width: 30, type: 'string' },
  { header: 'Ответственный', width: 22, type: 'string' },
];

/** Время отметки (местное время устройства) как доля суток; пусто, если времени нет. */
export function timeCell(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? excelTime(d.getHours(), d.getMinutes()) : null;
}

/** Строки за один день и один вид проверки: все ученики по классам, затем по ФИО. */
export function dayRows(state, date, kind = 'evening', records = null) {
  const v = roundView(state, date, kind, records);
  const rows = [];
  for (const g of v.groups) {
    const list = g.students.slice().sort((a, b) => (fullName(a.student) < fullName(b.student) ? -1 : 1));
    for (const x of list) rows.push([date, x.place ? timeCell(x.at) : null, fullName(x.student), g.id === '_none' ? '' : g.name, x.place ? ROUND_LABEL[x.place] : 'Не отмечен', x.reason, x.place ? x.by : '']);
  }
  return rows;
}

/** Готовый файл .xlsx (Uint8Array). */
export function roundWorkbook(rows, { sheetName = 'Обход', kind = null } = {}) {
  const label = kind ? (ROUND_KINDS.find((k) => k.key === kind) || {}).label : '';
  return buildXlsx({ sheets: [{ name: label ? `${sheetName} · ${label}` : sheetName, columns: ROUND_COLUMNS, rows }] });
}

const taken = new Set();
/** Имя файла: evening-round-2026-10-08-18-30.xlsx. Каждый экспорт — новый файл; два в одну минуту получат -2, -3. */
export function exportFilename(prefix = 'evening-round', now = new Date()) {
  const base = `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`;
  let name = `${base}.xlsx`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.xlsx`;
  taken.add(name);
  return name;
}

/** Записи отметок из ответа сервера (action marks): [дата, вид, ученик, класс, место, причина, кто, время] → объекты. */
export const recordsFromMarks = (rows) => rows.map(([date, kind, studentId, classId, place, reason, by, at]) => ({ date, kind: kind === 'evening' ? undefined : kind, studentId, classId, place, reason, by, at }));

export const EXPORT_PREFIX = { evening: 'evening-round', morning: 'morning-check', extra: 'extra-check' };

/** Строки выгрузки за период: только реально сделанные отметки (неотмеченных дней в истории нет). Порядок: дата, класс, ФИО. */
export function marksRows(state, marks) {
  const students = new Map((state.students || []).map((s) => [s.id, s]));
  const classes = new Map((state.classes || []).map((c) => [c.id, c.name]));
  return recordsFromMarks(marks)
    .map((r) => ({ r, name: students.has(r.studentId) ? fullName(students.get(r.studentId)) : 'Ученик удалён из базы', cls: classes.get(r.classId) || '' }))
    .sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ r, name, cls }) => [r.date, timeCell(r.at), name, cls, ROUND_LABEL[r.place] || r.place, r.reason || '', r.by || '']);
}
