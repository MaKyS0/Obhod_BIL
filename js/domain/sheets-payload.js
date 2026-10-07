// Формирование данных для Google Таблиц (чистая функция, без сети).
import { getIndex } from './state.js';
import { yearView, staffReport, generalReport } from './stats.js';
import { fullName, ROLE_LABEL, STUDENT_STATUS } from './people.js';
import { formatDate } from './dates.js';
import { yearLabel, compareYears } from './years.js';
import { exportData } from './backup.js';
import { compareClasses } from './classes.js';
import { cmp } from './collate.js';
import { roundView, ROUND_LABEL } from './rounds.js';
import { todayISO } from './dates.js';

export const SHEET_NAMES = ['Ученики', 'Классы', 'Учителя', 'Воспитатели', 'Отчёт', 'Архив', 'История', 'Вечерний обход'];

// Значение, начинающееся с = + - @, превращается в текст (защита от формул).
export function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=@]|^[+-](?![\d\s().-])/.test(s) ? `'${s}` : s;
}

const rowsSafe = (rows) => rows.map((r) => r.map(safeCell));

export function buildSheetsPayload(state, { includeBackup = true, now = new Date().toISOString() } = {}) {
  const s = state.settings;
  const idx = getIndex(state);
  const yid = s.currentYearId;
  const view = yearView(state, yid);

  const students = [];
  for (const c of view.classes) {
    for (const { student: st } of c.students) {
      students.push([st.id, st.lastName, st.firstName, st.middleName, fullName(st), formatDate(st.birthDate), c.name, c.grade, STUDENT_STATUS[st.status], yearLabel(yid), st.notes || '']);
    }
  }
  for (const { student: st } of view.unassigned) students.push([st.id, st.lastName, st.firstName, st.middleName, fullName(st), formatDate(st.birthDate), '', '', 'Без класса', yearLabel(yid), st.notes || '']);
  for (const { student: st } of view.pending) students.push([st.id, st.lastName, st.firstName, st.middleName, fullName(st), formatDate(st.birthDate), '', '', 'Ожидает выпуска', yearLabel(yid), st.notes || '']);

  const classes = view.classes.map((c) => [yearLabel(yid), c.name, c.grade, c.letter, c.count, fullName(c.teacher), fullName(c.tutor), c.cls.notes || '']);

  const staffSheet = (role) =>
    staffReport(state, yid, { includeArchived: true })
      .filter((r) => r.role === role)
      .map((r) => [r.staff.id, r.name, r.classes.join(', '), r.count, r.staff.phone || '', r.staff.email || '', r.staff.archived ? 'В архиве' : 'Работает']);

  const report = [...generalReport(view).map((r) => [...r]), ['Выгружено', formatDate(now)]];

  const archive = state.students
    .filter((st) => st.status !== 'active')
    .map((st) => {
      const last = (idx.enrollmentsByStudent.get(st.id) || []).slice().sort((a, b) => compareYears(a.yearId, b.yearId)).pop();
      const cls = last && last.classId ? idx.classes.get(last.classId) : null;
      return [st.id, fullName(st), formatDate(st.birthDate), STUDENT_STATUS[st.status], st.status === 'graduated' ? yearLabel(st.graduatedYearId) : formatDate(st.leftDate), cls ? cls.name : ''];
    })
    .sort((a, b) => cmp(a[1], b[1]));

  const history = [];
  for (const y of state.years.slice().sort((a, b) => compareYears(a.id, b.id))) {
    const v = yearView(state, y.id);
    for (const c of v.classes.slice().sort(compareClasses)) history.push([yearLabel(y.id), c.name, c.count, fullName(c.teacher), fullName(c.tutor)]);
  }

  // Вечерний обход: самая свежая дата, по которой есть отметки (иначе сегодняшняя).
  const roundDate = state.rounds && state.rounds.length ? state.rounds.reduce((m, r) => (r.date > m ? r.date : m), '') : todayISO();
  const round = [];
  for (const g of roundView(state, roundDate).groups) for (const x of g.students) round.push([formatDate(roundDate), g.name, fullName(x.student), x.place ? ROUND_LABEL[x.place] : 'не отмечен']);

  const sheets = {
    'Ученики': { header: ['ID', 'Фамилия', 'Имя', 'Отчество', 'ФИО', 'Дата рождения', 'Класс', 'Параллель', 'Статус', 'Учебный год', 'Примечание'], rows: rowsSafe(students) },
    'Классы': { header: ['Учебный год', 'Класс', 'Параллель', 'Буква', 'Учеников', ROLE_LABEL.teacher, ROLE_LABEL.tutor, 'Примечание'], rows: rowsSafe(classes) },
    'Учителя': { header: ['ID', 'ФИО', 'Классы', 'Кол-во классов', 'Телефон', 'Email', 'Статус'], rows: rowsSafe(staffSheet('teacher')) },
    'Воспитатели': { header: ['ID', 'ФИО', 'Классы', 'Кол-во классов', 'Телефон', 'Email', 'Статус'], rows: rowsSafe(staffSheet('tutor')) },
    'Отчёт': { header: ['Показатель', 'Значение'], rows: rowsSafe(report) },
    'Архив': { header: ['ID', 'ФИО', 'Дата рождения', 'Статус', 'Год выпуска / дата выбытия', 'Последний класс'], rows: rowsSafe(archive) },
    'История': { header: ['Учебный год', 'Класс', 'Учеников', ROLE_LABEL.teacher, ROLE_LABEL.tutor], rows: rowsSafe(history) },
    'Вечерний обход': { header: ['Дата', 'Класс', 'Ученик', 'Где'], rows: rowsSafe(round) },
  };

  return {
    type: 'lyceum-sync',
    version: 1,
    token: s.sheetsToken || '',
    sentAt: now,
    lyceumName: s.lyceumName,
    currentYear: yearLabel(yid),
    sheets,
    backup: includeBackup ? JSON.stringify(exportData(state, { now })) : '',
  };
}
