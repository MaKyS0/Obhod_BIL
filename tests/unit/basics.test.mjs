import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYearLabel, nextYearId, yearFromDate, yearLabel } from '../../js/domain/years.js';
import { parseDate, formatDate } from '../../js/domain/dates.js';
import { plural, nStudents } from '../../js/domain/plural.js';
import { parseClassName, compareClasses } from '../../js/domain/classes.js';
import { parseCsv, detectDelimiter, decodeBytes, stringifyCsv } from '../../js/domain/csv.js';
import { autoMap, rowsToRecords, parseJsonImport, planStudentImport, planStaffImport } from '../../js/domain/importer.js';
import { makeEnv } from './helpers.mjs';

test('учебный год: разбор и производные', () => {
  for (const v of ['2026-2027', '2026–2027', '2026—2027', '2026/2027', '2026/27', '2026-27', ' 2026 – 2027 ']) assert.equal(parseYearLabel(v), '2026-2027', v);
  for (const v of ['2026-2028', 'abc', '2026', '1999-2000', '2026-28']) assert.equal(parseYearLabel(v), null, v);
  assert.equal(parseYearLabel('2099/00'), '2099-2100');
  assert.equal(parseYearLabel('2026/28'), null);
  assert.equal(nextYearId('2026-2027'), '2027-2028');
  assert.equal(yearLabel('2026-2027'), '2026–2027');
  assert.equal(yearFromDate(new Date(2026, 6, 31)), '2025-2026');
  assert.equal(yearFromDate(new Date(2026, 7, 1)), '2026-2027');
  assert.equal(yearFromDate(new Date(2026, 9, 7)), '2026-2027');
});

test('даты', () => {
  assert.equal(parseDate('05.04.2013'), '2013-04-05');
  assert.equal(parseDate('2013-04-05'), '2013-04-05');
  assert.equal(parseDate('5.4.13'), '2013-04-05');
  assert.equal(parseDate('05/04/2013'), '2013-04-05');
  assert.equal(parseDate('41369'), '2013-04-05');
  assert.equal(parseDate('31.02.2013'), null);
  assert.equal(parseDate('мусор'), null);
  assert.equal(parseDate(''), null);
  assert.equal(formatDate('2013-04-05'), '05.04.2013');
});

test('склонение', () => {
  const f = ['ученик', 'ученика', 'учеников'];
  const exp = { 0: 2, 1: 0, 2: 1, 4: 1, 5: 2, 11: 2, 12: 2, 14: 2, 21: 0, 22: 1, 25: 2, 101: 0, 111: 2 };
  for (const [n, i] of Object.entries(exp)) assert.equal(plural(+n, f), f[i], n);
  assert.equal(nStudents(28), '28 учеников'.replace('учеников', 'учеников'));
  assert.equal(nStudents(22), '22 ученика');
});

test('названия классов', () => {
  const cases = { '7A': '7A', '7а': '7A', '7 А': '7A', '7-a': '7A', '7 «А»': '7A', '11c': '11C', '10 В': '10B', '9С': '9C' };
  for (const [src, exp] of Object.entries(cases)) assert.equal(parseClassName(src)?.name, exp, src);
  for (const bad of ['12A', '6A', '7Z', '7Б', '', 'А', '7']) assert.equal(parseClassName(bad), null, bad);
  const arr = [{ grade: 10, letter: 'A' }, { grade: 7, letter: 'C' }, { grade: 7, letter: 'A' }, { grade: 11, letter: 'B' }];
  assert.deepEqual(arr.sort(compareClasses).map((c) => c.grade + c.letter), ['7A', '7C', '10A', '11B']);
});

test('CSV: разделители, кавычки, кодировки', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  const rows = parseCsv('ФИО;Класс\r\n"Иванов; Иван";7A\r\n"Пётр ""П""";"7\nB"\r\n\r\n');
  assert.deepEqual(rows, [['ФИО', 'Класс'], ['Иванов; Иван', '7A'], ['Пётр "П"', '7\nB']]);
  // windows-1251 «Фамилия;Класс»
  const cp1251 = new Uint8Array([0xd4, 0xe0, 0xec, 0xe8, 0xeb, 0xe8, 0xff, 0x3b, 0xca, 0xeb, 0xe0, 0xf1, 0xf1]);
  assert.equal(decodeBytes(cp1251), 'Фамилия;Класс');
  const utf8bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Имя;Класс')]);
  assert.equal(decodeBytes(utf8bom), 'Имя;Класс');
  const data = [['ФИО', 'Заметка'], ['А;Б', 'a "q"'], ['=SUM(A1)', '+7 999']];
  const back = parseCsv(stringifyCsv(data));
  assert.equal(back[1][0], 'А;Б');
  assert.equal(back[1][1], 'a "q"');
  assert.equal(back[2][0], "'=SUM(A1)"); // защита от формул
  assert.equal(back[2][1], '+7 999');
});

