// Выборки: состояние лицея на конкретный учебный год, статистика, отчёты.
import { getIndex } from './state.js';
import { compareClasses } from './classes.js';
import { fullName, ROLE_LABEL } from './people.js';
import { cmp } from './collate.js';

// Ученик «в классе» в этом году: учился или окончил из этого класса в этом году.
const COUNTED = new Set(['studying', 'graduated']);

export function yearView(state, yearId) {
  const idx = getIndex(state);
  const enrollments = idx.enrollmentsByYear.get(yearId) || [];
  const assigns = idx.assignmentsByYear.get(yearId) || [];
  const byClass = new Map();
  const unassigned = [];
  const pending = [];
  for (const e of enrollments) {
    const student = idx.students.get(e.studentId);
    if (!student) continue;
    if (e.status === 'pending-graduation') {
      pending.push({ student, enr: e });
    } else if (e.status === 'studying' && !e.classId) {
      unassigned.push({ student, enr: e });
    } else if (COUNTED.has(e.status) && e.classId) {
      let arr = byClass.get(e.classId);
      if (!arr) byClass.set(e.classId, (arr = []));
      arr.push({ student, enr: e });
    }
  }
  const staffFor = (classId, role) => {
    const a = assigns.find((x) => x.classId === classId && x.role === role);
    return a ? idx.staff.get(a.staffId) || null : null;
  };
  const classes = (idx.classesByYear.get(yearId) || [])
    .filter((c) => !c.archived || byClass.has(c.id))
    .slice()
    .sort(compareClasses)
    .map((cls) => {
      const students = (byClass.get(cls.id) || []).slice().sort((a, b) => cmp(fullName(a.student), fullName(b.student)));
      return { cls, id: cls.id, name: cls.name, grade: cls.grade, letter: cls.letter, students, count: students.length, teacher: staffFor(cls.id, 'teacher'), tutor: staffFor(cls.id, 'tutor') };
    });
  const gradesMap = new Map();
  for (const c of classes) {
    const g = gradesMap.get(c.grade) || { grade: c.grade, classCount: 0, count: 0 };
    g.classCount++;
    g.count += c.count;
    gradesMap.set(g.grade, g);
  }
  const grades = [...gradesMap.values()].sort((a, b) => a.grade - b.grade);
  const assignedStaff = (role) => new Set(assigns.filter((a) => a.role === role && idx.staff.has(a.staffId)).map((a) => a.staffId));
  return {
    yearId,
    year: idx.years.get(yearId) || null,
    classes,
    grades,
    unassigned,
    pending,
    total: classes.reduce((s, c) => s + c.count, 0),
    classCount: classes.length,
    teachersAssigned: assignedStaff('teacher').size,
    tutorsAssigned: assignedStaff('tutor').size,
    classesWithoutTeacher: classes.filter((c) => !c.teacher),
    classesWithoutTutor: classes.filter((c) => !c.tutor),
  };
}

export function staffCounts(state) {
  const active = state.staff.filter((s) => !s.archived);
  return { teachers: active.filter((s) => s.role === 'teacher').length, tutors: active.filter((s) => s.role === 'tutor').length };
}

// Отчёт по персоналу: ФИО, должность, классы, количество закреплённых классов.
export function staffReport(state, yearId, { includeArchived = false } = {}) {
  const idx = getIndex(state);
  const assigns = idx.assignmentsByYear.get(yearId) || [];
  return state.staff
    .filter((s) => includeArchived || !s.archived)
    .map((s) => {
      const classes = assigns
        .filter((a) => a.staffId === s.id)
        .map((a) => idx.classes.get(a.classId))
        .filter(Boolean)
        .sort(compareClasses)
        .map((c) => c.name);
      return { staff: s, name: fullName(s), role: s.role, roleLabel: ROLE_LABEL[s.role], classes, count: classes.length };
    })
    .sort((a, b) => (a.role === b.role ? cmp(a.name, b.name) : a.role === 'teacher' ? -1 : 1));
}

export function generalReport(view) {
  const rows = [
    ['Учебный год', view.yearId],
    ['Всего учеников', view.total],
    ['Всего классов', view.classCount],
  ];
  for (const g of view.grades) rows.push([`Учеников ${g.grade} классов`, g.count]);
  rows.push(['Классных руководителей назначено', view.teachersAssigned]);
  rows.push(['Воспитателей назначено', view.tutorsAssigned]);
  return rows;
}

// Все ученики, у которых есть запись в классе этого года (для списков и экспорта).
export function studentsOfYear(view) {
  return view.classes.flatMap((c) => c.students.map((s) => ({ ...s, cls: c.cls })));
}

// Текущий класс ученика (в текущем году) или null.
export function currentEnrollment(state, studentId, yearId) {
  const idx = getIndex(state);
  return (idx.enrollmentsByStudent.get(studentId) || []).find((e) => e.yearId === yearId) || null;
}

export function studentHistory(state, studentId) {
  const idx = getIndex(state);
  return (idx.enrollmentsByStudent.get(studentId) || [])
    .slice()
    .sort((a, b) => a.yearId.localeCompare(b.yearId))
    .map((e) => ({ enr: e, cls: e.classId ? idx.classes.get(e.classId) : null }));
}
