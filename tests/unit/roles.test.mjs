// Роли, журнал действий, отметки на сервере: настоящий Code.gs в песочнице.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, seed } from './helpers.mjs';
import { makeSandbox, call, run } from '../helpers/gas-sandbox.mjs';
import { exportData } from '../../js/domain/backup.js';
import { todayISO } from '../../js/domain/dates.js';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const ADMIN_DEV = 'a'.repeat(32);
const USER_DEV = 'u'.repeat(32);

// «Сегодня» по часовому поясу сервера (Asia/Aqtobe, +5), как на сайте в Костанае.
const kz = (shift = 0) => { const d = new Date(Date.now() + 5 * 3600000 + shift * 86400000); return d.toISOString().slice(0, 10); };

async function world({ students = 2 } = {}) {
  const sb = makeSandbox();
  const token = run(sb, 'setup()');
  const post = (o) => call(sb, 'doPost', { postData: { contents: typeof o === 'string' ? o : JSON.stringify(o) } });
  const env = await makeEnv();
  await seed(env, students);
  assert.equal(post({ type: 'live', action: 'seed', token, data: exportData(env.S()) }).ok, true);
  const grant = (dev, name, role = 'user', extra = {}) => {
    post({ type: 'access', action: 'request', deviceHash: sha(dev), name, note: '', ...extra });
    return post({ type: 'access', action: 'decide', token, id: sha(dev).slice(0, 12), decision: 'allow', role });
  };
  grant(ADMIN_DEV, 'Завуч Админова', 'admin');
  grant(USER_DEV, 'Дежурный Иванов', 'user');
  const state = () => JSON.parse(call(sb, 'doGet', { parameter: { action: 'backup', token } }).backup);
  const live = (who, action, extra = {}) => post({ type: 'live', action, ...(who === 'owner' ? { token } : { device: who === 'admin' ? ADMIN_DEV : USER_DEV }), ...extra });
  const push = (who, batches, baseRev) => live(who, 'push', { baseRev: baseRev ?? run(sb, 'getRev_()'), batches });
  const mark = (who, studentId, place, extra = {}) => push(who, [{ put: { rounds: [{ id: extra.kind && extra.kind !== 'evening' ? `${kz()}:${extra.kind}:${studentId}` : `${kz()}:${studentId}`, date: kz(), studentId, place, ...extra }] }, del: {}, clear: [], settings: {} }]);
  const audit = (extra = {}) => live('admin', 'log', extra).rows;
  return { sb, token, post, env, state, live, push, mark, audit, grant, ids: env.S().students.map((s) => s.id) };
}

test('роли: запрос с email и желаемой ролью, письмо, решение с ролью, роль в ответах', async () => {
  const w = await world();
  const r = w.post({ type: 'access', action: 'request', deviceHash: sha('n'.repeat(32)), name: 'Новая Воспитательница', note: 'Дежурю по четвергам', email: 'nv@example.com', wantRole: 'admin' });
  assert.equal(r.status, 'pending');
  const mail = w.sb.mails.at(-1);
  assert.ok(mail[2].includes('nv@example.com') && mail[2].includes('администратор'), 'в письме email и запрошенная роль');
  assert.equal(w.post({ type: 'access', action: 'request', deviceHash: sha('m'.repeat(32)), name: 'Плохой Адрес', email: 'не-почта' }).error, 'bad-email');
  assert.deepEqual(w.post({ type: 'access', action: 'status', device: ADMIN_DEV }), { ok: true, status: 'allowed', name: 'Завуч Админова', role: 'admin' });
  assert.equal(w.post({ type: 'access', action: 'status', device: USER_DEV }).role, 'user');
  // список для администратора: роль, запрошенная роль, email
  const list = w.post({ type: 'access', action: 'list', token: w.token }).requests;
  const row = list.find((x) => x.name === 'Новая Воспитательница');
  assert.deepEqual([row.status, row.role, row.wantRole, row.email], ['pending', 'user', 'admin', 'nv@example.com']);
  // me: кто я (устройство и токен)
  assert.deepEqual(w.post({ type: 'access', action: 'me', device: USER_DEV }), { ok: true, role: 'user', name: 'Дежурный Иванов', owner: false });
  assert.equal(w.post({ type: 'access', action: 'me', token: w.token }).role, 'admin');
  assert.equal(w.post({ type: 'access', action: 'me', device: 'x'.repeat(32) }).ok, false);
});

