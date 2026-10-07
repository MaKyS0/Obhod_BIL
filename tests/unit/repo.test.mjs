import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, seed } from './helpers.mjs';
import { yearView, staffReport, generalReport, staffCounts } from '../../js/domain/stats.js';
import { exportData, validateBackup, canonicalForCompare } from '../../js/domain/backup.js';
import { buildSheetsPayload, SHEET_NAMES, safeCell } from '../../js/domain/sheets-payload.js';
import { searchAll } from '../../js/domain/search.js';
import { UserError } from '../../js/services/repo.js';

test('первый запуск: год и 15 классов', async () => {
  const env = await makeEnv();
  const v = yearView(env.S(), '2026-2027');
  assert.equal(v.classCount, 15);
  assert.deepEqual(v.grades.map((g) => [g.grade, g.classCount]), [[7, 3], [8, 3], [9, 3], [10, 3], [11, 3]]);
  assert.equal(v.total, 0);
});

test('ученики: добавление, правка, перевод, удаление, архив, валидация', async () => {
  const env = await makeEnv();
  const { repo, S } = env;
  await assert.rejects(() => repo.addStudent({ lastName: '', firstName: 'Х' }), UserError);
  await assert.rejects(() => repo.addStudent({ lastName: 'А', firstName: 'Б', birthDate: '2090-01-01' }), /будущем/);
  const st = await repo.addStudent({ lastName: 'Тестов', firstName: 'Тест', middleName: 'Тестович', birthDate: '2013-03-04', classId: '2026-2027:7A' });
  assert.equal(yearView(S(), '2026-2027').classes[0].count, 1);
  await assert.rejects(() => repo.addStudent({ lastName: 'тестов', firstName: 'ТЕСТ', middleName: 'Тестович', birthDate: '2013-03-04' }), (e) => e.code === 'DUPLICATE');
  await repo.addStudent({ lastName: 'тестов', firstName: 'ТЕСТ', middleName: 'Тестович', birthDate: '2013-03-04' }, { force: true });
  await repo.updateStudent(st.id, { lastName: 'Тестов', firstName: 'Тест', middleName: 'Тестович', birthDate: '2013-03-05', classId: '2026-2027:7B', notes: 'заметка' });
  const v = yearView(S(), '2026-2027');
  assert.equal(v.classes.find((c) => c.name === '7A').count, 0);
  assert.equal(v.classes.find((c) => c.name === '7B').count, 1);
  assert.equal(S().students.find((s) => s.id === st.id).notes, 'заметка');
  await repo.moveStudent(st.id, '2026-2027:9C');
  assert.equal(yearView(S(), '2026-2027').classes.find((c) => c.name === '9C').count, 1);
  const enr = S().enrollments.find((e) => e.studentId === st.id);
  assert.equal(enr.moves.length, 2);
  await repo.removeStudent(st.id, 'left', 'переезд');
  assert.equal(yearView(S(), '2026-2027').classes.find((c) => c.name === '9C').count, 0);
  assert.equal(S().students.find((s) => s.id === st.id).status, 'left');
  await repo.restoreStudent(st.id, '2026-2027:9C');
  assert.equal(yearView(S(), '2026-2027').classes.find((c) => c.name === '9C').count, 1);
  await repo.removeStudent(st.id, 'delete');
  assert.equal(S().students.find((s) => s.id === st.id), undefined);
  assert.equal(S().enrollments.filter((e) => e.studentId === st.id).length, 0);
});

