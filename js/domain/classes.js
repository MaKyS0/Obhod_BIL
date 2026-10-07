// Классы: разбор названий, идентификаторы, сортировка.
export const DEFAULT_LETTERS = ['A', 'B', 'C'];
export const MIN_GRADE = 7;
export const MAX_GRADE = 11;

// Кириллические буквы, внешне совпадающие с латинскими, приводятся к латинице.
const HOMOGLYPHS = { 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X' };

export function normalizeLetter(ch) {
  const up = String(ch || '').trim().toUpperCase();
  return HOMOGLYPHS[up] || up;
}

export function classId(yearId, grade, letter) {
  return `${yearId}:${grade}${letter}`;
}

export function className(grade, letter) {
  return `${grade}${letter}`;
}

// «7А», «7 а», «7-A», «7 «А»», «11c» → { grade, letter, name } или null.
export function parseClassName(str, { letters = DEFAULT_LETTERS, minGrade = MIN_GRADE, maxGrade = MAX_GRADE } = {}) {
  const s = String(str ?? '').trim();
  const m = s.match(/^(\d{1,2})\s*[-–—.]?\s*["«'“”]?\s*([A-Za-zА-Яа-яЁё])\s*["»'“”]?$/);
  if (!m) return null;
  const grade = Number(m[1]);
  const letter = normalizeLetter(m[2]);
  if (grade < minGrade || grade > maxGrade || !letters.includes(letter)) return null;
  return { grade, letter, name: className(grade, letter) };
}

export function compareClasses(a, b) {
  return a.grade - b.grade || (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0);
}

export function allClassSlots(settings) {
  const slots = [];
  for (let g = settings.minGrade; g <= settings.maxGrade; g++) {
    for (const l of settings.letters) slots.push({ grade: g, letter: l });
  }
  return slots;
}

export function makeClass(yearId, grade, letter, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: classId(yearId, grade, letter),
    yearId,
    grade,
    letter,
    name: className(grade, letter),
    notes: '',
    archived: false,
    demo: false,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}