test('роли: список и решения — только администратор; роль «администратор» выдаёт и меняет только владелец', async () => {
  const w = await world();
  const req = (dev, name) => w.post({ type: 'access', action: 'request', deviceHash: sha(dev), name });
  req('p'.repeat(32), 'Просящий Один');
  const id = sha('p'.repeat(32)).slice(0, 12);
  // пользователь не видит и не решает
  assert.equal(w.post({ type: 'access', action: 'list', device: USER_DEV }).ok, false);
  assert.equal(w.post({ type: 'access', action: 'decide', device: USER_DEV, id, decision: 'allow' }).ok, false);
  // устройство-администратор видит и принимает как пользователя
  assert.equal(w.post({ type: 'access', action: 'list', device: ADMIN_DEV }).ok, true);
  assert.equal(w.post({ type: 'access', action: 'decide', device: ADMIN_DEV, id, decision: 'allow', role: 'admin' }).error, 'owner-only', 'администратора назначает только владелец');
  const ok = w.post({ type: 'access', action: 'decide', device: ADMIN_DEV, id, decision: 'allow' });
  assert.deepEqual([ok.status, ok.role], ['allowed', 'user']);
  assert.equal(w.post({ type: 'access', action: 'decide', device: ADMIN_DEV, id, decision: 'role', role: 'admin' }).error, 'owner-only');
  assert.equal(w.post({ type: 'access', action: 'decide', token: w.token, id, decision: 'role', role: 'admin' }).role, 'admin');
  // администратор-устройство не может отозвать другого администратора, владелец может
  assert.equal(w.post({ type: 'access', action: 'decide', device: ADMIN_DEV, id, decision: 'revoke' }).error, 'owner-only');
  assert.equal(w.post({ type: 'access', action: 'decide', token: w.token, id, decision: 'revoke' }).status, 'revoked');
  // отозванное устройство теряет доступ сразу
  assert.equal(w.post({ type: 'live', action: 'pull', sinceRev: -1, device: 'p'.repeat(32) }).ok, false);
});

test('журнал: события записываются на сервере, вход не чаще раза в 6 часов, читает только администратор', async () => {
  const w = await world();
  w.post({ type: 'access', action: 'request', deviceHash: sha('q'.repeat(32)), name: 'Запросивший Доступ' });
  w.post({ type: 'access', action: 'decide', token: w.token, id: sha('q'.repeat(32)).slice(0, 12), decision: 'deny' });
  for (let i = 0; i < 3; i++) w.post({ type: 'access', action: 'status', device: USER_DEV }); // три открытия подряд
  const rows = w.audit();
  const events = rows.map((r) => r[2]);
  assert.ok(events.includes('access-request') && events.includes('access-allow') && events.includes('access-deny'), `события допуска: ${events}`);
  assert.equal(events.filter((e) => e === 'login').length, 1, 'вход записан один раз, а не при каждом открытии');
  // неверный токен — один раз за 10 минут
  for (let i = 0; i < 3; i++) w.post({ type: 'access', action: 'whoami', token: 'неверный-токен-неверный-токен' });
  assert.equal(w.audit().filter((r) => r[2] === 'login-failed').length, 1);
  // фильтр по событиям и участнику; новые сверху; постраничное чтение
  assert.ok(w.live('admin', 'log', { events: ['access-deny'] }).rows.every((r) => r[2] === 'access-deny'));
  assert.ok(w.live('admin', 'log', { actor: 'Завуч' }).rows.length === 0 || w.live('admin', 'log', { actor: 'Завуч' }).rows.every((r) => r[3].includes('Завуч') || r[5].includes('Завуч')));
  const first = w.live('admin', 'log', { limit: 3 });
  assert.equal(first.rows.length, 3);
  assert.ok(first.next, 'есть продолжение');
  const second = w.live('admin', 'log', { limit: 3, before: first.next });
  assert.ok(second.rows.every((r) => r[0] < first.next));
  // пользователь журнал не читает; в журнале нет секретов устройств
  assert.equal(w.live('user', 'log').ok, false);
  assert.equal(JSON.stringify(rows).includes(USER_DEV), false, 'секрет устройства не попал в журнал');
});

