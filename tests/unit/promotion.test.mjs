import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, seed } from './helpers.mjs';
import { yearView } from '../../js/domain/stats.js';
import { exportData, canonicalForCompare } from '../../js/domain/backup.js';
import { fullName } from '../../js/domain/people.js';

const names = (v, cls) => v.classes.find((c) => c.name === cls).students.map((s) => s.student.middleName);

test('переход 7→8→9→10→11 и выпуск 11 (архив)', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  const { repo, S } = env;
  assert.equal(yearView(S(), '2026-2027').total, 30);

  const plan = repo.previewPromotion({});
  assert.ok(plan.ok);
  assert.equal(plan.to, '2027-2028');
  assert.equal(plan.rows.length, 15);
  assert.match(plan.rows[0].text, /^7A — 2 ученика → 8A$/);
  assert.match(plan.rows[12].text, /^11A — 2 ученика → выпуск$/);
  assert.equal(plan.totals.graduates, 6);
  assert.equal(plan.totals.promoted, 24);
  assert.ok(plan.hasGraduates);
  assert.equal(S().settings.currentYearId, '2026-2027', 'предпросмотр ничего не меняет');
  assert.equal(S().years.length, 1);

  await repo.runPromotion(plan);
  assert.equal(S().settings.currentYearId, '2027-2028');
  const v2 = yearView(S(), '2027-2028');
  assert.equal(v2.total, 24, '30 − 6 выпускников');
  assert.equal(v2.classCount, 15);
  // 7A → 8A, 8A → 9A, 9A → 10A, 10A → 11A
  assert.deepEqual(names(v2, '8A'), ['7A', '7A']);
  assert.deepEqual(names(v2, '9A'), ['8A', '8A']);
  assert.deepEqual(names(v2, '10A'), ['9A', '9A']);
  assert.deepEqual(names(v2, '11A'), ['10A', '10A']);
  assert.deepEqual(names(v2, '8C'), ['7C', '7C']);
  assert.equal(v2.classes.find((c) => c.name === '7A').count, 0, '7 классы нового набора пусты');
  // выпускники — в архиве, не удалены
  const grads = S().students.filter((s) => s.status === 'graduated');
  assert.equal(grads.length, 6);
  assert.ok(grads.every((s) => s.graduatedYearId === '2026-2027'));
  // история ученика сохраняется: 7A → 8A
  const kid = S().students.find((s) => s.middleName === '7A');
  const kidEnr = S().enrollments.filter((e) => e.studentId === kid.id).map((e) => e.classId).sort();
  assert.deepEqual(kidEnr, ['2026-2027:7A', '2027-2028:8A']);

  // история: 2026–2027 показывает прежний состав, включая выпускников и руководителей
  const v1 = yearView(S(), '2026-2027');
  assert.equal(v1.total, 30);
  assert.equal(v1.classes.find((c) => c.name === '11A').count, 2);
  assert.equal(fullName(v1.classes.find((c) => c.name === '7A').teacher), 'КР7A Демо Тестовна');
  assert.equal(S().years.find((y) => y.id === '2026-2027').status, 'closed');
  // руководители перешли вместе с классом (7A → 8A), 11-е освободились
  assert.equal(fullName(v2.classes.find((c) => c.name === '8A').teacher), 'КР7A Демо Тестовна');
  assert.equal(v2.classes.find((c) => c.name === '7A').teacher, null);
  assert.ok(plan.warnings.some((w) => /Освобождаются/.test(w)));

  // ещё два перехода подряд, история не ломается
  await repo.runPromotion(repo.previewPromotion({}));
  await repo.runPromotion(repo.previewPromotion({}));
  assert.equal(S().settings.currentYearId, '2029-2030');
  assert.equal(yearView(S(), '2026-2027').total, 30);
  assert.equal(yearView(S(), '2027-2028').total, 24);
  assert.equal(yearView(S(), '2028-2029').total, 18);
  assert.equal(yearView(S(), '2029-2030').total, 12);
  assert.equal(S().years.length, 4);
  assert.equal(S().students.length, 30, 'никто не удалён');
});

