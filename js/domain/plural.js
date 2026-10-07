// Русское склонение числительных: 1 ученик, 2 ученика, 5 учеников.
export function plural(n, forms) {
  if (!Number.isInteger(n)) return forms[1];
  const a = Math.abs(n);
  const m10 = a % 10;
  const m100 = a % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}

const make = (forms) => (n) => `${n} ${plural(n, forms)}`;
export const nStudents = make(['ученик', 'ученика', 'учеников']);
export const nClasses = make(['класс', 'класса', 'классов']);
export const nStaff = make(['сотрудник', 'сотрудника', 'сотрудников']);
export const nTeachers = make(['руководитель', 'руководителя', 'руководителей']);
export const nTutors = make(['воспитатель', 'воспитателя', 'воспитателей']);
export const nChanges = make(['изменение', 'изменения', 'изменений']);
export const nRows = make(['строка', 'строки', 'строк']);
