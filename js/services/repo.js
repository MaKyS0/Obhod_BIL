// Все изменения данных. Каждая операция формирует пакет изменений и атомарно применяет его через store.commit().
import { getIndex, emptyChanges, addPut, addDel, DATA_STORES, LIVE_SETTINGS } from '../domain/state.js';
import { allClassSlots, classId, makeClass, compareClasses } from '../domain/classes.js';
import { dedupeKey, fullName, nameKey } from '../domain/people.js';
import { parseDate, todayISO, nowISO } from '../domain/dates.js';
import { parseYearLabel, yearId as makeYearId, yearStart } from '../domain/years.js';
import { uid } from '../domain/ids.js';
import { validateBackup, exportData } from '../domain/backup.js';
import { planPromotion, planUndo, planFinalizeGraduation } from '../domain/promotion.js';
import { planStudentImport, planStaffImport, parseJsonImport } from '../domain/importer.js';
import { defaultSettings } from '../domain/state.js';

export class UserError extends Error {
  constructor(message, code = 'USER') {
    super(message);
    this.code = code;
  }
}

const trim = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

// Текущий учебный год и стандартные классы (7–11 × буквы), которых ещё нет в базе.
function initialChanges(settings, idx) {
  const changes = emptyChanges();
  const now = nowISO();
  const y = settings.currentYearId;
  if (!idx.years.has(y)) addPut(changes, 'years', { id: y, start: yearStart(y), status: 'active', createdAt: now, closedAt: null });
  for (const slot of allClassSlots(settings)) {
    if (!idx.classes.has(classId(y, slot.grade, slot.letter))) addPut(changes, 'classes', makeClass(y, slot.grade, slot.letter));
  }
  return changes;
}

