// Выполняет google-apps-script/Code.gs в песочнице node:vm с макетами сервисов Google (без сети и без аккаунта).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CODE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../google-apps-script/Code.gs'), 'utf8');

export function makeSandbox({ now = () => Date.now() } = {}) {
  const props = {};
  const sheets = new Map();
  const triggers = [];
  const mails = [];

  const makeSheet = (name) => {
    const sh = { name, cells: {}, lastRow: 0, lastCol: 0, hidden: false, frozen: 0, formats: null };
    const range = (r, c, nr = 1, nc = 1) => {
      const rg = {
        setNumberFormats: (f) => { sh.formats = f; return rg; },
        setNumberFormat: () => rg,
        setValues: (v) => {
          for (let i = 0; i < v.length; i++) for (let j = 0; j < v[i].length; j++) sh.cells[`${r + i},${c + j}`] = v[i][j];
          sh.lastRow = Math.max(sh.lastRow, r + v.length - 1);
          sh.lastCol = Math.max(sh.lastCol, c + (v[0]?.length || 0) - 1);
          return rg;
        },
        setValue: (v) => rg.setValues([[v]]),
        setFontWeight: () => rg,
        setBackground: () => rg,
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => sh.cells[`${r + i},${c + j}`] ?? '')),
      };
      return rg;
    };
    sh.getRange = range;
    sh.clearContents = () => { sh.cells = {}; sh.lastRow = 0; sh.lastCol = 0; };
    sh.setFrozenRows = (n) => { sh.frozen = n; };
    sh.autoResizeColumns = () => {};
    sh.getLastColumn = () => sh.lastCol;
    sh.getLastRow = () => sh.lastRow;
    sh.hideSheet = () => { sh.hidden = true; };
    sh.isSheetHidden = () => sh.hidden;
    sh.appendRow = (row) => { sh.lastRow++; row.forEach((v, i) => { sh.cells[`${sh.lastRow},${i + 1}`] = v; }); sh.lastCol = Math.max(sh.lastCol, row.length); };
    sh.deleteRow = (n) => {
      const next = {};
      for (const [k, v] of Object.entries(sh.cells)) {
        const [r, c] = k.split(',').map(Number);
        if (r < n) next[k] = v;
        else if (r > n) next[`${r - 1},${c}`] = v;
      }
      sh.cells = next;
      sh.lastRow--;
    };
    sh.deleteRows = () => {};
    return sh;
  };

  const ss = { getId: () => 'SHEET123', getSheetByName: (n) => sheets.get(n) || null, insertSheet: (n) => { const s = makeSheet(n); sheets.set(n, s); return s; } };
  const sandbox = {
    console,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now()])); } static now() { return now(); } },
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => [...crypto.createHash('sha256').update(String(text), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
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

/** Вызов doPost / doGet с JSON-аргументом; возвращает разобранный ответ. */
export const call = (sb, fn, arg) => JSON.parse(vm.runInContext(`(${fn})(${JSON.stringify(arg)}).getContent()`, sb.sandbox));
export const run = (sb, code) => vm.runInContext(code, sb.sandbox);