test('пользователь: меняет только отметки обхода; данные без дат рождения, заметок, контактов и истории', async () => {
  const w = await world();
  // добавим «чувствительные» поля напрямую в базу
  const st = w.state();
  st.students[0].birthDate = '2012-05-05'; st.students[0].notes = 'аллергия';
  st.staff[0].phone = '+7 700 000 00 00'; st.staff[0].email = 'tutor@example.com';
  st.enrollments[0].moves = [{ from: 'x' }]; st.classes[0].notes = 'секрет класса';
  run(w.sb, `writeBackup_(openSpreadsheet_(), ${JSON.stringify(JSON.stringify(st))})`);
  const pull = w.live('user', 'pull', { sinceRev: -1 });
  assert.equal(pull.role, 'user');
  const dump = JSON.stringify(pull.data);
  for (const secret of ['2012-05-05', 'аллергия', '+7 700 000', 'tutor@example.com', 'секрет класса']) assert.equal(dump.includes(secret), false, `в данных пользователя нет «${secret}»`);
  assert.equal(pull.data.students[0].lastName, st.students[0].lastName, 'ФИО на месте — нужны для обхода');
  assert.deepEqual(pull.data.promotions, []);
  // администратор получает всё
  const adminPull = w.live('admin', 'pull', { sinceRev: -1 });
  assert.equal(adminPull.role, 'admin');
  assert.ok(JSON.stringify(adminPull.data).includes('аллергия'));
  // пользователь не может менять ничего, кроме отметок
  const sid = w.ids[0];
  assert.equal(w.push('user', [{ put: { students: [{ id: sid, lastName: 'Взлом' }] }, del: {}, clear: [], settings: {} }]).rejected, 1);
  assert.equal(w.push('user', [{ put: {}, del: { students: [sid] }, clear: [], settings: {} }]).rejected, 1);
  assert.equal(w.push('user', [{ put: {}, del: {}, clear: ['rounds'], settings: {} }]).rejected, 1);
  assert.equal(w.push('user', [{ put: {}, del: {}, clear: [], settings: { currentYearId: '2030-2031' } }]).rejected, 1);
  assert.equal(w.state().students.find((s) => s.id === sid).lastName === 'Взлом', false);
  assert.equal(w.mark('user', sid, 'sleeping').applied, 1, 'отметку обхода пользователь ставит');
  // и закрытые действия
  for (const a of ['seed', 'sheets', 'log', 'marks', 'stats', 'exportlog']) assert.equal(w.live('user', a, { data: {}, sheets: {}, from: kz(), to: kz() }).error, 'forbidden', `user: ${a}`);
  // ответ push тоже без личных данных (если база успела измениться)
  const r = w.push('user', [{ put: { rounds: [] }, del: {}, clear: [], settings: {} }], 0);
  assert.equal(JSON.stringify(r).includes('аллергия'), false);
});

test('отметки: ответственного и время ставит сервер, подделать нельзя; в ответ возвращаются подписанные записи', async () => {
  const w = await world();
  const sid = w.ids[0];
  const forged = { by: 'Директор Лицея', at: '2020-01-01T00:00:00.000Z' };
  const r = w.mark('user', sid, 'sick', { ...forged, reason: 'Температура', classId: '2026-2027:7A' });
  assert.equal(r.applied, 1);
  const rec = w.state().rounds.find((x) => x.studentId === sid);
  assert.equal(rec.by, 'Дежурный Иванов', 'by — имя из допуска, а не присланное');
  assert.ok(Date.parse(rec.at) > Date.now() - 60000, 'слишком старое время заменено серверным');
  assert.equal(r.patched.rounds[0].by, 'Дежурный Иванов', 'подпись вернулась устройству');
  // разумное время с устройства сохраняется
  const t = new Date(Date.now() - 600000).toISOString();
  w.mark('user', w.ids[1], 'sleeping', { at: t });
  assert.equal(w.state().rounds.find((x) => x.studentId === w.ids[1]).at, t);
});

