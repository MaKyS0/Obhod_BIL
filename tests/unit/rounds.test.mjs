// Вечерний обход: модель, запись, хранение трёх дней, совместимость со старыми копиями, общая база.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, seed } from './helpers.mjs';
import { roundView, shiftDate, earliestRoundDate, ROUND_PLACES } from '../../js/domain/rounds.js';
import { exportData, validateBackup } from '../../js/domain/backup.js';
import { isUsableSnapshot } from '../../js/domain/live.js';
import { todayISO } from '../../js/domain/dates.js';
import { buildSheetsPayload } from '../../js/domain/sheets-payload.js';
import { makeSandbox, call as callGas, run } from '../helpers/gas-sandbox.mjs';
import { createLive } from '../../js/services/live.js';

const today = todayISO();

test('обход: четыре места, класс «готов» только когда отмечены все', async () => {
  assert.deepEqual(ROUND_PLACES.map((p) => p.label), ['Болеет', 'С дома', 'Отсутствует', 'Ночует']);
  const env = await makeEnv();
  await seed(env, 2);
  let v = roundView(env.S(), today);
  assert.equal(v.groups.length, 15);
  assert.equal(v.totals.total, 30);
  assert.equal(v.doneClasses, 0);
  const g = v.groups[0];
  await env.repo.setRound(g.students[0].student.id, today, 'sleeping');
  v = roundView(env.S(), today);
  assert.equal(v.groups[0].marked, 1);
  assert.equal(v.groups[0].done, false, 'отмечен один из двух — класс ещё серый');
  await env.repo.setRound(g.students[1].student.id, today, 'sick');
  v = roundView(env.S(), today);
  assert.equal(v.groups[0].done, true, 'отмечены все — класс зелёный');
  assert.equal(v.doneClasses, 1);
  assert.deepEqual(v.totals.byPlace, { sick: 1, home: 0, absent: 0, sleeping: 1 });
  // повторное нажатие на то же место снимает отметку
  await env.repo.setRound(g.students[1].student.id, today, null);
  assert.equal(roundView(env.S(), today).groups[0].done, false);
  // отметка на другую дату не влияет на сегодняшнюю
  assert.equal(roundView(env.S(), shiftDate(today, -1)).totals.marked, 0);
});

test('обход: групповая отметка, проверки и служебная запись (не считается правкой данных)', async () => {
  const env = await makeEnv();
  await seed(env, 3);
  const g = roundView(env.S(), today).groups[0];
  const ids = g.students.map((x) => x.student.id);
  const dirtyBefore = env.S().settings.dirtySinceSync;
  const n = await env.repo.setRounds(ids, today, 'home');
  assert.equal(n, 3);
  assert.equal(roundView(env.S(), today).groups[0].done, true);
  assert.equal(env.S().settings.dirtySinceSync, dirtyBefore, 'отметки обхода не помечают данные «изменёнными»');
  await assert.rejects(() => env.repo.setRound(ids[0], today, 'гуляет'), /Неизвестное место/);
  await assert.rejects(() => env.repo.setRound(ids[0], shiftDate(today, 1), 'home'), /только сегодняшний/);
  await assert.rejects(() => env.repo.setRound(ids[0], shiftDate(today, -5), 'home'), /только сегодняшний/);
  await assert.rejects(() => env.repo.setRound('нет-такого', today, 'home'), /не найден/);
  assert.equal(await env.repo.setRound(ids[0], today, 'home'), 1, 'повтор того же места — запись идемпотентна');
  assert.equal(env.S().rounds.length, 3);
});

test('обход: отметки старше трёх дней удаляются сами, чтобы база оставалась лёгкой', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  const sid = env.S().students[0].id;
  const old = shiftDate(today, -6);
  await env.store.commit({ put: { rounds: [{ id: `${old}:${sid}`, date: old, studentId: sid, classId: null, place: 'home', updatedAt: '2020-01-01' }] }, del: {} }, { system: true });
  assert.equal(env.S().rounds.length, 1);
  await env.repo.setRound(sid, shiftDate(today, -2), 'sick');
  assert.equal(env.S().rounds.some((r) => r.date === old), false, 'старая отметка удалена');
  assert.equal(env.S().rounds.length, 1);
  assert.equal(earliestRoundDate(today), shiftDate(today, -2));
});

test('обход: экспорт содержит отметки; старые копии без раздела «rounds» принимаются', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  await env.repo.setRound(env.S().students[0].id, today, 'sleeping');
  const data = exportData(env.S());
  assert.equal(data.rounds.length, 1);
  assert.equal(validateBackup(data).ok, true);
  const legacy = { ...data };
  delete legacy.rounds;
  assert.equal(validateBackup(legacy).ok, true, 'копия без обхода — не ошибка');
  assert.equal(isUsableSnapshot(legacy), true, 'старая общая база без обхода принимается');
  await env.repo.restoreBackup(legacy);
  assert.equal(env.S().rounds.length, 0);
  assert.equal(env.S().students.length, data.students.length);
});

