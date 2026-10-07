/**
 * Учёт лицея — приёмник данных для Google Таблиц (Google Apps Script Web App).
 *
 * Сайт на GitHub Pages отправляет сюда POST-запрос с данными (JSON в теле, Content-Type: text/plain),
 * скрипт перезаписывает листы: Ученики, Классы, Учителя, Воспитатели, Отчёт, Архив, История
 * и служебные скрытые листы _Резерв (полная копия базы) и _Журнал.
 *
 * Второе назначение — ДОПУСК ПОСЕТИТЕЛЕЙ: посетитель сайта отправляет запрос (имя и сообщение), владелец получает
 * письмо и решает на странице «Доступ» сайта, кого впустить. Скрипт хранит только имя, сообщение и решение;
 * ключа от зашифрованных данных он НЕ хранит и НЕ выдаёт.
 *
 * Третье назначение — ОБЩАЯ БАЗА: все допущенные устройства работают с одними данными. Скрипт хранит текущую базу
 * в скрытом листе _Резерв и номер версии (REV); устройства отправляют изменения (action push) и подтягивают чужие (pull).
 * Перед массовым удалением/заменой прежняя версия сохраняется в скрытом листе _Откат (меню «Откатить последнее массовое изменение»).
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
var UNDO_SHEET_ = '_Откат';
var DATA_STORES_ = ['years', 'classes', 'students', 'enrollments', 'staff', 'assignments', 'promotions'];
var SHARED_KEYS_ = ['lyceumName', 'currentYearId', 'letters', 'minGrade', 'maxGrade', 'lastPromotionId', 'changesSincePromotion'];
var MAX_BATCHES_ = 200;
var SHEETS_MIN_GAP_MS_ = 15000;
var BIG_DELETE_ = 10; // столько удалённых записей за раз считается «массовым» изменением (сохраняется копия для отката)

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
    if (payload.type === 'access') return handleAccess_(payload);
    if (payload.type === 'live') return handleLive_(payload);
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
    if (payload.backup) {
      JSON.parse(payload.backup); // повреждённая копия не должна попасть в общую базу
      var prev = readChunks_(ss, BACKUP_SHEET_);
      if (prev) writeChunks_(ss, UNDO_SHEET_, prev);
      writeBackup_(ss, payload.backup);
      setRev_(getRev_() + 1); // общая база изменилась — устройства подтянут новую версию
    }

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
    rev: getRev_(),
    counts: JSON.parse(props.getProperty('LAST_COUNTS') || '{}'),
  });
}

// ---------------------------------------------------------------- допуск посетителей

var ACCESS_SHEET_ = '_Доступ';
var ACCESS_HEADER_ = ['Хэш устройства', 'Имя', 'Сообщение', 'Статус', 'Запрос', 'Решение', 'Последний вход'];
var MAX_REQUESTS_PER_HOUR_ = 20;
var MAX_ROWS_ = 500;

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1); }).join('');
}

function accessSheet_() {
  var ss = openSpreadsheet_();
  var sh = ss.getSheetByName(ACCESS_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(ACCESS_SHEET_);
    sh.getRange(1, 1, 1, ACCESS_HEADER_.length).setValues([ACCESS_HEADER_]);
    sh.hideSheet();
  }
  return sh;
}

function readAccessRows_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, ACCESS_HEADER_.length).getValues().map(function (r, i) {
    return { row: i + 2, hash: String(r[0]), name: String(r[1]), note: String(r[2]), status: String(r[3]), created: String(r[4]), decided: String(r[5]), lastSeen: String(r[6]) };
  });
}

function cleanText_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, max);
}

/**
 * Посетитель: request (отправить запрос) и status (узнать решение). Идентификатор посетителя — случайный секрет
 * устройства, на сервер уходит только его SHA-256.
 * Владелец (нужен токен): whoami, list, decide (allow / deny / revoke / delete).
 */