test('отмена перехода возвращает базу в исходное состояние', async () => {
  const env = await makeEnv();
  await seed(env, 3);
  const { repo, S } = env;
  const canon = () => {
    const c = canonicalForCompare(exportData(S()));
    delete c.promotions; // журнал переходов хранит и отменённый переход
    delete c.settings.lastPromotionId;
    return c;
  };
  const before = canon();
  await repo.runPromotion(repo.previewPromotion({}));
  assert.notEqual(S().settings.currentYearId, '2026-2027');
  const undo = repo.previewUndo();
  assert.ok(undo.ok);
  assert.equal(undo.lostChanges, 0);
  await repo.undoPromotion();
  assert.equal(S().settings.currentYearId, '2026-2027');
  assert.deepEqual(canon(), before);
  assert.equal(repo.previewUndo().ok, false, 'повторная отмена невозможна');
  // после отмены можно перейти снова
  await repo.runPromotion(repo.previewPromotion({}));
  assert.equal(S().settings.currentYearId, '2027-2028');
});

test('отмена после правок: добавленные в новом году ученики удаляются, счётчик изменений', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  const { repo, S } = env;
  await repo.runPromotion(repo.previewPromotion({}));
  const cls7 = S().classes.find((c) => c.id === '2027-2028:7A');
  await repo.addStudent({ lastName: 'Новичок', firstName: 'Тест', classId: cls7.id });
  const old = S().students.find((s) => s.middleName === '8A'); // из 8A → 9A
  await repo.removeStudent(old.id, 'left');
  const undo = repo.previewUndo();
  assert.equal(undo.lostChanges, 2);
  assert.equal(undo.deletedStudents, 1);
  await repo.undoPromotion();
  assert.equal(S().students.find((s) => s.lastName === 'Новичок'), undefined);
  const leftEnr = S().enrollments.find((e) => e.studentId === old.id && e.yearId === '2026-2027');
  assert.equal(leftEnr.status, 'left', 'выбывший остаётся выбывшим');
  assert.equal(S().students.length, 15 - 0);
});

test('выпуск: «оставить в текущем году» и последующее оформление', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  const { repo, S } = env;
  const plan = repo.previewPromotion({ graduation: 'defer' });
  assert.match(plan.rows[12].text, /ожидают выпуска/);
  await repo.runPromotion(plan);
  assert.equal(S().students.filter((s) => s.status === 'graduated').length, 0);
  const v = yearView(S(), '2027-2028');
  assert.equal(v.pending.length, 6);
  assert.equal(v.total, 24);
  assert.equal(await repo.finalizeGraduation(), 6);
  assert.equal(S().students.filter((s) => s.status === 'graduated').length, 6);
  assert.equal(yearView(S(), '2027-2028').pending.length, 0);
});

test('второй год, пустые классы, ученик без класса, выбывшие не переносятся, режим staff=stay', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  const { repo, S } = env;
  const free = await repo.addStudent({ lastName: 'Безклассный', firstName: 'Тест' });
  const left = S().students.find((s) => s.middleName === '9B');
  await repo.removeStudent(left.id, 'left', 'переезд');
  const repeat = S().students.find((s) => s.middleName === '8C');
  const plan = repo.previewPromotion({ holdBack: [repeat.id], staffMode: 'stay' });
  assert.equal(plan.totals.held, 1);
  assert.equal(plan.totals.withoutClass, 1);
  assert.ok(plan.warnings.some((w) => /без класса/.test(w)));
  await repo.runPromotion(plan);
  const v = yearView(S(), '2027-2028');
  assert.deepEqual(names(v, '8C').sort(), ['7C', '8C'], 'второгодник остался в 8C, к нему перешёл 7C');
  assert.equal(v.unassigned.length, 1);
  assert.equal(v.unassigned[0].student.id, free.id);
  assert.equal(v.classes.find((c) => c.name === '10B').count, 0, 'выбывший не перенесён');
  assert.equal(fullName(v.classes.find((c) => c.name === '8A').teacher), 'КР8A Демо Тестовна', 'руководитель остался за 8A');
  assert.equal(fullName(v.classes.find((c) => c.name === '11C').tutor), 'ВоспитательЯ11C'.replace('Я', '') + ' Демо Тестовна');
});

test('переход нельзя выполнить дважды (защита внутри транзакции)', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  const { repo, store } = env;
  const plan = repo.previewPromotion({});
  await repo.runPromotion(plan);
  await assert.rejects(() => store.commit(plan.changes, { system: true, expectCurrentYear: plan.from }), /уже изменён/);
  assert.equal(store.state.years.length, 2);
  const again = repo.previewPromotion({});
  assert.ok(again.ok); // уже следующий год: 2027→2028
  assert.equal(again.to, '2028-2029');
});

test('пустой лицей: переход создаёт пустой год', async () => {
  const env = await makeEnv();
  const plan = env.repo.previewPromotion({});
  assert.ok(plan.ok);
  assert.ok(plan.warnings.length >= 1);
  await env.repo.runPromotion(plan);
  assert.equal(env.S().settings.currentYearId, '2027-2028');
});
