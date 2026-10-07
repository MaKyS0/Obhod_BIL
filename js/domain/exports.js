// Табличные выгрузки (CSV) и шаблоны для импорта.
import { yearView, staffReport, generalReport } from './stats.js';
import { fullName, STUDENT_STATUS, ROLE_LABEL } from './people.js';
import { formatDate } from './dates.js';
import { yearLabel } from './years.js';
import { stringifyCsv } from './csv.js';

export function studentsCsv(state, yearId) {
  const v = yearView(state, yearId);
  const rows = [['Фамилия', 'Имя', 'Отчество', 'Класс', 'Дата рождения', 'Статус', 'Примечание']];
  for (const c of v.classes) for (const { student: s, enr } of c.students) rows.push([s.lastName, s.firstName, s.middleName, c.name, formatDate(s.birthDate), enr.status === 'graduated' ? STUDENT_STATUS.graduated : STUDENT_STATUS[s.status], s.notes || '']);
  for (const { student: s } of v.unassigned) rows.push([s.lastName, s.firstName, s.middleName, '', formatDate(s.birthDate), 'Без класса', s.notes || '']);
  return stringifyCsv(rows);
}

export function classesCsv(state, yearId) {
  const v = yearView(state, yearId);
  const rows = [['Класс', 'Учеников', 'Классный руководитель', 'Воспитатель']];
  for (const c of v.classes) rows.push([c.name, c.count, fullName(c.teacher), fullName(c.tutor)]);
  return stringifyCsv(rows);
}

export function staffCsv(state, yearId) {
  const rows = [['ФИО', 'Должность', 'Классы', 'Закреплено классов', 'Телефон', 'Email']];
  for (const r of staffReport(state, yearId)) rows.push([r.name, r.roleLabel, r.classes.join(', '), r.count, r.staff.phone || '', r.staff.email || '']);
  return stringifyCsv(rows);
}

export function generalCsv(state, yearId) {
  return stringifyCsv([['Показатель', 'Значение'], ...generalReport(yearView(state, yearId)).map(([a, b]) => [a, a === 'Учебный год' ? yearLabel(b) : b])]);
}

export const STUDENT_TEMPLATE = stringifyCsv([
  ['Фамилия', 'Имя', 'Отчество', 'Класс', 'Дата рождения', 'Примечание'],
  ['Фамилия-образец', 'Имя-образец', 'Отчество-образец', '7A', '05.04.2013', 'Строка-пример: удалите её перед импортом'],
]);

export const STAFF_TEMPLATE = stringifyCsv([
  ['ФИО', 'Должность', 'Класс', 'Телефон', 'Email'],
  ['Фамилия-образец Имя Отчество', 'Классный руководитель', '7A', '', ''],
  ['Фамилия-образец Имя Отчество', 'Воспитатель', '7A', '', ''],
]);

export { ROLE_LABEL };