function handleAccess_(p) {
  var action = String(p.action || '');
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var sh = accessSheet_();
    var rows = readAccessRows_(sh);
    var now = new Date().toISOString();

    if (action === 'request') {
      var hash = String(p.deviceHash || '');
      if (!/^[a-f0-9]{64}$/.test(hash)) return json_({ ok: false, error: 'bad-device' });
      var name = cleanText_(p.name, 80);
      if (name.length < 3) return json_({ ok: false, error: 'name-required' });
      var found = rows.filter(function (r) { return r.hash === hash; })[0];
      if (found) return json_({ ok: true, status: found.status });
      var recent = rows.filter(function (r) { return Date.now() - new Date(r.created).getTime() < 3600000; }).length;
      if (recent >= MAX_REQUESTS_PER_HOUR_ || rows.length >= MAX_ROWS_) return json_({ ok: false, error: 'rate-limit' });
      var note = cleanText_(p.note, 300);
      sh.appendRow([hash, name, note, 'pending', now, '', now]);
      dropAclCache_();
      notifyOwner_(name, note, hash);
      return json_({ ok: true, status: 'pending' });
    }

    if (action === 'status') {
      var h = sha256Hex_(String(p.device || ''));
      var me = rows.filter(function (r) { return r.hash === h; })[0];
      if (!me) return json_({ ok: true, status: 'none' });
      if (!me.lastSeen || Date.now() - new Date(me.lastSeen).getTime() > 600000) sh.getRange(me.row, 7).setValue(now);
      return json_({ ok: true, status: me.status, name: me.name });
    }

    var denied = checkToken_(p.token);
    if (denied) return json_({ ok: false, error: denied });

    if (action === 'whoami') return json_({ ok: true, owner: true });

    if (action === 'list') {
      return json_({ ok: true, requests: rows.map(function (r) {
        return { id: r.hash.substring(0, 12), name: r.name, note: r.note, status: r.status, created: r.created, decided: r.decided, lastSeen: r.lastSeen };
      }) });
    }

    if (action === 'decide') {
      var id = String(p.id || '');
      var decision = String(p.decision || '');
      var matches = id.length >= 8 ? rows.filter(function (r) { return r.hash.indexOf(id) === 0; }) : [];
      if (matches.length !== 1) return json_({ ok: false, error: 'not-found' });
      var target = matches[0];
      if (decision === 'delete') {
        sh.deleteRow(target.row);
        dropAclCache_();
        return json_({ ok: true });
      }
      var status = { allow: 'allowed', deny: 'denied', revoke: 'revoked' }[decision];
      if (!status) return json_({ ok: false, error: 'bad-decision' });
      sh.getRange(target.row, 4).setValue(status);
      sh.getRange(target.row, 6).setValue(now);
      dropAclCache_();
      return json_({ ok: true, status: status });
    }
    return json_({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* блокировка не была взята */ }
  }
}

/** Письмо владельцу о новом запросе. Решение принимается только на странице «Доступ» сайта (в письме нет ссылок-действий). */
function notifyOwner_(name, note, hash) {
  try {
    var props = PropertiesService.getScriptProperties();
    var to = props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
    if (!to) return;
    var site = props.getProperty('SITE_URL');
    MailApp.sendEmail(to, 'Учёт лицея: запрос на доступ — ' + name,
      'Кто-то просит доступ к сайту.\n\nИмя: ' + name + '\nСообщение: ' + (note || '—') + '\nНомер запроса: ' + hash.substring(0, 12) + '\n\n' +
      (site ? 'Решить: ' + site.replace(/\/+$/, '') + '/#/access\n' : 'Откройте сайт → раздел «Доступ», чтобы разрешить или отклонить запрос.\n') +
      '\nЕсли вы не знаете этого человека — отклоните запрос.');
  } catch (e) { /* письмо не критично: запрос виден в разделе «Доступ» */ }
}

// ---------------------------------------------------------------- общая база

var ACL_KEY_ = 'ACL';

/** Допущенные устройства: { хэш: имя }. Кэшируется на 5 минут; сбрасывается при любом решении владельца. */
function allowedMap_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(ACL_KEY_);
  if (hit) return JSON.parse(hit);
  var map = {};
  readAccessRows_(accessSheet_()).forEach(function (r) { if (r.status === 'allowed') map[r.hash] = r.name; });
  cache.put(ACL_KEY_, JSON.stringify(map), 300);
  return map;
}

