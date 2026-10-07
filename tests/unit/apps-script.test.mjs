// Проверка Code.gs без Google: скрипт выполняется в песочнице node:vm с макетами сервисов Apps Script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnv, seed } from './helpers.mjs';
import { buildSheetsPayload } from '../../js/domain/sheets-payload.js';

const CODE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../google-apps-script/Code.gs'), 'utf8');

function makeSandbox() {
  const props = {};
  const sheets = new Map();
  const triggers = [];
  const mails = [];
  const makeRange = (sh, r, c, nr, nc) => ({
    setNumberFormats: (f) => { sh.formats = f; return this; },
    setNumberFormat: () => this,
    setValues: (v) => { for (let i = 0; i < v.length; i++) for (let j = 0; j < v[i].length; j++) { sh.cells[`${r + i},${c + j}`] = v[i][j]; } sh.lastRow = Math.max(sh.lastRow, r + v.length - 1); sh.lastCol = Math.max(sh.lastCol, c + (v[0]?.length || 0) - 1); return this; },
    setFontWeight: () => this,
    setBackground: () => this,
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh.cells[`${r + i},${c + j}`] ?? '')),
  });
  const makeSheet = (name) => {
    const sh = { name, cells: {}, lastRow: 0, lastCol: 0, hidden: false, frozen: 0, formats: null };
    sh.clearContents = () => { sh.cells = {}; sh.lastRow = 0; sh.lastCol = 0; };
    sh.getRange = (r, c, nr = 1, nc = 1) => { const rg = makeRange(sh, r, c, nr, nc); for (const k of Object.keys(rg)) { const f = rg[k]; rg[k] = (...a) => { const x = f(...a); return x === undefined || x === this ? rg : x; }; } return rg; };
    sh.setFrozenRows = (n) => { sh.frozen = n; };
    sh.autoResizeColumns = () => {};
    sh.getLastColumn = () => sh.lastCol;
    sh.getLastRow = () => sh.lastRow;
    sh.hideSheet = () => { sh.hidden = true; };
    sh.isSheetHidden = () => sh.hidden;
    sh.appendRow = (row) => { sh.lastRow++; row.forEach((v, i) => (sh.cells[`${sh.lastRow},${i + 1}`] = v)); };
    sh.deleteRows = () => {};
    return sh;
  };
  const ss = { getId: () => 'SHEET123', getSheetByName: (n) => sheets.get(n) || null, insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; } };
  const sandbox = {
    console,
    Logger: { log: () => {} },
    Utilities: { getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {}, getUi: () => { throw new Error('no ui'); } },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; }, getContent: () => t }) },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1), newTrigger: (fn) => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => triggers.push({ getHandlerFunction: () => fn }) }) }) }) }) },
    MailApp: { sendEmail: (...a) => mails.push(a) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { sandbox, props, sheets, triggers, mails };
}

const call = (sb, fn, arg) => JSON.parse(vm.runInContext(`(${fn})(${JSON.stringify(arg)}).getContent()`, sb.sandbox));

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