test('отметки: проверка вида, id, дат и учеников; чистка старых делается на сервере и не блокирует пользователя', async () => {
  const w = await world();
  const sid = w.ids[0];
  const put = (rec, who = 'user') => w.push(who, [{ put: { rounds: [rec] }, del: {}, clear: [], settings: {} }]);
  // утро/доп: id содержит вид; несовпадение id отклоняется
  assert.equal(put({ id: `${kz()}:morning:${sid}`, date: kz(), studentId: sid, place: 'sleeping', kind: 'morning' }).applied, 1);
  assert.equal(put({ id: `${kz()}:${sid}`, date: kz(), studentId: sid, place: 'sleeping', kind: 'morning' }).rejected, 1, 'id не соответствует виду');
  assert.equal(put({ id: `${kz()}:night:${sid}`, date: kz(), studentId: sid, place: 'sleeping', kind: 'night' }).rejected, 1);
  assert.equal(put({ id: `${kz()}:${sid}`, date: kz(), studentId: sid, place: 'absent' }).applied, 1, 'место «Отсутствует» принимается');
  // окно дат: 5 дней назад и послезавтра — нельзя
  assert.equal(put({ id: `${kz(-5)}:${sid}`, date: kz(-5), studentId: sid, place: 'home' }).rejected, 1);
  assert.equal(put({ id: `${kz(2)}:${sid}`, date: kz(2), studentId: sid, place: 'home' }).rejected, 1);
  // старые отметки в базе (как у прежней версии): сервер убирает их сам при ближайшей записи
  const st = w.state();
  for (let i = 0; i < 120; i++) st.rounds.push({ id: `${kz(-9)}:old${i}`, date: kz(-9), studentId: 'old' + i, place: 'sleeping' });
  run(w.sb, `writeBackup_(openSpreadsheet_(), ${JSON.stringify(JSON.stringify(st))})`);
  assert.ok(w.state().rounds.length > 120);
  // прежний клиент присылает чистку 120 старых отметок вместе с новой — пользователю это не запрещено
  const dels = Array.from({ length: 120 }, (_, i) => `${kz(-9)}:old${i}`);
  const r = w.push('user', [{ put: { rounds: [{ id: `${kz()}:${w.ids[1]}`, date: kz(), studentId: w.ids[1], place: 'sleeping' }] }, del: { rounds: dels }, clear: [], settings: {} }]);
  assert.equal(r.applied, 1, 'чистка старых отметок не считается массовым удалением');
  assert.equal(w.state().rounds.some((x) => x.date === kz(-9)), false, 'старые отметки убраны');
  // утренние отметки хранятся 2 дня: позавчерашняя утренняя убирается, вечерняя — остаётся
  const st2 = w.state();
  st2.rounds.push({ id: `${kz(-2)}:morning:${sid}`, date: kz(-2), studentId: sid, place: 'sleeping', kind: 'morning' }, { id: `${kz(-2)}:${sid}`, date: kz(-2), studentId: sid, place: 'sleeping' });
  run(w.sb, `writeBackup_(openSpreadsheet_(), ${JSON.stringify(JSON.stringify(st2))})`);
  w.mark('user', w.ids[1], 'home');
  const left = w.state().rounds.filter((x) => x.date === kz(-2));
  assert.deepEqual(left.map((x) => x.kind || 'evening'), ['evening']);
});