function dropAclCache_() {
  try { CacheService.getScriptCache().remove(ACL_KEY_); } catch (e) { /* кэш недоступен — истечёт сам */ }
}

/** Кто обращается: владелец (токен) или допущенный посетитель (секрет устройства). Иначе null. */
function authLive_(p) {
  if (!checkToken_(p.token)) return { role: 'owner', name: 'владелец' };
  var dev = String(p.device || '');
  if (dev.length < 16) return null;
  var map = allowedMap_();
  var h = sha256Hex_(dev);
  return Object.prototype.hasOwnProperty.call(map, h) ? { role: 'visitor', name: map[h] } : null;
}

function readChunks_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 1) return '';
  return sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return r[0]; }).join('');
}

function writeChunks_(ss, name, text) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  var chunks = [];
  for (var i = 0; i < text.length; i += CHUNK_) chunks.push([text.substring(i, i + CHUNK_)]);
  if (!chunks.length) chunks.push(['']);
  var range = sh.getRange(1, 1, chunks.length, 1);
  range.setNumberFormat('@');
  range.setValues(chunks);
  sh.hideSheet();
}

/** Номер версии общей базы. Если база уже лежит в _Резерв (загружена раньше), версия начинается с 1. */
function getRev_() {
  var props = PropertiesService.getScriptProperties();
  var v = Number(props.getProperty('REV'));
  if (v > 0) return v;
  var sh = openSpreadsheet_().getSheetByName(BACKUP_SHEET_);
  if (sh && sh.getLastRow() >= 1 && String(sh.getRange(1, 1).getValue()).length > 0) {
    props.setProperty('REV', '1');
    return 1;
  }
  return 0;
}

function setRev_(n) {
  PropertiesService.getScriptProperties().setProperty('REV', String(n));
}

function jsonRaw_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/** Проверяет и очищает пакет изменений от устройства: только известные разделы и настройки, записи с текстовым id. */
function normalizeBatch_(b) {
  if (!b || typeof b !== 'object') return null;
  var out = { put: {}, del: {}, clear: [], settings: {}, dels: 0 };
  var ok = true;
  DATA_STORES_.forEach(function (s) {
    var recs = b.put && b.put[s];
    if (recs !== undefined && recs !== null) {
      if (!Array.isArray(recs)) { ok = false; return; }
      recs.forEach(function (r) { if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 200) ok = false; });
      out.put[s] = recs;
    }
    var ids = b.del && b.del[s];
    if (ids !== undefined && ids !== null) {
      if (!Array.isArray(ids)) { ok = false; return; }
      ids.forEach(function (id) { if (typeof id !== 'string') ok = false; });
      out.del[s] = ids;
      out.dels += ids.length;
    }
  });
  (Array.isArray(b.clear) ? b.clear : []).forEach(function (s) { if (DATA_STORES_.indexOf(s) >= 0) out.clear.push(s); });
  SHARED_KEYS_.forEach(function (k) { if (b.settings && Object.prototype.hasOwnProperty.call(b.settings, k)) out.settings[k] = b.settings[k]; });
  return ok ? out : null;
}

/** Те же правила, что и в js/domain/state.js → applyChanges (сначала очистка, потом удаление, потом запись). */
function applyChanges_(state, c) {
  c.clear.forEach(function (s) { state[s] = []; });
  DATA_STORES_.forEach(function (s) {
    var ids = c.del[s];
    if (!ids || !ids.length) return;
    var drop = {};
    ids.forEach(function (id) { drop['k' + id] = true; });
    state[s] = state[s].filter(function (x) { return !drop['k' + x.id]; });
  });
  DATA_STORES_.forEach(function (s) {
    var recs = c.put[s];
    if (!recs || !recs.length) return;
    var pos = {};
    state[s].forEach(function (x, i) { pos['k' + x.id] = i; });
    recs.forEach(function (r) {
      var k = 'k' + r.id;
      if (Object.prototype.hasOwnProperty.call(pos, k)) state[s][pos[k]] = r;
      else { pos[k] = state[s].length; state[s].push(r); }
    });
  });
  Object.keys(c.settings).forEach(function (k) { state.settings[k] = c.settings[k]; });
}

