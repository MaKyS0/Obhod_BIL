// Общая база с ролями: устройство дежурного (user) и администратора (admin) через настоящий Code.gs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, seed } from './helpers.mjs';
import { makeSandbox, call as callGas, run } from '../helpers/gas-sandbox.mjs';
import { createLive } from '../../js/services/live.js';
import { roundView, shiftDate } from '../../js/domain/rounds.js';

globalThis.__LYCEUM_KICK_MS__ = 3600000;
globalThis.__LYCEUM_LIVE_MS__ = 3600000;
globalThis.__LYCEUM_SHEETS_MS__ = 3600000;
const ENDPOINT = 'https://script.google.com/macros/s/TEST/exec';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const kz = (shift = 0) => new Date(Date.now() + 5 * 3600000 + shift * 86400000).toISOString().slice(0, 10);

function server() {
  const sb = makeSandbox();
  const token = run(sb, 'setup()');
  const post = (obj) => callGas(sb, 'doPost', { postData: { contents: JSON.stringify(obj) } });
  globalThis.fetch = async (_u, init) => ({ text: async () => run(sb, `doPost(${JSON.stringify({ postData: { contents: init.body } })}).getContent()`) });
  const allow = (dev, name, role) => {
    post({ type: 'access', action: 'request', deviceHash: sha(dev), name, note: '' });
    return post({ type: 'access', action: 'decide', token, id: sha(dev).slice(0, 12), decision: 'allow', role });
  };
  return { sb, token, post, allow };
}
async function device(srv, { token = '', dev, role = null, onRole, canSheets = true } = {}) {
  const env = await makeEnv();
  if (token) await env.repo.updateSettings({ sheetsToken: token });
  const live = createLive({ store: env.store, endpoint: ENDPOINT, getDevice: () => dev, role, onRole, canSheets });
  return { ...env, live };
}

test('роли в общей базе: дежурный получает данные без личных полей, ставит отметку; подпись сервера доходит до обоих устройств', async () => {
  const srv = server();
  const admin = await device(srv, { token: srv.token, dev: 'a'.repeat(32), role: 'admin' });
  await seed(admin, 2);
  const st = admin.S();
  const sid = st.students[0].id;
  await admin.store.commit({ put: { students: [{ ...st.students[0], birthDate: '2012-05-05', notes: 'аллергия' }] }, del: {} });
  await admin.live.tick();
  srv.allow('u'.repeat(32), 'Дежурная Анна', 'user');
  const user = await device(srv, { dev: 'u'.repeat(32), role: 'user', canSheets: false });
  await user.live.tick();
  assert.equal(user.S().students.length, 30);
  assert.equal(JSON.stringify(user.S()).includes('аллергия'), false, 'у дежурного нет заметок и даты рождения');
  assert.equal(JSON.stringify(user.S()).includes('2012-05-05'), false);
  // отметка дежурного: локально без подписи, после отправки — с подписью сервера
  const today = kz();
  const g = roundView(user.S(), today).groups.find((x) => x.students.some((y) => y.student.id === sid));
  await user.repo.setRounds([sid], today, 'sleeping');
  assert.equal(user.S().rounds[0].by, undefined);
  await user.live.tick();
  assert.equal(user.S().settings.liveOutbox.length, 0);
  assert.equal(user.S().rounds[0].by, 'Дежурная Анна', 'подпись подставлена тихо');
  assert.ok(user.S().rounds[0].at);
  await admin.live.tick();
  const v = roundView(admin.S(), today).groups.flatMap((x) => x.students).find((x) => x.student.id === sid);
  assert.deepEqual([v.place, v.by], ['sleeping', 'Дежурная Анна'], 'администратор видит, кто отметил');
  assert.ok(g, 'класс найден');
  admin.live.stop(); user.live.stop();
});

test('роли в общей базе: дежурный не отправляет таблицы; смена роли доходит до устройства; старые отметки не чистятся устройством', async () => {
  const srv = server();
  const admin = await device(srv, { token: srv.token, dev: 'a'.repeat(32), role: 'admin' });
  await seed(admin, 2);
  await admin.live.tick();
  srv.allow('u'.repeat(32), 'Дежурный Пётр', 'admin');
  const roles = [];
  const user = await device(srv, { dev: 'u'.repeat(32), role: 'admin', onRole: (r, was) => roles.push([was, r]), canSheets: false });
  await user.live.tick();
  // владелец понижает устройство до дежурного: следующий обмен сообщает об этом
  srv.post({ type: 'access', action: 'decide', token: srv.token, id: sha('u'.repeat(32)).slice(0, 12), decision: 'role', role: 'user' });
  await user.live.tick();
  assert.deepEqual(roles, [['admin', 'user']]);
  // таблицы дежурный не шлёт (иначе сервер отвечал бы отказом)
  let sheetsCalls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => { if (JSON.parse(init.body).action === 'sheets') sheetsCalls++; return orig(u, init); };
  await user.live.sendSheetsNow();
  assert.equal(sheetsCalls, 0);
  // в общей базе устройство не удаляет старые отметки само: это делает сервер
  const sid = user.S().students[0].id;
  await user.store.commit({ put: { rounds: [{ id: `${shiftDate(kz(), -5)}:${sid}`, date: shiftDate(kz(), -5), studentId: sid, place: 'sleeping' }] }, del: {} }, { system: true, remote: true });
  await user.repo.setRounds([sid], kz(), 'sleeping');
  assert.equal(user.S().settings.liveOutbox.flatMap((b) => (b.del && b.del.rounds) || []).length, 0, 'в очереди нет удалений старых отметок');
  admin.live.stop(); user.live.stop();
});

test('утренняя и дополнительная проверки: отдельные записи, вечерняя не затрагивается', async () => {
  const srv = server();
  const admin = await device(srv, { token: srv.token, dev: 'a'.repeat(32), role: 'admin' });
  await seed(admin, 1);
  await admin.live.tick();
  const sid = admin.S().students[0].id;
  const today = kz();
  await admin.repo.setRounds([sid], today, 'sleeping');
  await admin.repo.setRounds([sid], today, 'sick', { kind: 'morning' });
  await admin.live.tick();
  assert.equal(admin.S().rounds.length, 2);
  assert.equal(roundView(admin.S(), today, 'evening').totals.byPlace.sleeping, 1);
  assert.equal(roundView(admin.S(), today, 'morning').totals.byPlace.sick, 1);
  assert.equal(roundView(admin.S(), today, 'extra').totals.marked, 0);
  assert.ok(admin.S().rounds.some((r) => r.id === `${today}:morning:${sid}` && r.kind === 'morning'));
  admin.live.stop();
});
