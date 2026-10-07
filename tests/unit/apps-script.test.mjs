// Проверка Code.gs без Google: скрипт выполняется в песочнице node:vm с макетами сервисов Apps Script.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, seed } from './helpers.mjs';
import { makeSandbox, call as callGas, run } from '../helpers/gas-sandbox.mjs';
import { buildSheetsPayload } from '../../js/domain/sheets-payload.js';

const vm = { runInContext: (code, sandbox) => run({ sandbox }, code) };
const call = (sb, fn, arg) => callGas(sb, fn, arg);

test('Code.gs: setup создаёт токен и ежедневный триггер, повторный запуск не меняет токен', () => {
  const sb = makeSandbox();
  const token = vm.runInContext('setup()', sb.sandbox);
  assert.equal(token, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
  assert.equal(sb.props.SHEET_ID, 'SHEET123');
  assert.equal(sb.triggers.length, 1);
  vm.runInContext('setup()', sb.sandbox);
  assert.equal(sb.triggers.length, 1, 'триггер не дублируется');
  assert.equal(sb.props.TOKEN, token);
});

test('Code.gs: doPost записывает 7 листов и скрытую резервную копию, проверяет токен', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  await env.repo.addStudent({ lastName: '=HYPERLINK("x")', firstName: 'Формула', classId: '2026-2027:7A' });
  const sb = makeSandbox();
  const token = vm.runInContext('setup()', sb.sandbox);
  await env.repo.updateSettings({ sheetsToken: token });
  const payload = buildSheetsPayload(env.S());

  const bad = call(sb, 'doPost', { postData: { contents: JSON.stringify({ ...payload, token: 'wrong' }) } });
  assert.deepEqual(bad, { ok: false, error: 'auth' });
  assert.equal(sb.sheets.size, 0, 'без токена ничего не записано');

  const ok = call(sb, 'doPost', { postData: { contents: JSON.stringify(payload) } });
  assert.equal(ok.ok, true);
  assert.equal(ok.written['Ученики'], 31);
  assert.equal(ok.written['Классы'], 15);
  for (const name of ['Ученики', 'Классы', 'Учителя', 'Воспитатели', 'Отчёт', 'Архив', 'История']) assert.ok(sb.sheets.has(name), name);
  const stud = sb.sheets.get('Ученики');
  assert.equal(stud.cells['1,1'], 'ID');
  assert.equal(stud.frozen, 1);
  const formulaCell = Object.values(stud.cells).find((v) => typeof v === 'string' && v.includes('HYPERLINK'));
  assert.equal(formulaCell.startsWith('='), true, 'апостроф снят, ячейка будет текстовой (формат @)');
  assert.ok(stud.formats.flat().includes('@'));
  // резервная копия: скрытый лист, склеивается обратно
  assert.equal(sb.sheets.get('_Резерв').hidden, true);
  const back = call(sb, 'doGet', { parameter: { action: 'backup', token } });
  assert.equal(back.ok, true);
  assert.equal(JSON.parse(back.backup).format, 'lyceum-registry');
  // статус
  const st = call(sb, 'doGet', { parameter: { token } });
  assert.equal(st.ok, true);
  assert.equal(st.counts['Ученики'], 31);
  assert.equal(call(sb, 'doGet', { parameter: { token: 'x' } }).error, 'auth');
  assert.ok(sb.sheets.has('_Журнал'));
  // повторная выгрузка перезаписывает, а не дописывает
  call(sb, 'doPost', { postData: { contents: JSON.stringify(payload) } });
  assert.equal(sb.sheets.get('Ученики').lastRow, 32);
});

test('Code.gs: до setup() запросы отклоняются; неверный формат и dailyJob', () => {
  const sb = makeSandbox();
  assert.equal(call(sb, 'doPost', { postData: { contents: '{}' } }).error, 'not-configured');
  const token = vm.runInContext('setup()', sb.sandbox);
  assert.equal(call(sb, 'doPost', { postData: { contents: JSON.stringify({ token, type: 'other' }) } }).ok, false);
  assert.equal(call(sb, 'doPost', { postData: { contents: 'не json' } }).ok, false);
  vm.runInContext('dailyJob()', sb.sandbox);
  assert.equal(sb.mails.length, 1, 'нет синхронизаций → письмо владельцу');
  assert.equal(sb.mails[0][0], 'owner@example.com');
  sb.props.LAST_SYNC = new Date().toISOString();
  vm.runInContext('dailyJob()', sb.sandbox);
  assert.equal(sb.mails.length, 1, 'свежая синхронизация → письма нет');
});