function validSnapshot_(d) {
  if (!d || typeof d !== 'object' || d.format !== 'lyceum-registry' || typeof d.version !== 'number') return false;
  for (var i = 0; i < DATA_STORES_.length; i++) if (!Array.isArray(d[DATA_STORES_[i]])) return false;
  return !!(d.settings && typeof d.settings === 'object' && typeof d.settings.currentYearId === 'string');
}

/**
 * Общая база. Все запросы: { type:'live', action, token | device, … }.
 *   pull  { sinceRev }            → { rev, same:true } или { rev, data } (data = полная база; sinceRev = -1 — первое подключение)
 *   push  { baseRev, batches }    → { rev, applied, rejected, data? } — применяет пакеты изменений по порядку
 *   seed  { data, force? }        → записывает первую версию базы (если её ещё нет)
 *   sheets{ sheets }              → обновляет читаемые листы («Ученики», «Классы» …); не чаще раза в 15 секунд
 */
function handleLive_(p) {
  var who = authLive_(p);
  if (!who) return json_({ ok: false, error: checkToken_('x') === 'not-configured' ? 'not-configured' : 'forbidden' });
  var action = String(p.action || '');
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    if (action === 'pull') {
      var since = Number(p.sinceRev);
      if (since === getRev_()) return json_({ ok: true, rev: since, same: true });
    }
    if (action === 'sheets') {
      var last = Number(PropertiesService.getScriptProperties().getProperty('SHEETS_AT') || 0);
      if (Date.now() - last < SHEETS_MIN_GAP_MS_ || !lock.tryLock(5000)) return json_({ ok: true, skipped: true });
    } else lock.waitLock(30000);
    locked = true;
    var ss = openSpreadsheet_();
    var rev = getRev_();

    if (action === 'pull') {
      var text = rev > 0 ? readChunks_(ss, BACKUP_SHEET_) : '';
      if (!text) return json_({ ok: true, rev: 0, data: null });
      return jsonRaw_('{"ok":true,"rev":' + rev + ',"data":' + text + '}');
    }

    if (action === 'push') {
      var current = rev > 0 ? readChunks_(ss, BACKUP_SHEET_) : '';
      if (!current) return json_({ ok: false, error: 'no-state' });
      var state = JSON.parse(current);
      var batches = Array.isArray(p.batches) ? p.batches.slice(0, MAX_BATCHES_) : [];
      var applied = 0, rejected = 0, stop = false, big = false;
      batches.forEach(function (raw) {
        var b = normalizeBatch_(raw);
        if (stop || !b) { rejected++; stop = true; return; }
        // Смена учебного года (и отмена перехода) выполняется только над тем годом, который видел автор.
        if (raw.expect && state.settings.currentYearId !== raw.expect) { rejected++; stop = true; return; }
        if (b.clear.length || b.dels >= BIG_DELETE_) big = true;
        applyChanges_(state, b);
        applied++;
      });
      var newRev = rev;
      var body = current;
      if (applied) {
        if (big) writeChunks_(ss, UNDO_SHEET_, current);
        state.exportedAt = new Date().toISOString();
        body = JSON.stringify(state);
        writeBackup_(ss, body);
        newRev = rev + 1;
        setRev_(newRev);
        appendLog_(ss, ['live-push', who.name, applied + ' пакет(ов), отклонено ' + rejected, 'v' + newRev]);
      } else if (rejected) appendLog_(ss, ['live-reject', who.name, rejected + ' пакет(ов)', 'v' + rev]);
      var same = Number(p.baseRev) === rev && !rejected; // база не менялась без нас: устройству не нужна копия
      if (same) return json_({ ok: true, rev: newRev, applied: applied, rejected: 0 });
      return jsonRaw_('{"ok":true,"rev":' + newRev + ',"applied":' + applied + ',"rejected":' + rejected + ',"data":' + body + '}');
    }

    if (action === 'seed') {
      if (rev > 0 && !(who.role === 'owner' && p.force === true)) return json_({ ok: false, error: 'exists' });
      var d = p.data;
      if (!validSnapshot_(d)) return json_({ ok: false, error: 'bad-data' });
      var snap = { format: d.format, version: d.version, exportedAt: new Date().toISOString(), app: d.app || '', settings: {} };
      SHARED_KEYS_.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(d.settings, k)) snap.settings[k] = d.settings[k]; });
      DATA_STORES_.forEach(function (s) { snap[s] = d[s]; });
      if (rev > 0) writeChunks_(ss, UNDO_SHEET_, readChunks_(ss, BACKUP_SHEET_));
      writeBackup_(ss, JSON.stringify(snap));
      setRev_(rev + 1);
      appendLog_(ss, ['live-seed', who.name, d.students ? d.students.length + ' учеников' : '', 'v' + (rev + 1)]);
      return json_({ ok: true, rev: rev + 1 });
    }

    if (action === 'sheets') {
      var sheetsIn = p.sheets;
      if (!sheetsIn || typeof sheetsIn !== 'object') return json_({ ok: false, error: 'bad-data' });
      var written = {};
      SHEET_NAMES_.forEach(function (name) {
        var sh = sheetsIn[name];
        if (sh) written[name] = writeSheet_(ss, name, sh.header || [], sh.rows || []);
      });
      var props = PropertiesService.getScriptProperties();
      props.setProperty('SHEETS_AT', String(Date.now()));
      props.setProperty('LAST_SYNC', new Date().toISOString());
      props.setProperty('LAST_COUNTS', JSON.stringify(written));
      SpreadsheetApp.flush();
      return json_({ ok: true, written: written });
    }
    return json_({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (x) { /* блокировка не была взята */ } }
  }
}

