// Общая база: настоящий Code.gs (песочница) + несколько «устройств» (хранилище + движок createLive) в одном процессе.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, seed } from './helpers.mjs';
import { makeSandbox, call as callGas, run } from '../helpers/gas-sandbox.mjs';
import { createLive } from '../../js/services/live.js';
import { exportData, canonicalForCompare } from '../../js/domain/backup.js';
import { yearView } from '../../js/domain/stats.js';
import { applyChanges, emptyState, DATA_STORES } from '../../js/domain/state.js';

globalThis.__LYCEUM_KICK_MS__ = 3600000; // сами вызываем tick(): фоновые таймеры не мешают
globalThis.__LYCEUM_LIVE_MS__ = 3600000;
globalThis.__LYCEUM_SHEETS_MS__ = 3600000;

const ENDPOINT = 'https://script.google.com/macros/s/TEST/exec';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function server() {
  const sb = makeSandbox();
  const token = run(sb, 'setup()');
  const post = (obj) => callGas(sb, 'doPost', { postData: { contents: JSON.stringify(obj) } });
  const fetchMock = async (_url, init) => {
    if (server.offline) throw new TypeError('offline');
    const text = run(sb, `doPost(${JSON.stringify({ postData: { contents: init.body } })}).getContent()`);
    return { text: async () => text };
  };
  globalThis.fetch = fetchMock;
  server.offline = false;
  const allow = (device, name = 'Классный руководитель') => {
    post({ type: 'access', action: 'request', deviceHash: sha(device), name, note: '' });
    return post({ type: 'access', action: 'decide', token, id: sha(device).slice(0, 12), decision: 'allow' });
  };
  return { sb, token, post, allow };
}

async function device(srv, { token = '', dev, onForbidden = () => {}, onConflict = () => {} } = {}) {
  const env = await makeEnv();
  if (token) await env.repo.updateSettings({ sheetsToken: token });
  const live = createLive({ store: env.store, endpoint: ENDPOINT, getDevice: () => dev, onForbidden, onConflict });
  return { ...env, live, dev };
}

const names = (env) => env.S().students.map((s) => s.lastName).sort();
const live = (env) => env.live.status;
const canon = (env) => JSON.stringify(canonicalForCompare(exportData(env.S())));

test('общая база: первое устройство отдаёт данные, второе получает такие же', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 2);
  await a.live.tick();
  assert.equal(a.S().settings.liveRev, 1);
  assert.equal(live(a).state, 'online');

  srv.allow('b'.repeat(32));
  const b = await device(srv, { dev: 'b'.repeat(32) });
  assert.equal(b.S().students.length, 0);
  await b.live.tick();
  assert.equal(b.S().students.length, 30);
  assert.equal(b.S().settings.liveRev, 1);
  assert.equal(canon(b), canon(a), 'у второго устройства те же данные');
  a.live.stop();
  b.live.stop();
});

test('общая база: изменение одного видно другому после ближайшего опроса, и наоборот', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  srv.allow('b'.repeat(32));
  const b = await device(srv, { dev: 'b'.repeat(32) });
  await b.live.tick();

  const c7a = yearView(a.S(), a.S().settings.currentYearId).classes[0];
  await a.repo.addStudent({ lastName: 'Новиков', firstName: 'Пётр', classId: c7a.id });
  assert.equal(a.S().settings.liveOutbox.length, 1, 'изменение ждёт отправки');
  await a.live.tick();
  assert.equal(a.S().settings.liveOutbox.length, 0);
  assert.equal(a.S().settings.liveRev, 2);

  await b.live.tick();
  assert.ok(names(b).includes('Новиков'));
  assert.equal(b.S().settings.liveRev, 2);

  // второе устройство правит учителя и удаляет ученика — первое видит
  const victim = b.S().students.find((s) => s.lastName === 'Новиков');
  await b.repo.removeStudent(victim.id, 'delete');
  await b.live.tick();
  await a.live.tick();
  assert.ok(!names(a).includes('Новиков'));
  assert.equal(canon(a), canon(b));
  a.live.stop();
  b.live.stop();
});

