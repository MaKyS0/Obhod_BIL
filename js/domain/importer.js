// Импорт учеников и сотрудников из CSV / JSON. Возвращает пробный прогон и готовый пакет изменений.
import { getIndex, emptyChanges, addPut } from './state.js';
import { parseClassName, makeClass, classId } from './classes.js';
import { parseDate } from './dates.js';
import { dedupeKey, nameKey, splitFio, fullName } from './people.js';
import { uid } from './ids.js';
import { prevYearId } from './years.js';

export const FIELD_LABELS = {
  fullName: 'ФИО (одной колонкой)',
  lastName: 'Фамилия',
  firstName: 'Имя',
  middleName: 'Отчество',
  className: 'Класс (например, 7A)',
  grade: 'Параллель (7–11)',
  letter: 'Буква класса',
  birthDate: 'Дата рождения',
  status: 'Статус',
  notes: 'Примечание',
  role: 'Должность',
  phone: 'Телефон',
  email: 'Email',
  subject: 'Предмет',
};

export const STUDENT_FIELDS = ['fullName', 'lastName', 'firstName', 'middleName', 'className', 'grade', 'letter', 'birthDate', 'status', 'notes'];
export const STAFF_FIELDS = ['fullName', 'lastName', 'firstName', 'middleName', 'role', 'className', 'phone', 'email', 'subject', 'notes'];