/** Из меню таблицы: вернуть общую базу к версии, сохранённой перед последним массовым изменением. */
function restorePrevious() {
  var ui = SpreadsheetApp.getUi();
  var ss = openSpreadsheet_();
  var prev = readChunks_(ss, UNDO_SHEET_);
  if (!prev) { ui.alert('Откатывать нечего: копия перед массовым изменением ещё не сохранялась.'); return; }
  var r = ui.alert('Откат', 'Заменить общую базу копией, сохранённой перед последним массовым изменением (удалением или заменой данных)? Все изменения, сделанные после него, будут потеряны.', ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var current = readChunks_(ss, BACKUP_SHEET_);
    JSON.parse(prev);
    writeBackup_(ss, prev);
    if (current) writeChunks_(ss, UNDO_SHEET_, current); // откат можно «откатить»
    setRev_(getRev_() + 1);
    appendLog_(ss, ['live-restore', 'владелец', '', 'v' + getRev_()]);
  } finally { lock.releaseLock(); }
  ui.alert('Готово', 'Общая база восстановлена. Открытые сайты подтянут её в течение нескольких секунд.', ui.ButtonSet.OK);
}

// ---------------------------------------------------------------- меню таблицы

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Учёт лицея')
      .addItem('1. Настройка (токен и триггер)', 'setup')
      .addItem('2. Задать адрес сайта…', 'promptSiteUrl')
      .addItem('Показать токен', 'showToken')
      .addItem('Откатить последнее массовое изменение', 'restorePrevious')
      .addToUi();
  } catch (e) { /* запуск без интерфейса */ }
}

function promptSiteUrl() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Адрес сайта', 'Например: https://имя.github.io/Obhod_BIL (нужен для ссылки в письмах о запросах доступа).', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var v = String(r.getResponseText() || '').trim();
  if (/^https:\/\//.test(v)) {
    PropertiesService.getScriptProperties().setProperty('SITE_URL', v);
    ui.alert('Адрес сайта сохранён.');
  } else ui.alert('Адрес должен начинаться с https://');
}

function showToken() {
  var ui = SpreadsheetApp.getUi();
  ui.alert('Токен владельца', PropertiesService.getScriptProperties().getProperty('TOKEN') || 'Сначала выполните «Настройка».', ui.ButtonSet.OK);
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
  // С общей базой данные уже на сервере (их версия — REV), напоминать о синхронизации браузера не нужно.
  if (ageH > STALE_HOURS_ && getRev_() === 0) {
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