test('общая база: серия правок до отправки уходит одним запросом; лишних скачиваний своих же правок нет', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  const cid = yearView(a.S(), a.S().settings.currentYearId).classes[0].id;
  for (const n of ['Один', 'Два', 'Три']) await a.repo.addStudent({ lastName: n, firstName: 'Тест', classId: cid });
  assert.equal(a.S().settings.liveOutbox.length, 3);
  let calls = 0;
  const f = globalThis.fetch;
  globalThis.fetch = async (...x) => { calls++; return f(...x); };
  await a.live.tick();
  assert.equal(calls, 1, 'один запрос push');
  assert.equal(a.S().settings.liveOutbox.length, 0);
  assert.equal(a.S().settings.liveRev, 2);
  // состояние сервера = состояние устройства
  const back = JSON.parse(callGas(srv.sb, 'doGet', { parameter: { action: 'backup', token: srv.token } }).backup);
  assert.deepEqual(back.students.map((s) => s.id).sort(), a.S().students.map((s) => s.id).sort());
  a.live.stop();
});

test('общая база: нет связи — правки копятся в очереди и уходят позже; очередь переживает перезапуск', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  server.offline = true;
  const cid = yearView(a.S(), a.S().settings.currentYearId).classes[0].id;
  await a.repo.addStudent({ lastName: 'Оффлайн', firstName: 'Тест', classId: cid });
  await a.live.tick();
  assert.equal(live(a).state, 'offline');
  assert.equal(a.S().settings.liveOutbox.length, 1);
  // «перезапуск»: состояние заново читается из базы устройства
  await a.store.load();
  assert.equal(a.S().settings.liveOutbox.length, 1, 'очередь хранится в той же базе, что и данные');
  server.offline = false;
  await a.live.tick();
  assert.equal(a.S().settings.liveOutbox.length, 0);
  assert.ok(JSON.parse(callGas(srv.sb, 'doGet', { parameter: { action: 'backup', token: srv.token } }).backup).students.some((s) => s.lastName === 'Оффлайн'));
  a.live.stop();
});

test('общая база: смену учебного года выполняет только первый; второй получает отказ и актуальные данные', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  srv.allow('b'.repeat(32));
  let rejected = 0;
  const b = await device(srv, { dev: 'b'.repeat(32), onConflict: (n) => { rejected += n; } });
  await b.live.tick();

  const planA = a.repo.previewPromotion({});
  const planB = b.repo.previewPromotion({});
  assert.equal(planA.ok, true);
  await a.repo.runPromotion(planA);
  await b.repo.runPromotion(planB); // у b год ещё старый — локально проходит
  await a.live.tick();
  assert.equal(a.S().settings.currentYearId, '2027-2028');
  await b.live.tick(); // сервер отклоняет пакет b: год уже сменил a
  assert.equal(rejected >= 1, true);
  assert.equal(b.S().settings.currentYearId, '2027-2028');
  assert.equal(b.S().settings.liveOutbox.length, 0);
  assert.equal(canon(a), canon(b), 'у обоих одинаковое состояние, перевод выполнен один раз');
  assert.equal(a.S().promotions.length, 1);
  a.live.stop();
  b.live.stop();
});

test('общая база: отозванное устройство получает «forbidden»; недопущенное — тоже', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  srv.allow('b'.repeat(32));
  let forbidden = 0;
  const b = await device(srv, { dev: 'b'.repeat(32), onForbidden: () => forbidden++ });
  await b.live.tick();
  assert.equal(b.S().students.length, 15);
  srv.post({ type: 'access', action: 'decide', token: srv.token, id: sha('b'.repeat(32)).slice(0, 12), decision: 'revoke' });
  await b.live.tick();
  assert.equal(forbidden, 1);
  assert.equal(live(b).state, 'forbidden');

  const stranger = await device(srv, { dev: 'c'.repeat(32), onForbidden: () => forbidden++ });
  await stranger.live.tick();
  assert.equal(forbidden, 2);
  assert.equal(stranger.S().students.length, 0, 'данные постороннему не выданы');
  for (const x of [a, b, stranger]) x.live.stop();
});

test('общая база: посетитель не может писать без допуска; неверный токен не даёт прав владельца', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  const r = srv.post({ type: 'live', action: 'push', device: 'z'.repeat(32), baseRev: 1, batches: [{ clear: ['students'], put: {}, del: {}, settings: {} }] });
  assert.equal(r.error, 'forbidden');
  const r2 = srv.post({ type: 'live', action: 'push', token: 'wrong', baseRev: 1, batches: [{ clear: ['students'], put: {}, del: {}, settings: {} }] });
  assert.equal(r2.error, 'forbidden');
  const back = JSON.parse(callGas(srv.sb, 'doGet', { parameter: { action: 'backup', token: srv.token } }).backup);
  assert.equal(back.students.length, 15);
  a.live.stop();
});