export function createRepo(store) {
  const S = () => store.state;
  const year = () => S().settings.currentYearId;

  function currentClass(id) {
    const c = getIndex(S()).classes.get(id);
    if (!c || c.yearId !== year()) throw new UserError('Класс не найден в текущем учебном году');
    return c;
  }
  const enrollmentOf = (studentId) => (getIndex(S()).enrollmentsByStudent.get(studentId) || []).find((e) => e.yearId === year()) || null;

  function enrollmentRecord(studentId, classIdValue, status = 'studying', source = 'manual') {
    const now = nowISO();
    return { id: `${year()}:${studentId}`, yearId: year(), studentId, classId: classIdValue || null, status, source, heldBack: false, moves: [], createdAt: now, updatedAt: now };
  }

  function readStudentForm(data) {
    const lastName = trim(data.lastName);
    const firstName = trim(data.firstName);
    if (!lastName || !firstName) throw new UserError('Укажите фамилию и имя ученика');
    let birthDate = null;
    if (trim(data.birthDate)) {
      birthDate = parseDate(data.birthDate);
      if (!birthDate) throw new UserError('Дата рождения указана неверно');
      if (birthDate > todayISO()) throw new UserError('Дата рождения не может быть в будущем');
    }
    return { lastName, firstName, middleName: trim(data.middleName), birthDate, notes: trim(data.notes) };
  }

  const api = {
    // ---------- первый запуск ----------
    async initialize() {
      const s = S().settings;
      if (s.initialized && S().years.length) return;
      const changes = initialChanges(s, getIndex(S()));
      changes.settings = { initialized: true };
      await store.commit(changes, { system: true });
    },

    // ---------- ученики ----------
    findDuplicateStudent(data, exceptId = null) {
      const f = readStudentForm(data);
      const key = dedupeKey(f);
      return S().students.find((s) => s.status === 'active' && s.id !== exceptId && dedupeKey(s) === key) || null;
    },

    async addStudent(data, { force = false } = {}) {
      const f = readStudentForm(data);
      if (data.classId) currentClass(data.classId);
      if (!force && api.findDuplicateStudent(data)) throw new UserError('Ученик с такими ФИО и датой рождения уже есть', 'DUPLICATE');
      const now = nowISO();
      const student = { id: uid(), ...f, status: 'active', graduatedYearId: null, leftDate: null, leftReason: '', dedupeKey: dedupeKey(f), demo: false, createdAt: now, updatedAt: now };
      const changes = emptyChanges();
      addPut(changes, 'students', student);
      addPut(changes, 'enrollments', enrollmentRecord(student.id, data.classId || null));
      await store.commit(changes);
      return student;
    },

    async updateStudent(id, data, { force = false } = {}) {
      const st = getIndex(S()).students.get(id);
      if (!st) throw new UserError('Ученик не найден');
      const f = readStudentForm(data);
      if (!force && api.findDuplicateStudent(data, id)) throw new UserError('Другой ученик с такими ФИО и датой рождения уже есть', 'DUPLICATE');
      const changes = emptyChanges();
      addPut(changes, 'students', { ...st, ...f, dedupeKey: dedupeKey(f), updatedAt: nowISO() });
      if ('classId' in data && st.status === 'active') {
        const enr = enrollmentOf(id);
        const target = data.classId || null;
        if (target) currentClass(target);
        if (!enr) addPut(changes, 'enrollments', enrollmentRecord(id, target));
        else if (enr.classId !== target) addPut(changes, 'enrollments', { ...enr, classId: target, status: enr.status === 'pending-graduation' ? 'studying' : enr.status, moves: [...(enr.moves || []), { from: enr.classId, to: target, date: todayISO() }], updatedAt: nowISO() });
      }
      await store.commit(changes);
    },

    async moveStudent(id, toClassId) {
      const st = getIndex(S()).students.get(id);
      if (!st || st.status !== 'active') throw new UserError('Ученик не найден или уже в архиве');
      if (toClassId) currentClass(toClassId);
      const enr = enrollmentOf(id);
      const changes = emptyChanges();
      if (!enr) addPut(changes, 'enrollments', enrollmentRecord(id, toClassId || null));
      else {
        if (enr.classId === (toClassId || null)) return;
        addPut(changes, 'enrollments', { ...enr, classId: toClassId || null, status: 'studying', moves: [...(enr.moves || []), { from: enr.classId, to: toClassId || null, date: todayISO() }], updatedAt: nowISO() });
      }
      await store.commit(changes);
    },

    // mode: 'left' — отчислить (в архив), 'delete' — удалить навсегда.
    async removeStudent(id, mode = 'left', reason = '') {
      const st = getIndex(S()).students.get(id);
      if (!st) throw new UserError('Ученик не найден');
      const changes = emptyChanges();
      if (mode === 'delete') {
        addDel(changes, 'students', id);
        for (const e of getIndex(S()).enrollmentsByStudent.get(id) || []) addDel(changes, 'enrollments', e.id);
      } else {
        addPut(changes, 'students', { ...st, status: 'left', leftDate: todayISO(), leftReason: trim(reason), updatedAt: nowISO() });
        const enr = enrollmentOf(id);
        if (enr) addPut(changes, 'enrollments', { ...enr, status: 'left', updatedAt: nowISO() });
      }
      await store.commit(changes);
    },

    async restoreStudent(id, toClassId) {
      const st = getIndex(S()).students.get(id);
      if (!st || st.status === 'active') throw new UserError('Ученик уже в списке');
      if (toClassId) currentClass(toClassId);
      const changes = emptyChanges();
      addPut(changes, 'students', { ...st, status: 'active', leftDate: null, leftReason: '', graduatedYearId: null, updatedAt: nowISO() });
      const enr = enrollmentOf(id);
      addPut(changes, 'enrollments', enr ? { ...enr, classId: toClassId || null, status: 'studying', updatedAt: nowISO() } : enrollmentRecord(id, toClassId || null));
      await store.commit(changes);
    },

    // ---------- персонал ----------
    readStaffForm(data) {
      const role = data.role === 'tutor' ? 'tutor' : 'teacher';
      const lastName = trim(data.lastName);
      const firstName = trim(data.firstName);
      if (!lastName || !firstName) throw new UserError('Укажите фамилию и имя');
      return { role, lastName, firstName, middleName: trim(data.middleName), phone: trim(data.phone), email: trim(data.email), subject: trim(data.subject), notes: trim(data.notes) };
    },

    async addStaff(data) {
      const f = api.readStaffForm(data);
      const dup = S().staff.find((s) => !s.archived && s.role === f.role && nameKey(s) === nameKey(f));
      if (dup) throw new UserError('Такой сотрудник с этой должностью уже есть');
      const now = nowISO();
      const staff = { id: uid(), ...f, archived: false, demo: false, createdAt: now, updatedAt: now };
      const changes = emptyChanges();
      addPut(changes, 'staff', staff);
      if (data.classId) {
        const c = currentClass(data.classId);
        addPut(changes, 'assignments', { id: `${c.id}:${f.role}`, yearId: year(), classId: c.id, role: f.role, staffId: staff.id, assignedAt: now });
      }
      await store.commit(changes);
      return staff;
    },

    async updateStaff(id, data) {
      const st = getIndex(S()).staff.get(id);
      if (!st) throw new UserError('Сотрудник не найден');
      const f = api.readStaffForm({ ...data, role: st.role });
      await store.commit({ put: { staff: [{ ...st, ...f, role: st.role, updatedAt: nowISO() }] }, del: {} });
    },

    staffInfo(id) {
      const idx = getIndex(S());
      const all = idx.assignmentsByStaff.get(id) || [];
      const current = all.filter((a) => a.yearId === year()).map((a) => idx.classes.get(a.classId)).filter(Boolean).sort(compareClasses);
      const past = all.filter((a) => a.yearId !== year());
      return { current, past, hasPast: past.length > 0 };
    },

    // Архив: сотрудник снимается с текущих классов, но остаётся в истории.
    async archiveStaff(id) {
      const st = getIndex(S()).staff.get(id);
      if (!st) throw new UserError('Сотрудник не найден');
      const changes = emptyChanges();
      addPut(changes, 'staff', { ...st, archived: true, updatedAt: nowISO() });
      for (const a of getIndex(S()).assignmentsByStaff.get(id) || []) if (a.yearId === year()) addDel(changes, 'assignments', a.id);
      await store.commit(changes);
    },

    async restoreStaff(id) {
      const st = getIndex(S()).staff.get(id);
      if (!st) throw new UserError('Сотрудник не найден');
      await store.commit({ put: { staff: [{ ...st, archived: false, updatedAt: nowISO() }] }, del: {} });
    },

    // Удалить навсегда можно только того, кого нет в истории прошлых лет.
    async deleteStaff(id) {
      const info = api.staffInfo(id);
      if (info.hasPast) throw new UserError('Сотрудник упоминается в истории прошлых лет — его можно только архивировать', 'HAS_HISTORY');
      const changes = emptyChanges();
      addDel(changes, 'staff', id);
      for (const a of getIndex(S()).assignmentsByStaff.get(id) || []) addDel(changes, 'assignments', a.id);
      await store.commit(changes);
    },

    async assign(classIdValue, role, staffId) {
      const c = currentClass(classIdValue);
      const st = getIndex(S()).staff.get(staffId);
      if (!st || st.archived) throw new UserError('Сотрудник не найден или в архиве');
      if (st.role !== role) throw new UserError('Должность сотрудника не соответствует назначению');
      const prev = getIndex(S()).assignmentsByYear.get(year())?.find((a) => a.classId === c.id && a.role === role);
      await store.commit({ put: { assignments: [{ id: `${c.id}:${role}`, yearId: year(), classId: c.id, role, staffId, assignedAt: nowISO() }] }, del: {} });
      return prev && prev.staffId !== staffId ? getIndex(S()).staff.get(prev.staffId) : null;
    },

    async unassign(classIdValue, role) {
      const c = currentClass(classIdValue);
      await store.commit({ put: {}, del: { assignments: [`${c.id}:${role}`] } });
    },

    // ---------- классы ----------
    async addClass(grade, letter) {
      const s = S().settings;
      if (!(grade >= s.minGrade && grade <= s.maxGrade) || !s.letters.includes(letter)) throw new UserError('Недопустимый класс');
      const id = classId(year(), grade, letter);
      const ex = getIndex(S()).classes.get(id);
      if (ex && !ex.archived) throw new UserError('Такой класс уже существует');
      await store.commit({ put: { classes: [ex ? { ...ex, archived: false, updatedAt: nowISO() } : makeClass(year(), grade, letter)] }, del: {} });
    },

    async archiveClass(id) {
      const c = currentClass(id);
      const used = (getIndex(S()).enrollmentsByYear.get(year()) || []).some((e) => e.classId === id && e.status === 'studying');
      if (used) throw new UserError('В классе есть ученики. Сначала переведите их в другие классы.');
      const changes = emptyChanges();
      addPut(changes, 'classes', { ...c, archived: true, updatedAt: nowISO() });
      for (const role of ['teacher', 'tutor']) addDel(changes, 'assignments', `${id}:${role}`);
      await store.commit(changes);
    },

    async updateClassNotes(id, notes) {
      const c = currentClass(id);
      await store.commit({ put: { classes: [{ ...c, notes: trim(notes), updatedAt: nowISO() }] }, del: {} });
    },

    // ---------- переход на новый год ----------
    previewPromotion(options) {
      return planPromotion(S(), options);
    },

    async runPromotion(plan, { backup = true } = {}) {
      if (!plan || !plan.ok) throw new UserError('План перехода недействителен');
      if (backup) plan.record.backupId = await store.createBackup('before-promotion');
      await store.commit(plan.changes, { system: true, expectCurrentYear: plan.from });
      return plan;
    },

    previewUndo() {
      return planUndo(S());
    },

    async undoPromotion() {
      const plan = planUndo(S());
      if (!plan.ok) throw new UserError(plan.error);
      await store.createBackup('before-undo');
      await store.commit(plan.changes, { system: true, expectCurrentYear: plan.to });
      return plan;
    },

    async finalizeGraduation() {
      const plan = planFinalizeGraduation(S());
      if (!plan.ok) throw new UserError(plan.error);
      await store.commit(plan.changes);
      return plan.count;
    },

    // Смена учебного года вручную — только пока в базе единственный год (до первого перехода).
    async setCurrentYear(label) {
      const id = parseYearLabel(label);
      if (!id) throw new UserError('Учебный год должен быть вида 2026–2027');
      const cur = year();
      if (id === cur) return;
      if (S().years.length > 1 || S().promotions.length) throw new UserError('Учебный год можно изменить вручную только до первого перехода. Используйте «Начать новый учебный год».');
      const changes = emptyChanges();
      const rename = (x) => x.replace(cur, id);
      for (const y of S().years) {
        addDel(changes, 'years', y.id);
        addPut(changes, 'years', { ...y, id, start: yearStart(id) });
      }
      for (const c of S().classes) {
        addDel(changes, 'classes', c.id);
        addPut(changes, 'classes', { ...c, id: rename(c.id), yearId: id });
      }
      for (const e of S().enrollments) {
        addDel(changes, 'enrollments', e.id);
        addPut(changes, 'enrollments', { ...e, id: rename(e.id), yearId: id, classId: e.classId ? rename(e.classId) : null, moves: (e.moves || []).map((m) => ({ ...m, from: m.from ? rename(m.from) : null, to: m.to ? rename(m.to) : null })) });
      }
      for (const a of S().assignments) {
        addDel(changes, 'assignments', a.id);
        addPut(changes, 'assignments', { ...a, id: rename(a.id), yearId: id, classId: rename(a.classId) });
      }
      changes.settings = { currentYearId: id };
      await store.commit(changes);
    },

    // ---------- настройки ----------
    async updateSettings(patch) {
      const p = { ...patch };
      if ('lyceumName' in p) {
        p.lyceumName = trim(p.lyceumName);
        if (!p.lyceumName) throw new UserError('Название лицея не может быть пустым');
      }
      if ('sheetsUrl' in p) {
        p.sheetsUrl = trim(p.sheetsUrl);
        if (p.sheetsUrl && !/^https:\/\/script\.google(usercontent)?\.com\//.test(p.sheetsUrl)) throw new UserError('Адрес должен начинаться с https://script.google.com/');
      }
      if ('sheetsToken' in p) p.sheetsToken = trim(p.sheetsToken);
      await store.commit({ settings: p, put: {}, del: {} }, { system: true });
    },

    // ---------- импорт / восстановление ----------
    previewImport(kind, records, opts) {
      const s = S();
      return kind === 'staff' ? planStaffImport(s, records, opts) : planStudentImport(s, records, opts);
    },

    async applyImport(plan) {
      const n = plan.summary.create + plan.summary.update;
      if (!n) throw new UserError('Нет строк для импорта');
      await store.createBackup('before-import');
      await store.commit(plan.changes);
      return n;
    },

    async importDemo(json) {
      const parsed = parseJsonImport(typeof json === 'string' ? json : JSON.stringify(json));
      if (!parsed.ok) throw new UserError(parsed.error);
      const staffPlan = planStaffImport(S(), parsed.staff, { demo: true, onDuplicate: 'skip' });
      await store.commit(staffPlan.changes);
      const studPlan = planStudentImport(S(), parsed.students, { demo: true, onDuplicate: 'skip' });
      await store.commit(studPlan.changes);
      return { students: studPlan.summary.create, staff: staffPlan.summary.create };
    },

    hasDemo() {
      return S().students.some((s) => s.demo) || S().staff.some((s) => s.demo);
    },

    async deleteDemo() {
      const changes = emptyChanges();
      const idx = getIndex(S());
      for (const st of S().students) {
        if (!st.demo) continue;
        addDel(changes, 'students', st.id);
        for (const e of idx.enrollmentsByStudent.get(st.id) || []) addDel(changes, 'enrollments', e.id);
      }
      for (const st of S().staff) {
        if (!st.demo) continue;
        addDel(changes, 'staff', st.id);
        for (const a of idx.assignmentsByStaff.get(st.id) || []) addDel(changes, 'assignments', a.id);
      }
      await store.createBackup('before-clear');
      await store.commit(changes);
    },

    // Полная замена данных из резервной копии.
    async restoreBackup(data) {
      const v = validateBackup(data);
      if (!v.ok) throw new UserError(`Копия не прошла проверку: ${v.errors.slice(0, 3).join('; ')}`);
      await store.createBackup('before-restore');
      const keep = { sheetsUrl: S().settings.sheetsUrl, sheetsToken: S().settings.sheetsToken };
      const changes = { clear: [...DATA_STORES], put: {}, del: {}, settings: null };
      for (const s of DATA_STORES) changes.put[s] = data[s];
      changes.settings = { ...defaultSettings(), ...data.settings, ...(data.settings.sheetsUrl ? {} : { sheetsUrl: keep.sheetsUrl }), sheetsToken: keep.sheetsToken, initialized: true, dirtySinceSync: true, key: 'settings' };
      for (const k of LIVE_SETTINGS) delete changes.settings[k]; // служебные поля общей базы остаются как были
      await store.commit(changes, { system: true });
      await api.initialize();
    },

    async restoreFromSnapshot(backupId) {
      const b = await store.db.getBackup(backupId);
      if (!b) throw new UserError('Резервная копия не найдена');
      await api.restoreBackup(b.data);
    },

    // Полная очистка: всё, кроме настроек подключения. Перед этим — автоматическая резервная копия.
    async clearAll() {
      await store.createBackup('before-clear');
      const s = S().settings;
      const fresh = { ...defaultSettings(), lyceumName: s.lyceumName, sheetsUrl: s.sheetsUrl, sheetsToken: s.sheetsToken, autoSync: s.autoSync, includeBackupInSync: s.includeBackupInSync, dirtySinceSync: true, initialized: true, key: 'settings' };
      for (const k of LIVE_SETTINGS) delete fresh[k];
      // Очистка и создание пустого текущего года — одной транзакцией, без промежуточного «пустого» состояния.
      const changes = initialChanges(fresh, { years: new Map(), classes: new Map() });
      changes.clear = [...DATA_STORES];
      changes.settings = fresh;
      await store.commit(changes, { system: true });
    },

    exportJson() {
      return exportData(S());
    },

    fullName,
    makeYearId,
  };
  return api;
}
