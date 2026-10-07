// ФИО и сравнение людей.
export function fullName(p) {
  if (!p) return '';
  return [p.lastName, p.firstName, p.middleName].map((x) => (x || '').trim()).filter(Boolean).join(' ');
}

export function shortName(p) {
  if (!p) return '';
  const ini = [p.firstName, p.middleName].map((x) => (x || '').trim()).filter(Boolean).map((x) => x[0].toUpperCase() + '.').join('');
  return [(p.lastName || '').trim(), ini].filter(Boolean).join(' ');
}

export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

export function nameKey(p) {
  return [p.lastName, p.firstName, p.middleName].map(norm).join('|');
}

export function dedupeKey(p) {
  return `${nameKey(p)}|${p.birthDate || ''}`;
}

// «Иванов Иван Иванович» → { lastName, firstName, middleName }
export function splitFio(str) {
  const parts = String(str ?? '').trim().split(/\s+/).filter(Boolean);
  return { lastName: parts[0] || '', firstName: parts[1] || '', middleName: parts.slice(2).join(' ') };
}

export const STUDENT_STATUS = {
  active: 'Учится',
  left: 'Выбыл',
  graduated: 'Выпускник',
};

export const ROLE_LABEL = { teacher: 'Классный руководитель', tutor: 'Воспитатель' };
export const ROLE_LABEL_PLURAL = { teacher: 'Классные руководители', tutor: 'Воспитатели' };
