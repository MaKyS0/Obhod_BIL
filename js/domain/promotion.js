// Переход на новый учебный год: предпросмотр, формирование атомарного пакета изменений, отмена.
// Модуль чистый: ничего не пишет в базу, только возвращает { changes } для store.commit().
import { getIndex, emptyChanges, addPut, addDel } from './state.js';
import { allClassSlots, classId, className, compareClasses, makeClass } from './classes.js';
import { nextYearId, prevYearId, yearLabel } from './years.js';
import { uid } from './ids.js';
import { fullName } from './people.js';
import { nStudents } from './plural.js';

const ACTIVE_ENR = new Set(['studying', 'pending-graduation']);

function newEnrollment(yearId, studentId, classIdValue, status, extra, now) {
  return {
    id: `${yearId}:${studentId}`,
    yearId,
    studentId,
    classId: classIdValue,
    status,
    source: 'promotion',
    heldBack: false,
    moves: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

/**
 * options: { graduation: 'archive' | 'defer', staffMode: 'follow' | 'stay', holdBack: studentId[], now }
 */
export function planPromotion(state, options = {}) {
  const now = options.now || new Date().toISOString();
  const graduation = options.graduation === 'defer' ? 'defer' : 'archive';
  const staffMode = options.staffMode === 'stay' ? 'stay' : 'follow';
  const held = new Set(options.holdBack || []);
  const s = state.settings;
  const idx = getIndex(state);
  const from = s.currentYearId;
  const to = nextYearId(from);
  const maxGrade = s.maxGrade;

  if (idx.years.has(to)) return { ok: false, error: `Учебный год ${yearLabel(to)} уже существует. Сначала отмените последний переход.` };

  const warnings = [];
  const changes = emptyChanges();
  const fromYear = idx.years.get(from) || { id: from, start: Number(from.slice(0, 4)), status: 'active', createdAt: now, closedAt: null };

  // Новые классы: все слоты (7–11 × буквы), чтобы 7-е классы нового набора тоже существовали.
  const newClasses = new Map();
  for (const slot of allClassSlots(s)) {
    newClasses.set(`${slot.grade}${slot.letter}`, makeClass(to, slot.grade, slot.letter, { createdAt: now, updatedAt: now }));
  }
  const fromClasses = (idx.classesByYear.get(from) || []).filter((c) => !c.archived).slice().sort(compareClasses);
  for (const c of fromClasses) {
    const nc = newClasses.get(`${c.grade}${c.letter}`);
    if (nc && c.notes) nc.notes = c.notes;
  }

  const enrs = (idx.enrollmentsByYear.get(from) || []).filter((e) => ACTIVE_ENR.has(e.status) && idx.students.get(e.studentId)?.status === 'active');
  const byClass = new Map();
  const noClass = [];
  const pendingList = [];
  for (const e of enrs) {
    if (e.status === 'pending-graduation') pendingList.push(e);
    else if (!e.classId || !idx.classes.has(e.classId)) noClass.push(e);
    else {
      if (!byClass.has(e.classId)) byClass.set(e.classId, []);
      byClass.get(e.classId).push(e);
    }
  }

  const rows = [];
  const record = {
    id: uid(),
    fromYearId: from,
    toYearId: to,
    executedAt: now,
    options: { graduation, staffMode, holdBack: [...held] },
    studentsBefore: [],
    enrollmentsBefore: [],
    counts: {},
    backupId: null,
    undone: false,
    undoneAt: null,
  };
  const totals = { promoted: 0, graduates: 0, held: 0, pending: 0, withoutClass: noClass.length, newClasses: newClasses.size };

  const graduate = (e) => {
    const st = idx.students.get(e.studentId);
    record.enrollmentsBefore.push(e);
    record.studentsBefore.push(st);
    addPut(changes, 'enrollments', { ...e, status: 'graduated', updatedAt: now });
    addPut(changes, 'students', { ...st, status: 'graduated', graduatedYearId: from, updatedAt: now });
    totals.graduates++;
  };

  const classNameById = (id) => idx.classes.get(id)?.name || '?';
  const clsIdInNewYear = (grade, letter) => classId(to, grade, letter);

  for (const c of fromClasses) {
    const list = (byClass.get(c.id) || []).slice();
    const heldHere = list.filter((e) => held.has(e.studentId));
    const promotable = list.length - heldHere.length;
    const isLast = c.grade >= maxGrade;
    const targetName = isLast ? null : className(c.grade + 1, c.letter);
    for (const e of list) {
      if (held.has(e.studentId)) {
        addPut(changes, 'enrollments', newEnrollment(to, e.studentId, clsIdInNewYear(c.grade, c.letter), 'studying', { heldBack: true }, now));
        totals.held++;
      } else if (!isLast) {
        addPut(changes, 'enrollments', newEnrollment(to, e.studentId, clsIdInNewYear(c.grade + 1, c.letter), 'studying', {}, now));
        totals.promoted++;
      } else if (graduation === 'archive') {
        graduate(e);
      } else {
        addPut(changes, 'enrollments', newEnrollment(to, e.studentId, null, 'pending-graduation', {}, now));
        totals.pending++;
      }
    }
    rows.push({
      fromId: c.id,
      from: c.name,
      count: list.length,
      held: heldHere.length,
      kind: isLast ? (graduation === 'archive' ? 'graduate' : 'defer') : 'promote',
      to: isLast ? (graduation === 'archive' ? 'выпуск (архив)' : 'ожидают выпуска') : targetName,
      text: isLast
        ? `${c.name} — ${nStudents(list.length - heldHere.length)} → ${graduation === 'archive' ? 'выпуск' : 'ожидают выпуска'}`
        : `${c.name} — ${nStudents(promotable)} → ${targetName}`,
    });
  }

  for (const e of pendingList) {
    if (graduation === 'archive') graduate(e);
    else {
      addPut(changes, 'enrollments', newEnrollment(to, e.studentId, null, 'pending-graduation', {}, now));
      totals.pending++;
    }
  }
  if (pendingList.length) {
    rows.push({ fromId: null, from: 'Ожидают выпуска', count: pendingList.length, held: 0, kind: graduation === 'archive' ? 'graduate' : 'defer', to: graduation === 'archive' ? 'выпуск (архив)' : 'остаются', text: `Ожидают выпуска — ${nStudents(pendingList.length)} → ${graduation === 'archive' ? 'выпуск' : 'остаются в ожидании'}` });
  }
  for (const e of noClass) {
    addPut(changes, 'enrollments', newEnrollment(to, e.studentId, null, 'studying', {}, now));
  }
  if (noClass.length) warnings.push(`${nStudents(noClass.length)} без класса — переносятся в новый год без класса.`);
  if (!enrs.length) warnings.push('В текущем году нет учеников — будет создан пустой учебный год.');

  // Персонал.
  const released = [];
  for (const a of idx.assignmentsByYear.get(from) || []) {
    const cls = idx.classes.get(a.classId);
    const st = idx.staff.get(a.staffId);
    if (!cls || !st || st.archived) continue;
    const grade = staffMode === 'follow' ? cls.grade + 1 : cls.grade;
    if (grade > maxGrade) {
      released.push(`${fullName(st)} (${classNameById(a.classId)})`);
      continue;
    }
    const cid = clsIdInNewYear(grade, cls.letter);
    addPut(changes, 'assignments', { id: `${cid}:${a.role}`, yearId: to, classId: cid, role: a.role, staffId: a.staffId, assignedAt: now });
  }
  if (released.length) warnings.push(`Освобождаются от руководства выпускными классами: ${released.join(', ')}.`);

  addPut(changes, 'years', { ...fromYear, status: 'closed', closedAt: now });
  addPut(changes, 'years', { id: to, start: Number(to.slice(0, 4)), status: 'active', createdAt: now, closedAt: null });
  for (const c of newClasses.values()) addPut(changes, 'classes', c);

  record.counts = { promoted: totals.promoted, graduates: totals.graduates, held: totals.held, pending: totals.pending };
  addPut(changes, 'promotions', record);
  changes.settings = { currentYearId: to, lastPromotionId: record.id, changesSincePromotion: 0, dirtySinceSync: true };

  return { ok: true, from, to, graduation, staffMode, rows, warnings, totals, changes, record, hasGraduates: rows.some((r) => r.kind !== 'promote' && r.count > 0) };
}

export function canUndo(state) {
  const p = state.promotions.find((x) => x.id === state.settings.lastPromotionId);
  return !!p && !p.undone && state.settings.currentYearId === p.toYearId;
}

export function planUndo(state, now = new Date().toISOString()) {
  const s = state.settings;
  const p = state.promotions.find((x) => x.id === s.lastPromotionId);
  if (!p || p.undone) return { ok: false, error: 'Нет перехода, который можно отменить.' };
  if (s.currentYearId !== p.toYearId) return { ok: false, error: 'Текущий год уже не совпадает с годом, созданным этим переходом.' };
  const idx = getIndex(state);
  const to = p.toYearId;
  const from = p.fromYearId;
  const changes = emptyChanges();

  for (const c of idx.classesByYear.get(to) || []) addDel(changes, 'classes', c.id);
  for (const e of idx.enrollmentsByYear.get(to) || []) addDel(changes, 'enrollments', e.id);
  for (const a of idx.assignmentsByYear.get(to) || []) addDel(changes, 'assignments', a.id);
  addDel(changes, 'years', to);

  // Ученики, добавленные уже после перехода и существующие только в новом году, удаляются вместе с ним.
  let deletedStudents = 0;
  for (const st of state.students) {
    const list = idx.enrollmentsByStudent.get(st.id) || [];
    if (list.length && list.every((e) => e.yearId === to) && st.createdAt > p.executedAt) {
      addDel(changes, 'students', st.id);
      deletedStudents++;
    }
  }

  const restored = new Set();
  for (const st of p.studentsBefore) {
    addPut(changes, 'students', st);
    restored.add(st.id);
  }
  const restoredEnr = new Set();
  for (const e of p.enrollmentsBefore) {
    addPut(changes, 'enrollments', e);
    restoredEnr.add(e.id);
  }
  // Согласование: кто выпущен/выбыл уже в новом году, в старом году получает тот же статус.
  for (const e of idx.enrollmentsByYear.get(to) || []) {
    if (e.status !== 'graduated' && e.status !== 'left') continue;
    const old = idx.enrollmentsByStudent.get(e.studentId)?.find((x) => x.yearId === from);
    if (old && !restoredEnr.has(old.id) && old.status === 'studying') addPut(changes, 'enrollments', { ...old, status: e.status, updatedAt: now });
  }

  const fromYear = idx.years.get(from);
  if (fromYear) addPut(changes, 'years', { ...fromYear, status: 'active', closedAt: null });
  addPut(changes, 'promotions', { ...p, undone: true, undoneAt: now });
  changes.settings = { currentYearId: from, lastPromotionId: null, changesSincePromotion: 0, dirtySinceSync: true };
  return { ok: true, from, to, changes, lostChanges: s.changesSincePromotion, deletedStudents, promotion: p };
}

// «Оформить выпуск» для учеников, оставленных в ожидании (graduation: 'defer').
export function planFinalizeGraduation(state, now = new Date().toISOString()) {
  const idx = getIndex(state);
  const cur = state.settings.currentYearId;
  const changes = emptyChanges();
  const gradYear = prevYearId(cur);
  let count = 0;
  for (const e of idx.enrollmentsByYear.get(cur) || []) {
    if (e.status !== 'pending-graduation') continue;
    const st = idx.students.get(e.studentId);
    if (!st) continue;
    addPut(changes, 'enrollments', { ...e, status: 'graduated', updatedAt: now });
    addPut(changes, 'students', { ...st, status: 'graduated', graduatedYearId: gradYear, updatedAt: now });
    count++;
  }
  return { ok: count > 0, count, changes, error: count ? null : 'Нет учеников, ожидающих выпуска.' };
}