test('персонал: назначение, замена, снятие, удаление с предупреждением, архив', async () => {
  const env = await makeEnv();
  const { repo, S } = env;
  const a = await repo.addStaff({ role: 'teacher', lastName: 'Первый', firstName: 'Тест' });
  const b = await repo.addStaff({ role: 'teacher', lastName: 'Второй', firstName: 'Тест' });
  const t = await repo.addStaff({ role: 'tutor', lastName: 'Воспит', firstName: 'Тест' });
  await assert.rejects(() => repo.addStaff({ role: 'teacher', lastName: 'первый', firstName: 'тест' }), /уже есть/);
  assert.equal(await repo.assign('2026-2027:7A', 'teacher', a.id), null);
  await repo.assign('2026-2027:8A', 'teacher', a.id); // один человек — несколько классов допустим
  assert.equal(repo.staffInfo(a.id).current.length, 2);
  const replaced = await repo.assign('2026-2027:7A', 'teacher', b.id);
  assert.equal(replaced.id, a.id, 'прежний руководитель вытеснен');
  assert.deepEqual(repo.staffInfo(a.id).current.map((c) => c.name), ['8A']);
  await assert.rejects(() => repo.assign('2026-2027:7A', 'tutor', a.id), /Должность/);
  await repo.assign('2026-2027:7A', 'tutor', t.id);
  await repo.unassign('2026-2027:7A', 'tutor');
  assert.equal(yearView(S(), '2026-2027').classes[0].tutor, null);
  const rep = staffReport(S(), '2026-2027');
  assert.deepEqual(rep.map((r) => [r.name, r.count]), [['Второй Тест', 1], ['Первый Тест', 1], ['Воспит Тест', 0]]);
  assert.deepEqual(staffCounts(S()), { teachers: 2, tutors: 1 });
  // удаление: предупреждение о текущих классах, снятие назначений
  assert.equal(repo.staffInfo(b.id).current[0].name, '7A');
  await repo.deleteStaff(b.id);
  assert.equal(yearView(S(), '2026-2027').classes[0].teacher, null);
  await repo.archiveStaff(a.id);
  assert.equal(S().staff.find((s) => s.id === a.id).archived, true);
  assert.equal(yearView(S(), '2026-2027').classes.find((c) => c.name === '8A').teacher, null);
});

test('персонал из истории нельзя удалить навсегда, только в архив', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  await env.repo.runPromotion(env.repo.previewPromotion({}));
  const t = env.S().staff.find((s) => s.lastName === 'КР7A');
  await assert.rejects(() => env.repo.deleteStaff(t.id), (e) => e.code === 'HAS_HISTORY');
  await env.repo.archiveStaff(t.id);
  // в истории прошлого года имя сохранилось
  const v1 = yearView(env.S(), '2026-2027');
  assert.equal(v1.classes.find((c) => c.name === '7A').teacher.lastName, 'КР7A');
});

test('классы: архивировать можно только пустой', async () => {
  const env = await makeEnv();
  await env.repo.addStudent({ lastName: 'А', firstName: 'Б', classId: '2026-2027:7A' });
  await assert.rejects(() => env.repo.archiveClass('2026-2027:7A'), /есть ученики/);
  await env.repo.archiveClass('2026-2027:7B');
  assert.equal(yearView(env.S(), '2026-2027').classCount, 14);
  await env.repo.addClass(7, 'B');
  assert.equal(yearView(env.S(), '2026-2027').classCount, 15);
});

test('статистика и отчёты', async () => {
  const env = await makeEnv();
  await seed(env, 3);
  const v = yearView(env.S(), '2026-2027');
  assert.equal(v.total, 45);
  assert.equal(v.grades.reduce((s, g) => s + g.count, 0), 45);
  assert.equal(v.teachersAssigned, 15);
  const rows = generalReport(v);
  assert.deepEqual(rows[1], ['Всего учеников', 45]);
  assert.deepEqual(rows[3], ['Учеников 7 классов', 9]);
  assert.equal(v.classesWithoutTeacher.length, 0);
});

test('резервная копия: туда и обратно, проверка, очистка', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  const { repo, S } = env;
  const data = JSON.parse(JSON.stringify(exportData(S())));
  assert.equal(data.format, 'lyceum-registry');
  assert.equal(data.settings.sheetsToken, undefined, 'токен не попадает в копию');
  assert.ok(validateBackup(data).ok);
  const canon = canonicalForCompare(exportData(S()));
  await repo.clearAll();
  assert.equal(S().students.length, 0);
  assert.equal(yearView(S(), S().settings.currentYearId).classCount, 15);
  await repo.restoreBackup(data);
  assert.deepEqual(canonicalForCompare(exportData(S())), canon);
  // автоматические копии перед опасными операциями
  const list = await env.db.listBackups();
  assert.ok(list.some((b) => b.reason === 'before-clear'));
  assert.ok(list.some((b) => b.reason === 'before-restore'));
  // из снимка можно восстановиться
  const snap = list.find((b) => b.reason === 'before-restore');
  await repo.restoreFromSnapshot(snap.id);
  // повреждённые копии
  assert.equal(validateBackup({ format: 'other' }).ok, false);
  assert.equal(validateBackup({ ...data, version: 99 }).ok, false);
  const broken = JSON.parse(JSON.stringify(data));
  broken.enrollments[0].studentId = 'нет-такого';
  assert.equal(validateBackup(broken).ok, false);
  await assert.rejects(() => repo.restoreBackup(broken), /проверку/);
});