export function normHeader(h) {
  return String(h ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
}

const ALIASES = {
  fullName: ['фио', 'фамилияимяотчество', 'фамилияимя', 'ученик', 'учащийся', 'обучающийся', 'сотрудник', 'fullname', 'student', 'name', 'fio', 'фиоученика'],
  lastName: ['фамилия', 'lastname', 'surname', 'familyname'],
  firstName: ['имя', 'firstname', 'givenname'],
  middleName: ['отчество', 'middlename', 'patronymic'],
  className: ['класс', 'class', 'classname', 'группа'],
  grade: ['параллель', 'grade'],
  letter: ['буква', 'литера', 'letter'],
  birthDate: ['датарождения', 'дата', 'др', 'рождения', 'birthdate', 'birthday', 'dob', 'birth'],
  status: ['статус', 'status'],
  notes: ['примечание', 'примечания', 'комментарий', 'заметки', 'notes', 'comment', 'note'],
  role: ['должность', 'роль', 'role', 'position', 'тип'],
  phone: ['телефон', 'тел', 'phone', 'mobile'],
  email: ['email', 'почта', 'эпочта', 'mail', 'емейл'],
  subject: ['предмет', 'subject'],
};
const LOOKUP = new Map();
for (const [field, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP.set(a, field);

export function guessField(header) {
  return LOOKUP.get(normHeader(header)) || '';
}

// Автоподбор сопоставления колонок. Возвращает массив полей (или '' — не импортировать).
export function autoMap(headers) {
  const used = new Set();
  const map = headers.map((h) => {
    const f = guessField(h);
    if (!f || used.has(f)) return '';
    used.add(f);
    return f;
  });
  return map;
}

export function hasRecognizedHeader(row) {
  return row.some((h) => guessField(h));
}

export function rowsToRecords(rows, mapping) {
  return rows.map((r) => {
    const o = {};
    mapping.forEach((f, i) => {
      if (f && r[i] !== undefined) o[f] = r[i];
    });
    return o;
  });
}

// JSON-объект с произвольными ключами → запись с каноническими полями.
export function canonicalize(obj) {
  if (typeof obj === 'string') return { fullName: obj };
  const o = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const f = guessField(k);
    if (f && o[f] === undefined && v !== null && typeof v !== 'object') o[f] = String(v);
  }
  return o;
}

export function parseJsonImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Файл не является корректным JSON: ${e.message}` };
  }
  if (data && data.format === 'lyceum-registry') return { ok: true, type: 'full', data };
  const list = (v) => (Array.isArray(v) ? v : []);
  if (Array.isArray(data)) return { ok: true, type: 'tables', students: data.map(canonicalize), staff: [] };
  if (data && typeof data === 'object') {
    const students = list(data.students || data.ученики).map(canonicalize);
    const teachers = list(data.teachers || data.учителя).map((x) => ({ ...canonicalize(x), role: 'teacher' }));
    const tutors = list(data.tutors || data.воспитатели).map((x) => ({ ...canonicalize(x), role: 'tutor' }));
    const staff = [...teachers, ...tutors, ...list(data.staff || data.персонал).map(canonicalize)];
    if (students.length || staff.length) return { ok: true, type: 'tables', students, staff };
  }
  return { ok: false, error: 'Не удалось распознать структуру JSON: ожидается массив учеников, объект { students, teachers, tutors } или полная резервная копия.' };
}

const clean = (v) => String(v ?? '').trim().replace(/^'([=@+-])/, '$1').replace(/\s+/g, ' ');

function readName(rec) {
  let { lastName, firstName, middleName } = rec;
  lastName = clean(lastName);
  firstName = clean(firstName);
  middleName = clean(middleName);
  if (!lastName && !firstName && rec.fullName) return splitFio(clean(rec.fullName));
  if (rec.fullName && (!firstName || !lastName)) {
    const s = splitFio(clean(rec.fullName));
    return { lastName: lastName || s.lastName, firstName: firstName || s.firstName, middleName: middleName || s.middleName };
  }
  return { lastName, firstName, middleName };
}

function readClass(rec, settings, errors) {
  const raw = clean(rec.className) || (rec.grade || rec.letter ? `${clean(rec.grade)}${clean(rec.letter)}` : '');
  if (!raw) return null;
  const parsed = parseClassName(raw, settings);
  if (!parsed) errors.push(`Класс «${raw}» не распознан (допустимо ${settings.minGrade}–${settings.maxGrade} + ${settings.letters.join('/')})`);
  return parsed;
}

class ClassEnsurer {
  constructor(state, changes, now) {
    this.state = state;
    this.changes = changes;
    this.now = now;
    this.year = state.settings.currentYearId;
    this.idx = getIndex(state);
    this.done = new Map();
  }
  ensure(p, demo) {
    const id = classId(this.year, p.grade, p.letter);
    if (this.done.has(id)) return id;
    const existing = this.idx.classes.get(id);
    if (!existing) addPut(this.changes, 'classes', makeClass(this.year, p.grade, p.letter, { demo, createdAt: this.now, updatedAt: this.now }));
    else if (existing.archived) addPut(this.changes, 'classes', { ...existing, archived: false, updatedAt: this.now });
    this.done.set(id, true);
    return id;
  }
}

function summarize(rows) {
  const s = { create: 0, update: 0, skip: 0, error: 0 };
  for (const r of rows) s[r.action]++;
  return s;
}

/**
 * Пробный прогон импорта учеников.
 * opts: { onDuplicate: 'skip' | 'update' | 'create', demo: boolean, now }
 */
export function planStudentImport(state, records, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const onDuplicate = opts.onDuplicate || 'skip';
  const demo = !!opts.demo;
  const settings = state.settings;
  const year = settings.currentYearId;
  const idx = getIndex(state);
  const changes = emptyChanges();
  const ensurer = new ClassEnsurer(state, changes, now);
  const existingByKey = new Map();
  const existingByName = new Map();
  for (const st of state.students) {
    if (st.status !== 'active') continue;
    existingByKey.set(dedupeKey(st), st);
    const k = nameKey(st);
    if (!existingByName.has(k)) existingByName.set(k, []);
    existingByName.get(k).push(st);
  }
  const seen = new Map();
  const rows = [];

  records.forEach((rec, i) => {
    const row = { n: i + 1, fio: '', className: '', birthDate: '', action: 'create', errors: [], warnings: [] };
    rows.push(row);
    const name = readName(rec);
    row.fio = fullName(name);
    if (!name.lastName || !name.firstName) row.errors.push('Нужны минимум фамилия и имя');
    const cls = readClass(rec, settings, row.errors);
    row.className = cls ? cls.name : '';
    const rawBirth = clean(rec.birthDate);
    let birthDate = null;
    if (rawBirth) {
      birthDate = parseDate(rawBirth);
      if (!birthDate) row.warnings.push(`Дата «${rawBirth}» не распознана — будет пропущена`);
    }
    row.birthDate = birthDate || '';
    const statusRaw = clean(rec.status).toLowerCase();
    let status = 'active';
    if (/выб|отчисл|left|архив/.test(statusRaw)) status = 'left';
    else if (/выпуск|окончил|graduat/.test(statusRaw)) status = 'graduated';
    if (row.errors.length) {
      row.action = 'error';
      return;
    }
    if (!cls && status === 'active') row.warnings.push('Класс не указан — ученик будет без класса');
    const person = { ...name, birthDate };
    const key = dedupeKey(person);
    const dupInFile = seen.get(key);
    seen.set(key, true);
    const existing = existingByKey.get(key);
    if (dupInFile && onDuplicate !== 'create') {
      row.action = 'skip';
      row.warnings.push('Повтор строки внутри файла — пропущено');
      return;
    }
    const sameName = (existingByName.get(nameKey(person)) || []).filter((s) => s !== existing);
    if (sameName.length) row.warnings.push('В базе есть ученик с таким же ФИО и другой/пустой датой рождения — проверьте дубликат');

    if (existing && onDuplicate !== 'create') {
      if (onDuplicate === 'skip') {
        row.action = 'skip';
        row.warnings.push('Такой ученик уже есть — пропущено');
        return;
      }
      row.action = 'update';
      addPut(changes, 'students', { ...existing, notes: clean(rec.notes) || existing.notes, updatedAt: now });
      if (cls) {
        const cid = ensurer.ensure(cls, demo);
        const enr = (idx.enrollmentsByStudent.get(existing.id) || []).find((e) => e.yearId === year);
        if (enr) {
          if (enr.classId !== cid) addPut(changes, 'enrollments', { ...enr, classId: cid, status: 'studying', moves: [...(enr.moves || []), { from: enr.classId, to: cid, date: now.slice(0, 10) }], updatedAt: now });
        } else addPut(changes, 'enrollments', makeEnrollment(year, existing.id, cid, 'studying', now));
      }
      return;
    }

    const student = {
      id: uid(),
      ...name,
      birthDate,
      status,
      graduatedYearId: status === 'graduated' ? prevYearId(year) : null,
      leftDate: status === 'left' ? now.slice(0, 10) : null,
      leftReason: '',
      notes: clean(rec.notes),
      dedupeKey: key,
      demo,
      createdAt: now,
      updatedAt: now,
    };
    addPut(changes, 'students', student);
    if (status === 'active') {
      const cid = cls ? ensurer.ensure(cls, demo) : null;
      addPut(changes, 'enrollments', makeEnrollment(year, student.id, cid, 'studying', now, demo ? 'demo' : 'import'));
    }
  });

  return { ok: true, kind: 'students', rows, summary: summarize(rows), changes };
}

function makeEnrollment(year, studentId, classIdValue, status, now, source = 'import') {
  return { id: `${year}:${studentId}`, yearId: year, studentId, classId: classIdValue, status, source, heldBack: false, moves: [], createdAt: now, updatedAt: now };
}

export function parseRole(v) {
  const s = clean(v).toLowerCase().replace(/ё/g, 'е');
  if (!s) return null;
  if (/воспит|tutor|educator/.test(s)) return 'tutor';
  if (/классн|кл\.?\s*рук|^кр$|учител|teacher|homeroom/.test(s)) return 'teacher';
  return null;
}

/** Импорт сотрудников. opts: { onDuplicate, demo, defaultRole, now } */
export function planStaffImport(state, records, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const onDuplicate = opts.onDuplicate || 'skip';
  const demo = !!opts.demo;
  const settings = state.settings;
  const year = settings.currentYearId;
  const changes = emptyChanges();
  const ensurer = new ClassEnsurer(state, changes, now);
  const existing = new Map();
  for (const s of state.staff) existing.set(`${s.role}|${nameKey(s)}`, s);
  const seen = new Set();
  const rows = [];

  records.forEach((rec, i) => {
    const row = { n: i + 1, fio: '', role: '', className: '', action: 'create', errors: [], warnings: [] };
    rows.push(row);
    const name = readName(rec);
    row.fio = fullName(name);
    if (!name.lastName || !name.firstName) row.errors.push('Нужны минимум фамилия и имя');
    const role = parseRole(rec.role) || opts.defaultRole || null;
    if (!role) row.errors.push(`Должность «${clean(rec.role)}» не распознана (классный руководитель / воспитатель)`);
    row.role = role || '';
    const cls = readClass(rec, settings, row.errors);
    row.className = cls ? cls.name : '';
    if (row.errors.length) {
      row.action = 'error';
      return;
    }
    const key = `${role}|${nameKey(name)}`;
    if (seen.has(key) && onDuplicate !== 'create') {
      row.action = 'skip';
      row.warnings.push('Повтор строки внутри файла — пропущено');
      return;
    }
    seen.add(key);
    let staff = existing.get(key);
    if (staff && onDuplicate === 'skip') {
      row.action = 'skip';
      row.warnings.push('Такой сотрудник уже есть — пропущено');
      return;
    }
    if (staff && onDuplicate !== 'create') {
      row.action = 'update';
      staff = { ...staff, phone: clean(rec.phone) || staff.phone, email: clean(rec.email) || staff.email, subject: clean(rec.subject) || staff.subject, notes: clean(rec.notes) || staff.notes, archived: false, updatedAt: now };
    } else {
      staff = { id: uid(), role, ...name, phone: clean(rec.phone), email: clean(rec.email), subject: clean(rec.subject), notes: clean(rec.notes), archived: false, demo, createdAt: now, updatedAt: now };
      existing.set(key, staff);
    }
    addPut(changes, 'staff', staff);
    if (cls) {
      const cid = ensurer.ensure(cls, demo);
      addPut(changes, 'assignments', { id: `${cid}:${role}`, yearId: year, classId: cid, role, staffId: staff.id, assignedAt: now });
    }
  });
  return { ok: true, kind: 'staff', rows, summary: summarize(rows), changes };
}