test('история отметок: итоговое состояние, снятие отметки, отчёты по дням и классам, праздники, выгрузка пишется в журнал', async () => {
  const w = await world();
  const [a, b] = w.ids;
  w.mark('user', a, 'sleeping', { classId: 'C1' });
  w.mark('user', b, 'sick', { classId: 'C1', reason: 'Температура' });
  w.mark('admin', b, 'home', { classId: 'C1' }); // исправление: итог — «С дома», ответственный — Админова
  const range = { from: kz(), to: kz() };
  const m = w.live('admin', 'marks', range);
  const byStudent = Object.fromEntries(m.rows.map((r) => [r[2], r]));
  assert.equal(m.rows.length, 2);
  assert.equal(byStudent[b][4], 'home');
  assert.equal(byStudent[b][6], 'Завуч Админова');
  assert.equal(byStudent[a][6], 'Дежурный Иванов');
  // фильтры
  assert.equal(w.live('admin', 'marks', { ...range, studentId: a }).rows.length, 1);
  assert.equal(w.live('admin', 'marks', { ...range, by: 'Дежурный Иванов' }).rows.length, 1);
  assert.equal(w.live('admin', 'marks', { ...range, kind: 'morning' }).rows.length, 0);
  // снятие отметки (удаление) убирает её из итога, но история в листе остаётся
  w.push('user', [{ put: {}, del: { rounds: [`${kz()}:${a}`] }, clear: [], settings: {} }]);
  assert.equal(w.live('admin', 'marks', range).rows.length, 1);
  const sheet = w.sb.sheets.get(`_Отметки ${kz().slice(0, 4)}`);
  assert.ok(sheet.lastRow >= 5, 'в листе истории все изменения');
  // сводка: день и класс
  w.mark('user', a, 'sleeping', { classId: 'C1' });
  const s = w.live('admin', 'stats', { ...range, kind: 'evening' });
  assert.deepEqual(s.perDay, [[kz(), 1, 0, 1, 0]]);
  assert.deepEqual(s.perClass, [['C1', 1, 0, 1, 0]]);
  assert.equal(s.days, 1);
  // праздничный день из календаря в сводку не попадает
  w.push('admin', [{ put: { days: [{ id: kz(), date: kz(), holiday: true }] }, del: {}, clear: [], settings: {} }]);
  const sh = w.live('admin', 'stats', { ...range, kind: 'evening' });
  assert.deepEqual([sh.days, sh.holidays], [0, 1]);
  // выгрузка: периодом (сервер пишет сам) и с устройства (exportlog)
  w.live('admin', 'marks', { ...range, purpose: 'export', exportKind: 'round-report' });
  w.live('admin', 'exportlog', { exportKind: 'evening-round', from: kz(), to: kz(), rows: 30 });
  const exp = w.audit({ events: ['export'] });
  assert.equal(exp.length, 2);
  assert.ok(exp.every((r) => r[3].includes('Завуч')));
  assert.equal(w.live('admin', 'marks', { from: kz(), to: kz(401) }).error, 'range-too-long');
  assert.equal(w.live('admin', 'marks', { from: 'x', to: 'y' }).error, 'bad-range');
});

test('журнал: отметки пишутся агрегатом, изменения — отдельными строками; действия администратора и очистка записываются', async () => {
  const w = await world();
  const [a, b] = w.ids;
  w.push('user', [{ put: { rounds: [a, b].map((id) => ({ id: `${kz()}:${id}`, date: kz(), studentId: id, place: 'sleeping', classId: 'C1' })) }, del: {}, clear: [], settings: {} }]);
  w.mark('admin', a, 'sick');
  w.push('admin', [{ put: { students: [{ ...w.state().students[0], notes: 'правка' }] }, del: {}, clear: [], settings: {} }]);
  w.push('owner', [{ put: {}, del: {}, clear: ['rounds'], settings: {} }]);
  const rows = w.audit();
  const ev = rows.map((r) => r[2]);
  const set = rows.find((r) => r[2] === 'round-set' && r[7].includes('"set":2'));
  assert.ok(set && JSON.parse(set[7]).classes === 1, 'одна строка на пакет из двух отметок');
  const ch = rows.find((r) => r[2] === 'round-change');
  assert.deepEqual([JSON.parse(ch[7]).from, JSON.parse(ch[7]).to], ['sleeping', 'sick']);
  assert.ok(ev.includes('data') && ev.includes('clear'));
  assert.equal(rows.find((r) => r[2] === 'round-change')[3], 'Завуч Админова');
  // ни имён учеников, ни причин в журнале нет — только коды
  assert.equal(JSON.stringify(rows).includes(w.env.S().students[0].lastName), false);
});
