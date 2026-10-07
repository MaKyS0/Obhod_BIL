// Глобальный поиск по ученикам, сотрудникам и классам.
import { getIndex } from './state.js';
import { norm, fullName } from './people.js';
import { parseClassName } from './classes.js';
import { yearView } from './stats.js';
import { cmp } from './collate.js';

const matches = (hay, tokens) => tokens.every((t) => hay.includes(t));

export function searchAll(state, query, limit = 200) {
  const q = norm(query);
  const res = { students: [], staff: [], classes: [], total: 0 };
  if (!q) return res;
  const tokens = q.split(' ');
  const idx = getIndex(state);
  const year = state.settings.currentYearId;
  const view = yearView(state, year);
  const classOf = new Map();
  for (const c of view.classes) for (const s of c.students) classOf.set(s.student.id, c);

  for (const st of state.students) {
    const c = classOf.get(st.id);
    const hay = norm(`${fullName(st)} ${c ? c.name : ''} ${st.birthDate || ''}`);
    if (matches(hay, tokens)) res.students.push({ student: st, cls: c ? c.cls : null });
  }
  res.students.sort((a, b) => cmp(fullName(a.student), fullName(b.student)));

  const assigns = idx.assignmentsByYear.get(year) || [];
  for (const s of state.staff) {
    const classes = assigns.filter((a) => a.staffId === s.id).map((a) => idx.classes.get(a.classId)?.name).filter(Boolean);
    const hay = norm(`${fullName(s)} ${classes.join(' ')} ${s.phone || ''} ${s.email || ''}`);
    if (matches(hay, tokens)) res.staff.push({ staff: s, classes });
  }
  res.staff.sort((a, b) => cmp(fullName(a.staff), fullName(b.staff)));

  const parsed = parseClassName(query, state.settings);
  for (const c of view.classes) {
    const hay = norm(`${c.name} ${c.grade} ${fullName(c.teacher)} ${fullName(c.tutor)}`);
    if ((parsed && parsed.name === c.name) || (!parsed && matches(hay, tokens))) res.classes.push(c);
  }
  res.students = res.students.slice(0, limit);
  res.total = res.students.length + res.staff.length + res.classes.length;
  return res;
}