test('обход: лист «Вечерний обход» в таблице — по классам, с пометкой «не отмечен»', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  const g = roundView(env.S(), today).groups[0];
  await env.repo.setRound(g.students[0].student.id, today, 'sick');
  const sheet = buildSheetsPayload(env.S()).sheets['Вечерний обход'];
  assert.deepEqual(sheet.header, ['Дата', 'Время', 'Класс', 'Ученик', 'Где', 'Причина', 'Ответственный']);
  assert.equal(sheet.rows.length, 30);
  assert.equal(sheet.rows.filter((r) => r[4] === 'Болеет').length, 1);
  assert.equal(sheet.rows.filter((r) => r[4] === 'не отмечен').length, 29);
});

test('обход + общая база: отметка одного видна другому; сервер принимает раздел «rounds»', async () => {
  globalThis.__LYCEUM_KICK_MS__ = 3600000;
  globalThis.__LYCEUM_LIVE_MS__ = 3600000;
  const sb = makeSandbox();
  const token = run(sb, 'setup()');
  globalThis.fetch = async (_u, init) => ({ text: async () => run(sb, `doPost(${JSON.stringify({ postData: { contents: init.body } })}).getContent()`) });
  const mk = async (tokenValue, dev) => {
    const env = await makeEnv();
    if (tokenValue) await env.repo.updateSettings({ sheetsToken: tokenValue });
    return { ...env, live: createLive({ store: env.store, endpoint: 'https://x/exec', getDevice: () => dev }) };
  };
  const a = await mk(token, 'a'.repeat(32));
  await seed(a, 2);
  await a.live.tick();
  const hash = (await import('node:crypto')).createHash('sha256').update('b'.repeat(32)).digest('hex');
  callGas(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'access', action: 'request', deviceHash: hash, name: 'Воспитатель', note: '' }) } });
  callGas(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'access', action: 'decide', token, id: hash.slice(0, 12), decision: 'allow', role: 'admin' }) } });
  const b = await mk('', 'b'.repeat(32));
  await b.live.tick();
  assert.equal(b.S().students.length, 30);

  const g = roundView(b.S(), today).groups[0];
  await b.repo.setRounds(g.students.map((x) => x.student.id), today, 'sleeping');
  await b.live.tick();
  await a.live.tick();
  assert.equal(roundView(a.S(), today).groups[0].done, true, 'у первого устройства класс стал зелёным');
  assert.equal(a.S().rounds.length, 2);
  // сервер хранит раздел «rounds»
  const server = JSON.parse(callGas(sb, 'doGet', { parameter: { action: 'backup', token } }).backup);
  assert.equal(server.rounds.length, 2);
  a.live.stop();
  b.live.stop();
});

test('обход + сервер: общая база, созданная до появления обхода, принимает отметки', async () => {
  const sb = makeSandbox();
  const token = run(sb, 'setup()');
  const env = await makeEnv();
  await seed(env, 1);
  const legacy = exportData(env.S());
  delete legacy.rounds;
  const seedRes = callGas(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'live', action: 'seed', token, data: legacy }) } });
  assert.equal(seedRes.ok, true);
  const sid = env.S().students[0].id;
  const r = callGas(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'live', action: 'push', token, baseRev: 1, batches: [{ put: { rounds: [{ id: `${today}:${sid}`, date: today, studentId: sid, place: 'home' }] }, del: {}, clear: [], settings: {} }] }) } });
  assert.equal(r.applied, 1);
  const server = JSON.parse(callGas(sb, 'doGet', { parameter: { action: 'backup', token } }).backup);
  assert.equal(server.rounds.length, 1);
});

test('обход: причина к отметке — задать, заменить, убрать; сбрасывается при смене места; чистится и обрезается', async () => {
  const env = await makeEnv();
  await seed(env, 1);
  const sid = env.S().students[0].id;
  await assert.rejects(() => env.repo.setRoundReason(sid, today, 'Температура'), /Сначала отметьте/);
  await env.repo.setRound(sid, today, 'sick');
  await env.repo.setRoundReason(sid, today, '  Температура \n 38,5  ');
  const rec = () => env.S().rounds.find((r) => r.studentId === sid);
  assert.equal(rec().reason, 'Температура 38,5', 'пробелы и переводы строк убраны');
  assert.equal(roundView(env.S(), today).groups[0].students[0].reason, 'Температура 38,5');
  await env.repo.setRound(sid, today, 'sick'); // то же место ещё раз — причина остаётся
  assert.equal(rec().reason, 'Температура 38,5');
  await env.repo.setRound(sid, today, null);
  assert.equal(rec(), undefined, 'отметка снята вместе с причиной');
  await env.repo.setRound(sid, today, 'sick');
  await env.repo.setRoundReason(sid, today, 'х'.repeat(500));
  assert.equal(rec().reason.length, 120, 'причина не длиннее 120 знаков');
  await env.repo.setRound(sid, today, 'home');
  assert.equal(rec().reason, undefined, 'другое место — причина сброшена');
  await env.repo.setRoundReason(sid, today, 'Отпущен родителями');
  await env.repo.setRoundReason(sid, today, '');
  assert.equal('reason' in rec(), false, 'пустая строка убирает причину');
  // лист таблицы
  await env.repo.setRoundReason(sid, today, 'Выходной');
  const sheet = buildSheetsPayload(env.S()).sheets['Вечерний обход'];
  assert.equal(sheet.rows.find((r) => r[4] === 'С дома')[5], 'Выходной');
});