test('импорт учеников: псевдонимы, ошибки, дубликаты', async () => {
  const env = await makeEnv();
  const table = parseCsv('Фамилия;Имя;Отчество;Класс;Дата рождения\nИванов;Иван;Иванович;7 А;05.04.2013\nПетров;Пётр;;8B;мусор\nСидоров;;;9C;\nКривой;Класс;;13Г;\nИванов;Иван;Иванович;7А;05.04.2013');
  const map = autoMap(table[0]);
  assert.deepEqual(map, ['lastName', 'firstName', 'middleName', 'className', 'birthDate']);
  const recs = rowsToRecords(table.slice(1), map);
  const plan = planStudentImport(env.S(), recs);
  assert.deepEqual(plan.summary, { create: 2, update: 0, skip: 1, error: 2 });
  assert.equal(plan.rows[1].warnings.length, 1); // дата не распознана
  assert.match(plan.rows[2].errors[0], /фамилия и имя/);
  assert.match(plan.rows[3].errors[0], /13Г/);
  await env.repo.applyImport(plan);
  assert.equal(env.S().students.length, 2);
  // повторный импорт — дубликаты пропускаются, режим update двигает, create создаёт ещё
  const again = planStudentImport(env.S(), [{ fullName: 'Иванов  иван иванович', className: '8A', birthDate: '2013-04-05' }]);
  assert.equal(again.summary.skip, 1);
  const upd = planStudentImport(env.S(), [{ fullName: 'Иванов Иван Иванович', className: '8A', birthDate: '2013-04-05' }], { onDuplicate: 'update' });
  assert.equal(upd.summary.update, 1);
  await env.repo.applyImport(upd);
  assert.equal(env.S().students.length, 2);
  const enr = env.S().enrollments.find((e) => e.classId === '2026-2027:8A');
  assert.ok(enr);
  const dup = planStudentImport(env.S(), [{ fullName: 'Иванов Иван Иванович', className: '8A', birthDate: '2013-04-05' }], { onDuplicate: 'create' });
  assert.equal(dup.summary.create, 1);
});

test('импорт: ё/е и регистр считаются дубликатом, ФИО одной колонкой', async () => {
  const env = await makeEnv();
  await env.repo.addStudent({ lastName: 'Фёдоров', firstName: 'Артём', birthDate: '2013-01-02' });
  const plan = planStudentImport(env.S(), [{ fullName: 'ФЕДОРОВ артем', birthDate: '02.01.2013' }]);
  assert.equal(plan.summary.skip, 1);
});

test('JSON: простой список и объект', () => {
  const a = parseJsonImport('[{"fio":"Иванов Иван","class":"7A","birthDate":"05.04.2013"}, "Петров Пётр"]');
  assert.equal(a.type, 'tables');
  assert.deepEqual(a.students[0], { fullName: 'Иванов Иван', className: '7A', birthDate: '05.04.2013' });
  assert.deepEqual(a.students[1], { fullName: 'Петров Пётр' });
  const b = parseJsonImport('{"students":[{"fio":"А Б"}],"teachers":[{"fio":"В Г","class":"7A"}],"tutors":[{"fio":"Д Е"}]}');
  assert.equal(b.staff.length, 2);
  assert.equal(b.staff[0].role, 'teacher');
  assert.equal(parseJsonImport('{oops').ok, false);
  assert.equal(parseJsonImport('{"a":1}').ok, false);
});

test('импорт персонала: роли и назначение на класс', async () => {
  const env = await makeEnv();
  const plan = planStaffImport(env.S(), [
    { fullName: 'Иванова Анна Петровна', role: 'Классный руководитель', className: '7A' },
    { fullName: 'Смирнов Олег Игоревич', role: 'воспитатель', className: '7А' },
    { fullName: 'Кто Тоо Тут', role: 'директор' },
  ]);
  assert.deepEqual(plan.summary, { create: 2, update: 0, skip: 0, error: 1 });
  await env.repo.applyImport(plan);
  assert.equal(env.S().staff.length, 2);
  assert.equal(env.S().assignments.length, 2);
});