test('общая база: сервер отвергает мусорные пакеты и неизвестные разделы', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  const bad = srv.post({ type: 'live', action: 'push', token: srv.token, baseRev: 1, batches: [{ put: { students: [{ noId: true }] }, del: {}, clear: [], settings: {} }] });
  assert.equal(bad.rejected, 1);
  assert.equal(bad.applied, 0);
  const unk = srv.post({ type: 'live', action: 'push', token: srv.token, baseRev: 1, batches: [{ put: { meta: [{ id: 'x' }] }, del: {}, clear: ['meta'], settings: { sheetsToken: 'hack', currentYearId: '2099-2100' } }] });
  assert.equal(unk.applied, 1);
  const state = JSON.parse(callGas(srv.sb, 'doGet', { parameter: { action: 'backup', token: srv.token } }).backup);
  assert.equal(state.meta, undefined, 'неизвестный раздел не записан');
  assert.equal(state.settings.sheetsToken, undefined, 'локальные настройки не принимаются');
  assert.equal(state.settings.currentYearId, '2099-2100', 'общие настройки принимаются');
  a.live.stop();
});

test('общая база: перед массовым удалением сервер сохраняет копию, меню «Откатить» возвращает её', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 2);
  await a.live.tick();
  await a.repo.clearAll();
  await a.live.tick();
  assert.equal(a.S().students.length, 0);
  const emptied = JSON.parse(callGas(srv.sb, 'doGet', { parameter: { action: 'backup', token: srv.token } }).backup);
  assert.equal(emptied.students.length, 0);
  assert.equal(srv.sb.sheets.get('_Откат').hidden, true);
  const prev = JSON.parse(run(srv.sb, "(function(){var ss=openSpreadsheet_();return readChunks_(ss,'_Откат');})()"));
  assert.equal(prev.students.length, 30, 'сохранена версия до очистки');
  a.live.stop();
});

test('общая база: серверное применение пакетов совпадает с клиентским applyChanges', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 2);
  await a.live.tick();
  const cid = yearView(a.S(), a.S().settings.currentYearId).classes[2].id;
  const st = await a.repo.addStudent({ lastName: 'Сверка', firstName: 'Тест', classId: cid });
  await a.repo.moveStudent?.(st.id, yearView(a.S(), a.S().settings.currentYearId).classes[3].id);
  await a.repo.updateClassNotes?.(cid, 'заметка');
  await a.live.tick();
  const server_ = JSON.parse(callGas(srv.sb, 'doGet', { parameter: { action: 'backup', token: srv.token } }).backup);
  const mine = exportData(a.S());
  for (const s of DATA_STORES) {
    assert.deepEqual(server_[s].map((x) => x.id).sort(), mine[s].map((x) => x.id).sort(), s);
    const byId = new Map(mine[s].map((x) => [x.id, JSON.stringify(x)]));
    for (const rec of server_[s]) assert.equal(JSON.stringify(rec), byId.get(rec.id), `${s}:${rec.id}`);
  }
  // и обратный контроль: клиентский applyChanges даёт то же, что сервер
  const t = emptyState();
  applyChanges(t, { put: { students: [{ id: 'x', n: 1 }] }, del: {}, clear: [] });
  applyChanges(t, { put: { students: [{ id: 'x', n: 2 }, { id: 'y' }] }, del: { students: ['y'] }, clear: [] });
  assert.deepEqual(t.students, [{ id: 'x', n: 2 }, { id: 'y' }], 'порядок: очистка → удаление → запись (так же на сервере)');
  a.live.stop();
});

test('общая база: новое устройство с собственными данными при непустой общей базе берёт общую; свои — в резервной копии', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  srv.allow('b'.repeat(32));
  const b = await device(srv, { dev: 'b'.repeat(32) });
  await b.repo.addStudent({ lastName: 'Локальный', firstName: 'Тест', classId: yearView(b.S(), b.S().settings.currentYearId).classes[0].id });
  await b.live.tick();
  assert.ok(!names(b).includes('Локальный'));
  assert.equal(b.S().students.length, 15);
  const backups = await b.db.listBackups();
  assert.equal(backups.some((x) => x.reason === 'before-live'), true);
  a.live.stop();
  b.live.stop();
});

test('общая база: экспорт не содержит служебных полей общей базы', async () => {
  const srv = server();
  const a = await device(srv, { token: srv.token, dev: 'a'.repeat(32) });
  await seed(a, 1);
  await a.live.tick();
  const out = exportData(a.S());
  assert.equal('liveRev' in out.settings, false);
  assert.equal('liveOutbox' in out.settings, false);
  assert.equal('sheetsToken' in out.settings, false);
  a.live.stop();
});