test('Code.gs: допуск посетителей — запрос, решение владельца, статус, отзыв, защита и лимиты', () => {
  let t = Date.parse('2026-10-07T12:00:00Z');
  const sb = makeSandbox({ now: () => t });
  const token = run(sb, 'setup()');
  const secret = 'секрет-устройства-1';
  const hash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex'); // deviceHash = sha256(secret), как считает сайт
  const req = (name, note, h = hash) => call(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'access', action: 'request', deviceHash: h, name, note }) } });
  const status = (s) => call(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'access', action: 'status', device: s }) } });
  const admin = (action, extra = {}, tk = token) => call(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'access', action, token: tk, ...extra }) } });

  assert.deepEqual(status(secret), { ok: true, status: 'none' });
  assert.equal(req('A', '').error, 'name-required');
  assert.equal(req('Иван Иванов', '', 'плохой-хэш').error, 'bad-device');
  const r1 = req('  Иван   Иванов ', 'Классный руководитель 9А');
  assert.deepEqual(r1, { ok: true, status: 'pending' });
  assert.equal(sb.mails.length, 1, 'владельцу ушло письмо');
  assert.ok(sb.mails[0][1].includes('Иван Иванов') && sb.mails[0][2].includes('Классный руководитель 9А'));
  assert.ok(!sb.mails[0][2].includes(token), 'токена в письме нет');
  assert.equal(sb.mails[0][0], 'owner@example.com');
  assert.equal(req('Иван Иванов', '').status, 'pending', 'повторный запрос не создаёт дубль');
  assert.equal(sb.mails.length, 1, 'и не шлёт второе письмо');
  assert.equal(status(secret).status, 'pending');
  assert.equal(status('чужой-секрет').status, 'none', 'чужое устройство статус не видит');

  // без токена — нельзя ни смотреть, ни решать
  assert.equal(admin('list', {}, 'wrong').error, 'auth');
  assert.equal(admin('decide', { id: hash.slice(0, 12), decision: 'allow' }, 'wrong').error, 'auth');
  assert.equal(status(secret).status, 'pending', 'решение без токена не применилось');
  assert.equal(call(sb, 'doPost', { postData: { contents: JSON.stringify({ type: 'access', action: 'list' }) } }).error, 'auth');

  const list = admin('list');
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].name, 'Иван Иванов');
  assert.equal(list.requests[0].id, hash.slice(0, 12));
  assert.ok(!JSON.stringify(list).includes(hash), 'полный хэш наружу не отдаётся');
  assert.equal(admin('whoami').owner, true);

  assert.equal(admin('decide', { id: 'abc', decision: 'allow' }).error, 'not-found', 'короткий id отклоняется');
  assert.equal(admin('decide', { id: list.requests[0].id, decision: 'allow' }).status, 'allowed');
  assert.equal(status(secret).status, 'allowed');
  assert.ok(!('key' in status(secret)), 'ключа данных скрипт не выдаёт');
  assert.equal(admin('decide', { id: list.requests[0].id, decision: 'revoke' }).status, 'revoked');
  assert.equal(status(secret).status, 'revoked');
  assert.equal(req('Иван Иванов', '').status, 'revoked', 'отозванный не может подать запрос заново');
  assert.equal(admin('decide', { id: list.requests[0].id, decision: 'bogus' }).error, 'bad-decision');
  assert.equal(admin('decide', { id: list.requests[0].id, decision: 'deny' }).status, 'denied');
  assert.equal(admin('decide', { id: list.requests[0].id, decision: 'delete' }).ok, true);
  assert.equal(admin('list').requests.length, 0);
  assert.equal(status(secret).status, 'none');

  // лимит запросов в час и защита от внедрения управляющих символов
  for (let i = 0; i < 20; i++) assert.equal(req(`Посетитель ${i}`, 'x\u0000\ny'.repeat(200), i.toString(16).padStart(64, '0')).ok, true);
  assert.equal(req('Лишний', '', 'f'.repeat(64)).error, 'rate-limit');
  const listed = admin('list').requests;
  assert.ok(listed.every((r) => r.note.length <= 300 && !/[\u0000-\u001f]/.test(r.note)));
  t += 2 * 3600 * 1000;
  assert.equal(req('Лишний', '', 'f'.repeat(64)).ok, true, 'через час лимит снимается');
});