test('Google Таблицы: структура выгрузки', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  await env.repo.addStudent({ lastName: '=SUM(A1)', firstName: 'Формула', classId: '2026-2027:7A' });
  await env.repo.updateSettings({ sheetsToken: 'секрет', sheetsUrl: 'https://script.google.com/macros/s/AKfycb/exec' });
  const p = buildSheetsPayload(env.S());
  assert.equal(p.type, 'lyceum-sync');
  assert.equal(p.token, 'секрет');
  assert.deepEqual(Object.keys(p.sheets), SHEET_NAMES);
  for (const [name, sh] of Object.entries(p.sheets)) {
    for (const r of sh.rows) assert.equal(r.length, sh.header.length, `${name}: ширина строки`);
  }
  assert.equal(p.sheets['Ученики'].rows.length, 31);
  assert.equal(p.sheets['Классы'].rows.length, 15);
  assert.equal(p.sheets['Учителя'].rows.length, 15);
  assert.ok(p.sheets['Ученики'].rows.some((r) => r[1] === "'=SUM(A1)"));
  assert.equal(safeCell('-5'), '-5');
  assert.equal(safeCell('@x'), "'@x");
  assert.ok(JSON.parse(p.backup).format === 'lyceum-registry');
  assert.ok(!p.backup.includes('секрет'));
  await env.repo.runPromotion(env.repo.previewPromotion({}));
  const p2 = buildSheetsPayload(env.S());
  assert.equal(p2.sheets['Архив'].rows.length, 6, 'выпускники попали в архив');
  assert.equal(p2.sheets['История'].rows.length, 30, 'два года × 15 классов');
  assert.equal(p2.currentYear, '2027–2028');
  assert.equal(buildSheetsPayload(env.S(), { includeBackup: false }).backup, '');
});

test('глобальный поиск', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  await env.repo.addStudent({ lastName: 'Иванов', firstName: 'Иван', middleName: 'Иванович', classId: '2026-2027:9B' });
  await env.repo.addStaff({ role: 'teacher', lastName: 'Иванова', firstName: 'Анна', classId: '2026-2027:10C' });
  const r = searchAll(env.S(), 'иванов');
  assert.equal(r.students.length, 1);
  assert.equal(r.staff.length, 1);
  assert.equal(searchAll(env.S(), '7 а').classes[0].name, '7A');
  assert.equal(searchAll(env.S(), 'иванов 9b').students.length, 1);
  assert.equal(searchAll(env.S(), 'ё!ъ').total, 0);
  assert.equal(searchAll(env.S(), '').total, 0);
});

test('смена текущего года до первого перехода', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  await env.repo.setCurrentYear('2027/28');
  const v = yearView(env.S(), '2027-2028');
  assert.equal(v.total, 15);
  assert.equal(v.teachersAssigned, 15);
  assert.equal(env.S().years.length, 1);
  await env.repo.runPromotion(env.repo.previewPromotion({}));
  await assert.rejects(() => env.repo.setCurrentYear('2040-2041'), /до первого перехода/);
});

test('демо-данные помечены и удаляются', async () => {
  const env = await makeEnv();
  await env.repo.importDemo({ students: [{ fio: 'Демо Ученик А', class: '7A' }], teachers: [{ fio: 'Демо Учитель', class: '7A' }] });
  assert.ok(env.repo.hasDemo());
  assert.ok(env.S().students.every((s) => s.demo));
  await env.repo.addStudent({ lastName: 'Настоящий', firstName: 'Ученик' });
  await env.repo.deleteDemo();
  assert.equal(env.repo.hasDemo(), false);
  assert.equal(env.S().students.length, 1);
  assert.equal(env.S().assignments.length, 0);
});