test('главная: «последние изменения» собираются из меток времени и склеивают серии (импорт — одна строка)', async () => {
  const { recentChanges } = await import('../../js/domain/activity.js');
  const env = await makeEnv();
  await seed(env, 2);
  const changes = recentChanges(env.S(), 10);
  assert.ok(changes.length >= 2 && changes.length <= 10);
  assert.ok(changes.some((c) => /Добавлено учеников: 30/.test(c.title)), `серия добавлений склеена: ${changes.map((c) => c.title).join(' | ')}`);
  assert.ok(changes.some((c) => /сотрудников/.test(c.title)));
  assert.ok(changes.every((c, i) => i === 0 || changes[i - 1].at >= c.at), 'свежие сверху');
  const sid = env.S().students[0].id;
  await env.repo.setRound(sid, today, 'sick');
  const after = recentChanges(env.S(), 10);
  assert.ok(after.some((c) => /Вечерний обход/.test(c.title) && /отметок: 1/.test(c.detail)));
});

test('календарь и классы: выходной день, дежурные, кабинет класса; пустой день удаляется; обход знает кабинет и воспитателя', async () => {
  const { dayInfo, normalizeDay } = await import('../../js/domain/calendar.js');
  const env = await makeEnv();
  await seed(env, 2);
  const staff = env.S().staff;
  await env.repo.setDay(today, { holiday: true, note: 'Праздник', dutyStaffIds: [staff[0].id, staff[0].id, 'нет'], dutyText: '  Охрана  ' });
  let d = dayInfo(env.S(), today);
  assert.equal(d.holiday, true);
  assert.equal(d.duty.length, 1, 'дубликаты и неизвестные сотрудники не попадают в дежурные');
  assert.ok(d.dutyLabel.includes('Охрана'));
  await env.repo.setDay(today, { holiday: false, note: '', dutyStaffIds: [], dutyText: '' });
  assert.equal(env.S().days.length, 0, 'пустой день удалён');
  assert.equal(normalizeDay(today, {}), null);
  const g = roundView(env.S(), today).groups[0];
  await env.repo.updateClass(g.id, { room: ' 230 ' });
  assert.equal(roundView(env.S(), today).groups[0].room, '230');
  assert.ok(roundView(env.S(), today).groups[0].tutor, 'воспитатель класса в обходе');
  await assert.rejects(() => env.repo.updateClass(g.id, { room: 'х'.repeat(30) }), /не длиннее/);
  assert.equal(roundView(env.S(), today).classesLeft, 15);
});

test('«заполнить как вчера»: неотмеченным ставится вчерашний статус с причиной, отмеченные и другие виды проверки не меняются', async () => {
  const { copyPlan } = await import('../../js/domain/rounds.js');
  const env = await makeEnv();
  await seed(env, 6);
  const yest = shiftDate(today, -1);
  const [a, b, c, d] = roundView(env.S(), today).groups[0].students.map((x) => x.student.id);
  await env.repo.setRound(a, yest, 'sleeping');
  await env.repo.setRound(b, yest, 'sick');
  await env.repo.setRoundReason(b, yest, 'Температура');
  await env.repo.setRound(c, yest, 'home');
  await env.repo.setRound(d, today, 'absent'); // сегодня уже отмечен — не трогаем
  await env.repo.setRound(d, yest, 'sleeping');
  assert.equal(copyPlan(env.S(), yest, today).length, 3);
  assert.equal(copyPlan(env.S(), yest, today, 'morning').length, 0, 'утренняя проверка вчера пуста');
  assert.equal(await env.repo.copyRounds(yest, today, { by: 'Анна' }), 3);
  const v = roundView(env.S(), today);
  const st = Object.fromEntries(v.groups[0].students.map((x) => [x.student.id, x]));
  assert.equal(st[a].place, 'sleeping');
  assert.deepEqual([st[b].place, st[b].reason, st[b].by], ['sick', 'Температура', 'Анна']);
  assert.equal(st[c].place, 'home');
  assert.equal(st[d].place, 'absent', 'сегодняшняя отметка сохранена');
  assert.equal(await env.repo.copyRounds(yest, today), 0, 'повтор ничего не меняет');
  await assert.rejects(env.repo.copyRounds(yest, shiftDate(today, 1)), /только сегодняшний/);
});
