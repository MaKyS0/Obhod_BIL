/**
 * Учёт лицея — приёмник данных для Google Таблиц (Google Apps Script Web App).
 *
 * Сайт на GitHub Pages отправляет сюда POST-запрос с данными (JSON в теле, Content-Type: text/plain),
 * скрипт перезаписывает листы: Ученики, Классы, Учителя, Воспитатели, Отчёт, Архив, История
 * и служебные скрытые листы _Резерв (полная копия базы) и _Журнал.
 *
 * Установка: см. index.html рядом с этим файлом (или раздел «Настройки → Google Таблицы» на сайте).
 * Запустите функцию setup() один раз вручную — она сохранит ID таблицы, создаст токен доступа
 * и ежедневный триггер.
 */

var SHEET_NAMES_ = ['Ученики', 'Классы', 'Учителя', 'Воспитатели', 'Отчёт', 'Архив', 'История'];
var BACKUP_SHEET_ = '_Резерв';
var LOG_SHEET_ = '_Журнал';
var CHUNK_ = 40000; // лимит ячейки Google Таблиц — 50 000 символов
var STALE_HOURS_ = 26;

// ---------------------------------------------------------------- установка

/** Запустить вручную один раз. Показывает токен — его нужно вставить в настройки сайта. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Скрипт должен быть создан из таблицы: Расширения → Apps Script.');
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());
  var token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  installTrigger_();
  Logger.log('Токен доступа: ' + token);
  try {
    SpreadsheetApp.getUi().alert('Готово', 'Токен доступа (вставьте его на сайте в Настройки → Google Таблицы):\n\n' + token, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    // запуск из редактора без интерфейса таблицы — токен смотрите в журнале (Ctrl+Enter)
  }
  return token;
}

/** Выпустить новый токен (старый перестанет работать). Не забудьте обновить его на сайте. */
function resetToken() {
  var token = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  Logger.log('Новый токен: ' + token);
  return token;
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(6).create();
}

// ---------------------------------------------------------------- Web App

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var denied = checkToken_(payload.token);
    if (denied) return json_({ ok: false, error: denied });
    if (payload.type !== 'lyceum-sync' || !payload.sheets) return json_({ ok: false, error: 'Неверный формат данных' });

    lock.waitLock(30000);
    var ss = openSpreadsheet_();
    var written = {};
    SHEET_NAMES_.forEach(function (name) {
      var sh = payload.sheets[name];
      if (!sh) return;
      written[name] = writeSheet_(ss, name, sh.header || [], sh.rows || []);
    });
    if (payload.backup) writeBackup_(ss, payload.backup);

    var props = PropertiesService.getScriptProperties();
    var now = new Date().toISOString();
    props.setProperty('LAST_SYNC', now);
    props.setProperty('LAST_COUNTS', JSON.stringify(written));
    appendLog_(ss, ['sync', payload.currentYear || '', JSON.stringify(written), payload.sentAt || '']);
    SpreadsheetApp.flush();
    return json_({ ok: true, written: written, serverTime: now });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* блокировка не была взята */ }
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var denied = checkToken_(p.token);
  if (denied) return json_({ ok: false, error: denied });
  var props = PropertiesService.getScriptProperties();
  if (p.action === 'backup') {
    var sh = openSpreadsheet_().getSheetByName(BACKUP_SHEET_);
    if (!sh || sh.getLastRow() < 1) return json_({ ok: false, error: 'Резервной копии ещё нет' });
    var chunks = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return r[0]; });
    return json_({ ok: true, backup: chunks.join('') });
  }
  return json_({
    ok: true,
    service: 'lyceum-sync',
    lastSyncAt: props.getProperty('LAST_SYNC') || null,
    counts: JSON.parse(props.getProperty('LAST_COUNTS') || '{}'),
  });
}

// ---------------------------------------------------------------- ежедневная проверка

/**
 * Срабатывает раз в сутки (триггер из setup()). Сервер не может сам «забрать» данные из браузера,
 * поэтому ежедневная задача проверяет свежесть синхронизации, пишет строку в _Журнал и,
 * если сайт давно ничего не присылал, отправляет владельцу письмо-напоминание.
 */
function dailyJob() {
  var props = PropertiesService.getScriptProperties();
  var last = props.getProperty('LAST_SYNC');
  var ageH = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;
  try { appendLog_(openSpreadsheet_(), ['daily-check', last || 'никогда', Math.round(ageH) + ' ч', '']); } catch (e) { /* ignore */ }
  if (ageH > STALE_HOURS_) {
    var to = Session.getEffectiveUser().getEmail();
    if (to) {
      MailApp.sendEmail(to, 'Учёт лицея: данные давно не синхронизировались',
        'Последняя синхронизация: ' + (last || 'ещё не было') + '.\n\n' +
        'Откройте сайт учёта лицея в браузере, где хранятся данные, — при открытии он отправит данные в таблицу автоматически ' +
        '(если в Настройках включена автосинхронизация).');
    }
  }
}

// ---------------------------------------------------------------- вспомогательное

function checkToken_(given) {
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token) return 'not-configured';
  var a = String(given || '');
  if (a.length !== token.length) return 'auth';
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0 ? null : 'auth';
}

function openSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Перезаписывает лист целиком: заголовок + строки, одним вызовом setValues. */
function writeSheet_(ss, name, header, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  var width = header.length;
  var data = [header].concat(rows);
  var formats = data.map(function (row) {
    return row.map(function (v) { return typeof v === 'number' ? '0' : '@'; });
  });
  // Строки с ведущим апострофом (защита от формул на стороне сайта) записываем как обычный текст.
  var values = data.map(function (row) {
    return row.map(function (v) { return typeof v === 'string' && /^'[=+\-@]/.test(v) ? v.slice(1) : v; });
  });
  var range = sh.getRange(1, 1, data.length, width);
  range.setNumberFormats(formats);
  range.setValues(values);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8eff6');
  sh.setFrozenRows(1);
  if (sh.getLastColumn() > 0) sh.autoResizeColumns(1, Math.min(width, 12));
  return rows.length;
}

function writeBackup_(ss, text) {
  var sh = ss.getSheetByName(BACKUP_SHEET_) || ss.insertSheet(BACKUP_SHEET_);
  sh.clearContents();
  var chunks = [];
  for (var i = 0; i < text.length; i += CHUNK_) chunks.push([text.substring(i, i + CHUNK_)]);
  if (!chunks.length) chunks.push(['']);
  var range = sh.getRange(1, 1, chunks.length, 1);
  range.setNumberFormat('@');
  range.setValues(chunks);
  sh.hideSheet();
}

function appendLog_(ss, cells) {
  var sh = ss.getSheetByName(LOG_SHEET_) || ss.insertSheet(LOG_SHEET_);
  sh.appendRow([new Date()].concat(cells));
  if (sh.getLastRow() > 1000) sh.deleteRows(1, sh.getLastRow() - 1000);
  if (!sh.isSheetHidden()) sh.hideSheet();
}
