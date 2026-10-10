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

var SHEET_NAMES_ = ['Ученики', 'Классы', 'Учителя', 'Воспитатели', 'Отчёт', 'Архив', 'История', 'Вечерний обход'];
var BACKUP_SHEET_ = '_Резерв';
var LOG_SHEET_ = '_Журнал';
var CHUNK_ = 40000; // лимит ячейки Google Таблиц — 50 000 символов
var STALE_HOURS_ = 26;
var UNDO_SHEET_ = '_Откат';
var DATA_STORES_ = ['years', 'classes', 'students', 'enrollments', 'staff', 'assignments', 'promotions', 'rounds', 'days'];
var OPTIONAL_STORES_ = ['rounds', 'days']; // появились позже: в старых копиях их нет, это не ошибка
var SHARED_KEYS_ = ['lyceumName', 'currentYearId', 'letters', 'minGrade', 'maxGrade', 'lastPromotionId', 'changesSincePromotion'];
var MAX_BATCHES_ = 200;
var SHEETS_MIN_GAP_MS_ = 15000;
var MAX_BODY_ = 3000000;      // максимальный размер запроса, знаков
var MAX_STATE_ = 3000000;     // максимальный размер общей базы (JSON), знаков
var MAX_RECORD_ = 20000;      // максимальный размер одной записи, знаков
var MAX_OPS_ = 5000;          // записей (put) и удалений (del) за один запрос
var VISITOR_MAX_DELETE_ = 50; // допущенный посетитель не может удалить за раз больше записей, чем это (очистка — только владелец)
var MAX_MAILS_PER_HOUR_ = 5;  // писем владельцу о новых запросах в час (квота MailApp ограничена)
var BIG_DELETE_ = 10; // столько удалённых записей за раз считается «массовым» изменением (сохраняется копия для отката)
var AUDIT_SHEET_ = '_Аудит';          // журнал действий (читает только администратор)
var AUDIT_HEADER_ = ['Время', 'Событие', 'Кто', 'Роль', 'Код', 'Объект', 'Подробности'];
var AUDIT_MAX_ROWS_ = 21000;          // при переполнении удаляются самые старые 1000 строк
var MARKS_PREFIX_ = '_Отметки ';      // история отметок по годам: «_Отметки 2026» (источник отчётов и выгрузок)
var MARKS_HEADER_ = ['Записано', 'Дата', 'Вид', 'Ученик', 'Класс', 'Место', 'Причина', 'Кто', 'Роль', 'Код', 'Время на устройстве'];
var KINDS_ = ['evening', 'morning', 'extra'];
var ROUND_KEEP_ = { evening: 3, morning: 2, extra: 2 }; // сколько дней отметки лежат в общей базе (дальше — только в истории)
var MAX_RANGE_DAYS_ = 400;
var MAX_MARK_ROWS_ = 20000;
var MAX_STAT_ROWS_ = 150000; // для сводки строки не отдаются на устройство, поэтому предел выше

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
    var raw = (e && e.postData && e.postData.contents) || '{}';
    if (raw.length > MAX_BODY_) return json_({ ok: false, error: 'too-big' });
    var payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return json_({ ok: false, error: 'bad-request' });
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
    // Внутренности (тексты ошибок разбора) наружу не отдаём.
    return json_({ ok: false, error: err instanceof SyntaxError ? 'bad-request' : String(err && err.message ? err.message : err) });
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
var ACCESS_HEADER_ = ['Хэш устройства', 'Имя', 'Сообщение', 'Статус', 'Запрос', 'Решение', 'Последний вход', 'Роль', 'Email', 'Запрошенная роль'];
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
  } else if (sh.getLastColumn() < ACCESS_HEADER_.length) {
    sh.getRange(1, 1, 1, ACCESS_HEADER_.length).setValues([ACCESS_HEADER_]); // лист от прежней версии: добавились «Роль», «Email», «Запрошенная роль»
  }
  return sh;
}

function readAccessRows_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, ACCESS_HEADER_.length).getValues().map(function (r, i) {
    return { row: i + 2, hash: String(r[0]), name: String(r[1]), note: String(r[2]), status: String(r[3]), created: String(r[4]), decided: String(r[5]), lastSeen: String(r[6]), role: String(r[7]) === 'admin' ? 'admin' : 'user', email: String(r[8] || ''), wantRole: String(r[9]) === 'admin' ? 'admin' : 'user' };
  });
}

function cleanText_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, max);
}

/**
 * Устройство (без токена): request (отправить запрос) и status (узнать решение и роль). Идентификатор устройства — случайный
 * секрет, на сервер уходит только его SHA-256.
 * Администратор (токен владельца или устройство с ролью «администратор»): list, decide (allow / deny / revoke / delete / role).
 * Роль «администратор» выдаёт и меняет только владелец (токен). me — кто я (токен или устройство).
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
      var email = cleanText_(p.email, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json_({ ok: false, error: 'bad-email' });
      var wantRole = p.wantRole === 'admin' ? 'admin' : 'user';
      var found = rows.filter(function (r) { return r.hash === hash; })[0];
      if (found) return json_({ ok: true, status: found.status });
      var recent = rows.filter(function (r) { return Date.now() - new Date(r.created).getTime() < 3600000; }).length;
      if (recent >= MAX_REQUESTS_PER_HOUR_) return json_({ ok: false, error: 'rate-limit' });
      if (rows.length >= MAX_ROWS_) {
        // Таблица заполнена (например, спамом): освобождаем место, удаляя самые старые НЕ допущенные запросы.
        var stale = rows.filter(function (r) { return r.status !== 'allowed'; }).sort(function (a, b) { return String(a.created) < String(b.created) ? -1 : 1; }).slice(0, 50);
        if (!stale.length) return json_({ ok: false, error: 'rate-limit' });
        stale.map(function (r) { return r.row; }).sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); });
      }
      var note = cleanText_(p.note, 300);
      appendText_(sh, [hash, name, note, 'pending', now, '', now, '', email, wantRole]);
      dropAclCache_();
      audit_('access-request', { name: name, role: '', id: hash.substring(0, 12) }, name, { wantRole: wantRole, email: email ? 'указан' : '' });
      notifyOwner_(name, note, hash, email, wantRole);
      return json_({ ok: true, status: 'pending' });
    }

    if (action === 'status') {
      var h = sha256Hex_(String(p.device || ''));
      var me = rows.filter(function (r) { return r.hash === h; })[0];
      if (!me) return json_({ ok: true, status: 'none' });
      if (!me.lastSeen || Date.now() - new Date(me.lastSeen).getTime() > 600000) sh.getRange(me.row, 7).setValue(now);
      if (me.status === 'allowed') loginEvent_({ name: me.name, role: me.role, id: me.hash.substring(0, 12) });
      return json_({ ok: true, status: me.status, name: me.name, role: me.role });
    }

    if (action === 'whoami') {
      var denied = checkToken_(p.token);
      if (denied) { failedLogin_(p); return json_({ ok: false, error: denied }); }
      loginEvent_({ name: 'Владелец', role: 'admin', id: 'owner' });
      return json_({ ok: true, owner: true, role: 'admin' });
    }

    var w = who_(p);
    if (action === 'me') {
      if (!w) { failedLogin_(p); return json_({ ok: false, error: 'auth' }); }
      loginEvent_(w);
      return json_({ ok: true, role: w.role, name: w.name, owner: !!w.owner });
    }
    if (!w || w.role !== 'admin') return json_({ ok: false, error: checkToken_('x') === 'not-configured' ? 'not-configured' : 'auth' });

    if (action === 'list') {
      return json_({ ok: true, requests: rows.map(function (r) {
        return { id: r.hash.substring(0, 12), name: r.name, note: r.note, status: r.status, created: r.created, decided: r.decided, lastSeen: r.lastSeen, role: r.role, wantRole: r.wantRole, email: r.email };
      }) });
    }

    if (action === 'decide') {
      var id = String(p.id || '');
      var decision = String(p.decision || '');
      var matches = id.length >= 8 ? rows.filter(function (r) { return r.hash.indexOf(id) === 0; }) : [];
      if (matches.length !== 1) return json_({ ok: false, error: 'not-found' });
      var target = matches[0];
      var grant = p.role === 'admin' ? 'admin' : 'user';
      // Роль администратора выдаёт и меняет только владелец; администратор-устройство не может отозвать другого администратора.
      if (!w.owner && ((decision === 'allow' && grant === 'admin') || decision === 'role' || (target.role === 'admin' && target.status === 'allowed'))) return json_({ ok: false, error: 'owner-only' });
      var who = { name: w.name, role: w.role, id: w.id };
      if (decision === 'delete') {
        sh.deleteRow(target.row);
        dropAclCache_();
        audit_('access-delete', who, target.name, { id: target.hash.substring(0, 12) });
        return json_({ ok: true });
      }
      if (decision === 'role') {
        if (target.status !== 'allowed') return json_({ ok: false, error: 'not-allowed' });
        sh.getRange(target.row, 8).setValue(grant);
        dropAclCache_();
        audit_('access-role', who, target.name, { id: target.hash.substring(0, 12), role: grant });
        return json_({ ok: true, status: 'allowed', role: grant });
      }
      var status = { allow: 'allowed', deny: 'denied', revoke: 'revoked' }[decision];
      if (!status) return json_({ ok: false, error: 'bad-decision' });
      sh.getRange(target.row, 4).setValue(status);
      sh.getRange(target.row, 6).setValue(now);
      if (decision === 'allow') sh.getRange(target.row, 8).setValue(grant);
      dropAclCache_();
      audit_('access-' + decision, who, target.name, { id: target.hash.substring(0, 12), role: decision === 'allow' ? grant : '' });
      return json_({ ok: true, status: status, role: decision === 'allow' ? grant : target.role });
    }
    return json_({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (x) { /* блокировка не была взята */ }
  }
}

/** Письмо администратору о новом запросе. Решение принимается только на странице «Запросы доступа» сайта (в письме нет ссылок-действий). */
function notifyOwner_(name, note, hash, email, wantRole) {
  try {
    var props = PropertiesService.getScriptProperties();
    // Не больше MAX_MAILS_PER_HOUR_ писем в час: остальные запросы видны на странице «Запросы доступа».
    var hourKey = 'MAILS_' + Math.floor(Date.now() / 3600000);
    var sent = Number(props.getProperty(hourKey) || 0);
    if (sent >= MAX_MAILS_PER_HOUR_) return;
    props.setProperty(hourKey, String(sent + 1));
    var list = [props.getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail()];
    String(props.getProperty('ADMIN_EMAILS') || '').split(',').forEach(function (m) { m = m.trim(); if (m && list.indexOf(m) < 0) list.push(m); });
    var to = list.filter(function (m) { return !!m; }).join(',');
    if (!to) return;
    var site = props.getProperty('SITE_URL');
    MailApp.sendEmail(to, 'Учёт лицея: запрос на доступ — ' + name,
      'Кто-то просит доступ к сайту.\n\nИмя: ' + name + '\nEmail: ' + (email || '—') + '\nЗапрошенная роль: ' + (wantRole === 'admin' ? 'администратор' : 'дежурный (пользователь)') + '\nСообщение: ' + (note || '—') + '\nНомер запроса: ' + hash.substring(0, 12) + '\n\n' +
      (site ? 'Решить: ' + site.replace(/\/+$/, '') + '/#/access\n' : 'Откройте сайт → «Запросы доступа», чтобы принять или отклонить запрос.\n') +
      '\nЕсли вы не знаете этого человека — отклоните запрос.');
  } catch (e) { /* письмо не критично: запрос виден в разделе «Запросы доступа» */ }
}

// ---------------------------------------------------------------- журнал действий (аудит)

function auditSheet_(ss) {
  var sh = ss.getSheetByName(AUDIT_SHEET_);
  if (!sh) {
    sh = ss.insertSheet(AUDIT_SHEET_);
    sh.getRange(1, 1, 1, AUDIT_HEADER_.length).setValues([AUDIT_HEADER_]);
    sh.hideSheet();
  }
  return sh;
}

/** Строки журнала: [время ISO, событие, кто, роль, код, объект, подробности JSON ≤ 500]. В журнале коды и ID, а не данные учеников. */
function auditRow_(event, who, target, details, at) {
  var d = '';
  try { d = JSON.stringify(details || {}).substring(0, 500); } catch (e) { d = ''; }
  return [at || new Date().toISOString(), event, cleanText_(who && who.name, 80), (who && who.role) || '', (who && who.id) || '', cleanText_(target, 120), d];
}

function auditMany_(rows) {
  if (!rows.length) return;
  try {
    var ss = openSpreadsheet_();
    var sh = auditSheet_(ss);
    var start = sh.getLastRow() + 1;
    var range = sh.getRange(start, 1, rows.length, AUDIT_HEADER_.length);
    range.setNumberFormat('@');
    range.setValues(rows);
    if (sh.getLastRow() > AUDIT_MAX_ROWS_) sh.deleteRows(2, 1000);
  } catch (e) { /* журнал не должен ломать работу сайта */ }
}

function audit_(event, who, target, details) { auditMany_([auditRow_(event, who, target, details)]); }

/** «Вход»: проверенный доступ устройства или владельца; не чаще раза в 6 часов на устройство, чтобы журнал не засорялся. */
function loginEvent_(who) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'LG_' + who.id;
    if (cache.get(key)) return;
    cache.put(key, '1', 21600);
    audit_('login', who, '', {});
  } catch (e) { /* ignore */ }
}

/** Неудачный вход по токену: не чаще раза в 10 минут. Устройства без допуска (отказ, отзыв) не логируются — они опрашивают сервер сами. */
function failedLogin_(p) {
  try {
    if (!p || !p.token) return;
    var cache = CacheService.getScriptCache();
    if (cache.get('LF')) return;
    cache.put('LF', '1', 600);
    audit_('login-failed', { name: 'неизвестный', role: '', id: '' }, '', {});
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- общая база

var ACL_KEY_ = 'ACL';

/** Допущенные устройства: { хэш: { name, role } }. Кэшируется на 5 минут; сбрасывается при любом решении администратора. */
function allowedMap_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(ACL_KEY_);
  if (hit) {
    var parsed = JSON.parse(hit);
    Object.keys(parsed).forEach(function (k) { if (typeof parsed[k] === 'string') parsed[k] = { name: parsed[k], role: 'user' }; }); // кэш прежней версии
    return parsed;
  }
  var map = {};
  readAccessRows_(accessSheet_()).forEach(function (r) { if (r.status === 'allowed') map[r.hash] = { name: r.name, role: r.role }; });
  cache.put(ACL_KEY_, JSON.stringify(map), 300);
  return map;
}

function dropAclCache_() {
  try { CacheService.getScriptCache().remove(ACL_KEY_); } catch (e) { /* кэш недоступен — истечёт сам */ }
}

/**
 * Кто обращается: владелец по токену (роль admin, owner:true), допущенное устройство (роль admin или user) или null.
 * Роль определяется ТОЛЬКО здесь, на сервере: клиент её не присылает.
 */
function who_(p) {
  if (!checkToken_(p.token)) return { role: 'admin', name: 'Владелец', id: 'owner', owner: true };
  var dev = String(p.device || '');
  if (dev.length < 16) return null;
  var map = allowedMap_();
  var h = sha256Hex_(dev);
  if (!Object.prototype.hasOwnProperty.call(map, h)) return null;
  var v = map[h];
  return { role: v.role === 'admin' ? 'admin' : 'user', name: v.name, id: h.substring(0, 12) };
}
var authLive_ = who_;

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

var PLACES_ = ['sick', 'home', 'absent', 'sleeping'];

function isoDate_(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)); }
function shiftDay_(iso, n) {
  var p = iso.split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n)).toISOString().substring(0, 10);
}
function dayDiff_(a, b) { // b − a, в днях
  var x = a.split('-'), y = b.split('-');
  return Math.round((Date.UTC(Number(y[0]), Number(y[1]) - 1, Number(y[2])) - Date.UTC(Number(x[0]), Number(x[1]) - 1, Number(x[2]))) / 86400000);
}
/** Сегодняшняя дата по времени лицея (часовой пояс скрипта — см. appsscript.json: Asia/Qostanay). */
function serverToday_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

/** Вид проверки по записи: без поля kind — вечерняя. */
function kindOfRec_(r) { return KINDS_.indexOf(r && r.kind) >= 0 ? r.kind : 'evening'; }
/** Дата и вид из id отметки: `дата:ученик` (вечер) или `дата:вид:ученик`. */
function parseRoundId_(id) {
  var parts = String(id).split(':');
  return { date: parts[0], kind: parts.length >= 3 && KINDS_.indexOf(parts[1]) >= 0 ? parts[1] : 'evening' };
}
function roundIdOf_(r) { return kindOfRec_(r) === 'evening' ? r.date + ':' + r.studentId : r.date + ':' + r.kind + ':' + r.studentId; }
/** Отметка ещё хранится в общей базе (иначе остаётся только в истории). */
function roundFresh_(date, kind, today) { return isoDate_(date) && dayDiff_(date, today) <= ROUND_KEEP_[kind] - 1; }

/** Запись допустима: объект с текстовым id, не больше MAX_RECORD_; обход, дни и классы — со строгой проверкой полей. */
function validRecord_(store, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || !r.id || r.id.length > 200) return false;
  if (JSON.stringify(r).length > MAX_RECORD_) return false;
  if (store === 'rounds') {
    if (!isoDate_(r.date) || typeof r.studentId !== 'string' || !r.studentId || r.studentId.length > 200) return false;
    if (PLACES_.indexOf(r.place) < 0) return false;
    if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 120)) return false;
    if (r.kind !== undefined && KINDS_.indexOf(r.kind) < 0) return false;
    if (r.id !== roundIdOf_(r)) return false;
    if (r.by !== undefined && (typeof r.by !== 'string' || r.by.length > 80)) return false;
    if (r.at !== undefined && (typeof r.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(r.at))) return false;
    if (r.classId !== undefined && r.classId !== null && (typeof r.classId !== 'string' || r.classId.length > 200)) return false;
  }
  if (store === 'days') {
    if (!isoDate_(r.date) || r.id !== r.date) return false;
    if (r.holiday !== undefined && typeof r.holiday !== 'boolean') return false;
    if (r.note !== undefined && (typeof r.note !== 'string' || r.note.length > 120)) return false;
    if (r.dutyText !== undefined && (typeof r.dutyText !== 'string' || r.dutyText.length > 120)) return false;
    if (r.dutyStaffIds !== undefined) {
      if (!Array.isArray(r.dutyStaffIds) || r.dutyStaffIds.length > 6) return false;
      for (var i = 0; i < r.dutyStaffIds.length; i++) if (typeof r.dutyStaffIds[i] !== 'string' || r.dutyStaffIds[i].length > 200) return false;
    }
  }
  if (store === 'classes' && r.room !== undefined && (typeof r.room !== 'string' || r.room.length > 20)) return false;
  return true;
}

function normalizeBatch_(b) {
  if (!b || typeof b !== 'object') return null;
  var out = { put: {}, del: {}, clear: [], settings: {}, dels: 0, puts: 0 };
  var ok = true;
  DATA_STORES_.forEach(function (s) {
    var recs = b.put && b.put[s];
    if (recs !== undefined && recs !== null) {
      if (!Array.isArray(recs)) { ok = false; return; }
      recs.forEach(function (r) { if (!validRecord_(s, r)) ok = false; });
      out.puts += recs.length;
      out.put[s] = recs;
    }
    var ids = b.del && b.del[s];
    if (ids !== undefined && ids !== null) {
      if (!Array.isArray(ids)) { ok = false; return; }
      ids.forEach(function (id) { if (typeof id !== 'string' || id.length > 200) ok = false; });
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
  DATA_STORES_.forEach(function (s) { if (!Array.isArray(state[s])) state[s] = []; });
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
  for (var i = 0; i < DATA_STORES_.length; i++) {
    var st = DATA_STORES_[i];
    if (!Array.isArray(d[st]) && !(OPTIONAL_STORES_.indexOf(st) >= 0 && d[st] === undefined)) return false;
  }
  return !!(d.settings && typeof d.settings === 'object' && typeof d.settings.currentYearId === 'string');
}

/** Пользователь видит только то, что нужно для обхода: без дат рождения, заметок, контактов и истории переводов. */
function projectForUser_(state) {
  var pick = function (o, keys) { var r = {}; keys.forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; }); return r; };
  var out = {};
  Object.keys(state).forEach(function (k) { out[k] = state[k]; });
  out.students = (state.students || []).map(function (x) { return pick(x, ['id', 'lastName', 'firstName', 'middleName', 'status', 'demo']); });
  out.staff = (state.staff || []).map(function (x) { return pick(x, ['id', 'lastName', 'firstName', 'middleName', 'role', 'archived', 'demo']); });
  out.enrollments = (state.enrollments || []).map(function (x) { return pick(x, ['id', 'studentId', 'yearId', 'classId', 'status']); });
  out.classes = (state.classes || []).map(function (x) { return pick(x, ['id', 'yearId', 'grade', 'letter', 'name', 'room', 'archived']); });
  out.promotions = [];
  return out;
}

function nonRoundOps_(b) {
  var bad = false;
  Object.keys(b.put).forEach(function (s) { if (s !== 'rounds' && b.put[s].length) bad = true; });
  Object.keys(b.del).forEach(function (s) { if (s !== 'rounds' && b.del[s].length) bad = true; });
  return bad || Object.keys(b.settings).length > 0;
}

/** Удаления отметок, которые уже вышли из окна хранения (чистка старых отметок): не считаются «массовым удалением». */
function staleRoundDels_(b, today) {
  var n = 0;
  (b.del.rounds || []).forEach(function (id) { var i = parseRoundId_(id); if (!roundFresh_(i.date, i.kind, today)) n++; });
  return n;
}

/**
 * Отметки только на существующих учеников и только в окне [сегодня − (хранение − 1) … завтра].
 * Недопустимые отметки (ученика уже нет, дата вышла из окна) отбрасываются по одной — остальные в пакете (и остальные пакеты) применяются.
 * Возвращает, сколько отброшено.
 */
function dropBadRounds_(b, students, today) {
  var list = b.put.rounds || [];
  var good = list.filter(function (r) {
    return students['k' + r.studentId] && roundFresh_(r.date, kindOfRec_(r), today) && dayDiff_(today, r.date) <= 1;
  });
  var dropped = list.length - good.length;
  if (dropped) { b.put.rounds = good; b.puts -= dropped; }
  return dropped;
}

/** Время отметки с устройства допустимо в пределах [сейчас − 72 ч; сейчас + 5 мин], иначе ставится серверное. */
function clampAt_(v, nowMs, nowIso) {
  var t = new Date(String(v || '')).getTime();
  if (!isFinite(t) || t < nowMs - 72 * 3600000 || t > nowMs + 300000) return nowIso;
  return new Date(t).toISOString();
}

/**
 * Ответственного и время ставит СЕРВЕР: клиент не может подписаться чужим именем. Заодно собирает строки истории и журнала.
 * acc — накопитель по всему запросу.
 */
function stampAndTrack_(b, who, today, nowMs, nowIso, idx, acc) {
  var group = function (date, kind) {
    var key = date + '|' + kind;
    return acc.sets[key] || (acc.sets[key] = { date: date, kind: kind, set: 0, changed: 0, cleared: 0, reasons: 0, classes: {} });
  };
  // Сначала удаления, потом записи — так же, как applyChanges_, чтобы история и база не расходились.
  (b.del.rounds || []).forEach(function (id) {
    var info = parseRoundId_(id);
    var prev = idx['k' + id];
    if (prev && roundFresh_(info.date, info.kind, today)) {
      group(info.date, info.kind).cleared++;
      acc.marks.push([nowIso, info.date, info.kind, prev.studentId, prev.classId || '', '', '', who.name, who.role, who.id, nowIso]);
    }
    delete idx['k' + id];
    delete acc.patched['k' + id];
  });
  (b.put.rounds || []).forEach(function (r) {
    var kind = kindOfRec_(r);
    var prev = idx['k' + r.id];
    if (prev && prev.place === r.place) {
      // Тот же статус (например, добавлена причина или запись отправлена повторно): автор и время первой отметки остаются.
      r.by = prev.by || who.name;
      r.at = prev.at || clampAt_(r.at || r.updatedAt, nowMs, nowIso);
    } else {
      r.by = who.name;
      r.at = clampAt_(r.at || r.updatedAt, nowMs, nowIso);
    }
    var g = group(r.date, kind);
    var changed = true;
    if (!prev) g.set++;
    else if (prev.place !== r.place) {
      g.changed++;
      if (acc.changes.length < 20) acc.changes.push({ date: r.date, kind: kind, studentId: r.studentId, from: prev.place, to: r.place });
    } else if (String(prev.reason || '') !== String(r.reason || '')) g.reasons++;
    else changed = false;
    if (r.classId) g.classes[r.classId] = 1;
    if (changed) acc.marks.push([nowIso, r.date, kind, r.studentId, r.classId || '', r.place, r.reason || '', r.by, who.role, who.id, r.at]);
    idx['k' + r.id] = r;
    acc.patched['k' + r.id] = r;
  });
}

/** Сервер — единственный, кто чистит старые отметки (устройства не должны слать десятки удалений). Возвращает, сколько убрано. */
function pruneRounds_(state, today) {
  var before = (state.rounds || []).length;
  state.rounds = (state.rounds || []).filter(function (r) { return roundFresh_(r.date, kindOfRec_(r), today); });
  return before - state.rounds.length;
}

/** История отметок: по листу на год («_Отметки 2026»). Строки только добавляются; последняя запись по ключу — итоговая. */
function appendMarks_(ss, rows) {
  var byYear = {};
  rows.forEach(function (r) { var y = String(r[1]).substring(0, 4); (byYear[y] = byYear[y] || []).push(r); });
  Object.keys(byYear).forEach(function (y) {
    var name = MARKS_PREFIX_ + y;
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, MARKS_HEADER_.length).setValues([MARKS_HEADER_]);
      sh.hideSheet();
    }
    var range = sh.getRange(sh.getLastRow() + 1, 1, byYear[y].length, MARKS_HEADER_.length);
    range.setNumberFormat('@');
    range.setValues(byYear[y]);
  });
}

/** Итоговое состояние отметок за период (последняя запись по дате, виду и ученику). Читает лист с конца и останавливается, когда дальше только давние записи. */
function finalMarks_(from, to, f) {
  var ss = openSpreadsheet_();
  var seen = {}, out = [];
  var floorAt = shiftDay_(from, -3);
  for (var y = Number(to.substring(0, 4)); y >= Number(from.substring(0, 4)); y--) {
    var sh = ss.getSheetByName(MARKS_PREFIX_ + y);
    if (!sh || sh.getLastRow() < 2) continue;
    var pos = sh.getLastRow(), done = false;
    while (pos >= 2 && !done) {
      var start = Math.max(2, pos - 999);
      var block = sh.getRange(start, 1, pos - start + 1, MARKS_HEADER_.length).getValues();
      for (var i = block.length - 1; i >= 0; i--) {
        var r = block[i];
        var date = String(r[1]), kind = String(r[2]);
        var key = date + '|' + kind + '|' + r[3];
        if (seen[key]) continue;
        seen[key] = 1;
        if (!r[5] || date < from || date > to) continue;
        if (f.kind && kind !== f.kind) continue;
        if (f.classId && String(r[4]) !== f.classId) continue;
        if (f.studentId && String(r[3]) !== f.studentId) continue;
        if (f.by && String(r[7]) !== f.by) continue;
        out.push({ date: date, kind: kind, studentId: String(r[3]), classId: String(r[4]), place: String(r[5]), reason: String(r[6]), by: String(r[7]), at: String(r[10]) });
        if (out.length > (f.cap || MAX_MARK_ROWS_)) return { tooMany: true, list: [] };
      }
      if (String(block[0][0]).substring(0, 10) < floorAt) done = true;
      pos = start - 1;
    }
  }
  return { tooMany: false, list: out };
}

function rangeOf_(p) {
  var from = String(p.from || ''), to = String(p.to || '');
  if (!isoDate_(from) || !isoDate_(to) || from > to) return { error: 'bad-range' };
  if (dayDiff_(from, to) > MAX_RANGE_DAYS_) return { error: 'range-too-long' };
  return { from: from, to: to };
}

/** Чтение журнала (администратор): новые сверху, фильтры по времени, событиям, участнику и объекту; before — номер строки для «показать ещё». */
function readAudit_(f) {
  var sh = openSpreadsheet_().getSheetByName(AUDIT_SHEET_);
  if (!sh || sh.getLastRow() < 2) return { rows: [], next: null };
  var limit = Math.min(Math.max(Number(f.limit) || 100, 1), 200);
  var pos = f.before ? Math.min(Number(f.before) - 1, sh.getLastRow()) : sh.getLastRow();
  var events = Array.isArray(f.events) && f.events.length ? f.events : null;
  var actor = String(f.actor || '').toLowerCase(), target = String(f.target || '').toLowerCase();
  var fromAt = String(f.fromAt || ''), toAt = String(f.toAt || '');
  var rows = [], last = pos + 1;
  while (pos >= 2 && rows.length < limit) {
    var start = Math.max(2, pos - 499);
    var block = sh.getRange(start, 1, pos - start + 1, AUDIT_HEADER_.length).getValues();
    for (var i = block.length - 1; i >= 0 && rows.length < limit; i--) {
      var r = block[i];
      last = start + i;
      var at = String(r[0]);
      if (fromAt && at < fromAt) { return { rows: rows, next: null }; } // дальше — только более давние записи
      if (toAt && at > toAt) continue;
      if (events && events.indexOf(String(r[1])) < 0) continue;
      if (actor && String(r[2]).toLowerCase().indexOf(actor) < 0 && String(r[3]).toLowerCase().indexOf(actor) < 0 && String(r[4]).toLowerCase().indexOf(actor) < 0) continue;
      if (target && String(r[5]).toLowerCase().indexOf(target) < 0 && String(r[6]).toLowerCase().indexOf(target) < 0) continue;
      rows.push([start + i, at, String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5]), String(r[6])]);
    }
    pos = start - 1;
  }
  return { rows: rows, next: last > 2 && rows.length >= limit ? last : null };
}

/** Сводка по периоду: по дням, по классам и (для одного класса) по ученикам. Праздничные дни из календаря не считаются. */
function statsFor_(p) {
  var rg = rangeOf_(p);
  if (rg.error) return { ok: false, error: rg.error };
  var kind = KINDS_.indexOf(p.kind) >= 0 ? p.kind : 'evening';
  var res = finalMarks_(rg.from, rg.to, { kind: kind, classId: p.classId ? String(p.classId) : '', cap: MAX_STAT_ROWS_ });
  if (res.tooMany) return { ok: false, error: 'too-many' };
  var ss = openSpreadsheet_();
  var holidays = {};
  try {
    var st = JSON.parse(readChunks_(ss, BACKUP_SHEET_) || '{}');
    (st.days || []).forEach(function (d) { if (d.holiday) holidays[d.date] = 1; });
  } catch (e) { /* без календаря */ }
  var perDay = {}, perClass = {}, perStudent = {};
  var slot = function (m, k) { return m[k] || (m[k] = { sleeping: 0, sick: 0, home: 0, absent: 0 }); };
  res.list.forEach(function (m) {
    if (holidays[m.date]) return;
    slot(perDay, m.date)[m.place]++;
    slot(perClass, m.classId)[m.place]++;
    if (p.classId) slot(perStudent, m.studentId)[m.place]++;
  });
  var row = function (k, o) { return [k, o.sleeping, o.sick, o.home, o.absent]; };
  return {
    ok: true,
    perDay: Object.keys(perDay).sort().map(function (k) { return row(k, perDay[k]); }),
    perClass: Object.keys(perClass).sort().map(function (k) { return row(k, perClass[k]); }),
    perStudent: Object.keys(perStudent).map(function (k) { return row(k, perStudent[k]); }),
    days: Object.keys(perDay).length,
    holidays: Object.keys(holidays).filter(function (d) { return d >= rg.from && d <= rg.to; }).length,
  };
}

/**
 * Общая база. Все запросы: { type:'live', action, token | device, … }. В каждом ответе есть role — роль, которую сервер сам определил
 * (admin — владелец по токену или устройство-администратор; user — допущенное устройство дежурного).
 *   pull  { sinceRev }            → { rev, same:true } или { rev, data } (data = полная база; для user — без дат рождения, заметок, контактов)
 *   push  { baseRev, batches }    → { rev, applied, rejected, patched, data? } — применяет пакеты по порядку; user может менять только отметки обхода
 *   --- только администратор ---
 *   seed  { data, force? }        → первая версия базы (force — только владелец по токену)
 *   sheets{ sheets }              → читаемые листы («Ученики», «Классы» …); не чаще раза в 15 секунд
 *   log   { fromAt,toAt,events,actor,target,before,limit } → журнал действий
 *   marks { from,to,kind,classId,studentId,by,purpose,exportKind }  → итоговые отметки за период (purpose:'export' пишет в журнал выгрузку)
 *   stats { from,to,kind,classId } → сводка по дням / классам / ученикам
 *   exportlog { exportKind, from, to, rows } → записать в журнал выгрузку, сделанную на устройстве
 */
function handleLive_(p) {
  var who = who_(p);
  if (!who) {
    failedLogin_(p);
    return json_({ ok: false, error: checkToken_('x') === 'not-configured' ? 'not-configured' : 'forbidden' });
  }
  var action = String(p.action || '');
  var isAdmin = who.role === 'admin';
  if (['seed', 'sheets', 'log', 'marks', 'stats', 'exportlog'].indexOf(action) >= 0 && !isAdmin) return json_({ ok: false, error: 'forbidden' });

  // Чтение журнала и отчётов не меняет базу и не требует блокировки.
  if (action === 'log') {
    var lg = readAudit_(p);
    return json_({ ok: true, role: who.role, rows: lg.rows, next: lg.next });
  }
  if (action === 'marks') {
    var rg = rangeOf_(p);
    if (rg.error) return json_({ ok: false, error: rg.error });
    var res = finalMarks_(rg.from, rg.to, { kind: KINDS_.indexOf(p.kind) >= 0 ? p.kind : '', classId: p.classId ? String(p.classId) : '', studentId: p.studentId ? String(p.studentId) : '', by: p.by ? String(p.by) : '' });
    if (res.tooMany) return json_({ ok: false, error: 'too-many' });
    if (p.purpose === 'export') audit_('export', who, cleanText_(p.exportKind, 40) || 'период', { from: rg.from, to: rg.to, rows: res.list.length, kind: p.kind || 'all' });
    return json_({ ok: true, role: who.role, rows: res.list.map(function (m) { return [m.date, m.kind, m.studentId, m.classId, m.place, m.reason, m.by, m.at]; }) });
  }
  if (action === 'stats') {
    var st = statsFor_(p);
    st.role = who.role;
    return json_(st);
  }
  if (action === 'exportlog') {
    audit_('export', who, cleanText_(p.exportKind, 40) || 'день', { from: cleanText_(p.from, 10), to: cleanText_(p.to, 10), rows: Math.max(0, Math.floor(Number(p.rows) || 0)) });
    return json_({ ok: true, role: who.role });
  }

  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    if (action === 'pull') {
      var since = Number(p.sinceRev);
      if (since === getRev_()) return json_({ ok: true, rev: since, same: true, role: who.role });
    }
    if (action === 'sheets') {
      var last = Number(PropertiesService.getScriptProperties().getProperty('SHEETS_AT') || 0);
      if (Date.now() - last < SHEETS_MIN_GAP_MS_ || !lock.tryLock(5000)) return json_({ ok: true, skipped: true, role: who.role });
    } else lock.waitLock(30000);
    locked = true;
    var ss = openSpreadsheet_();
    var rev = getRev_();

    if (action === 'pull') {
      var text = rev > 0 ? readChunks_(ss, BACKUP_SHEET_) : '';
      if (!text) return json_({ ok: true, rev: 0, data: null, role: who.role });
      if (isAdmin) return jsonRaw_('{"ok":true,"rev":' + rev + ',"role":"admin","data":' + text + '}');
      return json_({ ok: true, rev: rev, role: who.role, data: projectForUser_(JSON.parse(text)) });
    }

    if (action === 'push') {
      var current = rev > 0 ? readChunks_(ss, BACKUP_SHEET_) : '';
      if (!current) return json_({ ok: false, error: 'no-state', role: who.role });
      var state = JSON.parse(current);
      var batches = Array.isArray(p.batches) ? p.batches.slice(0, MAX_BATCHES_) : [];
      var applied = 0, rejected = 0, stop = false, big = false, totalOps = 0;
      var today = serverToday_(), nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();
      var students = {}, idx = {};
      (state.students || []).forEach(function (x) { students['k' + x.id] = 1; });
      (state.rounds || []).forEach(function (r) { idx['k' + r.id] = r; });
      var acc = { marks: [], sets: {}, changes: [], patched: {}, other: {}, promotion: false, cleared: [], settings: {} };
      batches.forEach(function (raw) {
        var b = normalizeBatch_(raw);
        if (stop || !b) { rejected++; stop = true; return; }
        totalOps += b.puts + b.dels;
        if (totalOps > MAX_OPS_) { rejected++; stop = true; return; }
        var stale = staleRoundDels_(b, today);
        // Очистка и массовое удаление — только владелец (токен); устройство-администратор правит записи, но не стирает базу.
        if (!who.owner && (b.clear.length || b.dels - stale > VISITOR_MAX_DELETE_)) { rejected++; stop = true; return; }
        // Пользователь (дежурный) меняет только отметки обхода: ни базу, ни настройки.
        if (!isAdmin && nonRoundOps_(b)) { rejected++; stop = true; return; }
        if (dropBadRounds_(b, students, today)) rejected++;
        // Смена учебного года (и отмена перехода) выполняется только над тем годом, который видел автор.
        if (raw.expect && state.settings.currentYearId !== raw.expect) { rejected++; stop = true; return; }
        if (b.clear.length || b.dels - staleRoundDels_(b, today) >= BIG_DELETE_) big = true;
        stampAndTrack_(b, who, today, nowMs, nowIso, idx, acc);
        applyChanges_(state, b);
        DATA_STORES_.forEach(function (s) {
          if (s === 'rounds') return;
          var n = (b.put[s] || []).length, d = (b.del[s] || []).length;
          if (n || d) { var o = acc.other[s] || (acc.other[s] = { put: 0, del: 0 }); o.put += n; o.del += d; }
        });
        if (raw.expect) acc.promotion = true;
        b.clear.forEach(function (s) { if (acc.cleared.indexOf(s) < 0) acc.cleared.push(s); });
        Object.keys(b.settings).forEach(function (k) { acc.settings[k] = 1; });
        students = {};
        (state.students || []).forEach(function (x) { students['k' + x.id] = 1; });
        applied++;
      });
      var newRev = rev;
      var body = current;
      if (applied) {
        pruneRounds_(state, today);
        state.exportedAt = nowIso;
        body = JSON.stringify(state);
        if (body.length > MAX_STATE_) return json_({ ok: false, error: 'too-big', role: who.role }); // база не должна разрастаться без предела
        if (big) writeChunks_(ss, UNDO_SHEET_, current);
        writeBackup_(ss, body);
        newRev = rev + 1;
        setRev_(newRev);
        if (acc.marks.length) appendMarks_(ss, acc.marks);
        var rowsA = [];
        Object.keys(acc.sets).forEach(function (k) {
          var g = acc.sets[k];
          if (!(g.set || g.changed || g.cleared || g.reasons)) return;
          var cls = Object.keys(g.classes);
          rowsA.push(auditRow_('round-set', who, g.date + ' ' + g.kind, { date: g.date, kind: g.kind, set: g.set, changed: g.changed, cleared: g.cleared, reasons: g.reasons, classes: cls.length, first: cls.slice(0, 4) }, nowIso));
        });
        acc.changes.forEach(function (c) { rowsA.push(auditRow_('round-change', who, c.date + ' ' + c.kind, { studentId: c.studentId, from: c.from, to: c.to }, nowIso)); });
        if (Object.keys(acc.other).length) rowsA.push(auditRow_('data', who, '', acc.other, nowIso));
        if (acc.promotion) rowsA.push(auditRow_('promotion', who, '', {}, nowIso));
        if (acc.cleared.length) rowsA.push(auditRow_('clear', who, acc.cleared.join(','), {}, nowIso));
        if (Object.keys(acc.settings).length) rowsA.push(auditRow_('settings', who, Object.keys(acc.settings).join(','), {}, nowIso));
        auditMany_(rowsA);
        appendLog_(ss, ['live-push', who.name, applied + ' пакет(ов), отклонено ' + rejected, 'v' + newRev]);
      } else if (rejected) {
        auditMany_([auditRow_('push-rejected', who, '', { batches: rejected }, nowIso)]);
        appendLog_(ss, ['live-reject', who.name, rejected + ' пакет(ов)', 'v' + rev]);
      }
      var patched = Object.keys(acc.patched).map(function (k) { return acc.patched[k]; });
      var same = Number(p.baseRev) === rev && !rejected; // база не менялась без нас: устройству не нужна копия
      if (same) return json_({ ok: true, rev: newRev, applied: applied, rejected: 0, role: who.role, patched: { rounds: patched } });
      if (isAdmin) return jsonRaw_('{"ok":true,"rev":' + newRev + ',"applied":' + applied + ',"rejected":' + rejected + ',"role":"admin","patched":' + JSON.stringify({ rounds: patched }) + ',"data":' + body + '}');
      return json_({ ok: true, rev: newRev, applied: applied, rejected: rejected, role: who.role, patched: { rounds: patched }, data: projectForUser_(JSON.parse(body)) });
    }

    if (action === 'seed') {
      if (rev > 0 && !(who.owner && p.force === true)) return json_({ ok: false, error: 'exists' });
      var d = p.data;
      if (!validSnapshot_(d) || JSON.stringify(d).length > MAX_STATE_) return json_({ ok: false, error: 'bad-data' });
      var snap = { format: d.format, version: d.version, exportedAt: new Date().toISOString(), app: d.app || '', settings: {} };
      SHARED_KEYS_.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(d.settings, k)) snap.settings[k] = d.settings[k]; });
      DATA_STORES_.forEach(function (s) { snap[s] = d[s] || []; });
      if (rev > 0) writeChunks_(ss, UNDO_SHEET_, readChunks_(ss, BACKUP_SHEET_));
      writeBackup_(ss, JSON.stringify(snap));
      setRev_(rev + 1);
      appendLog_(ss, ['live-seed', who.name, d.students ? d.students.length + ' учеников' : '', 'v' + (rev + 1)]);
      audit_('seed', who, '', { students: d.students ? d.students.length : 0, force: p.force === true });
      return json_({ ok: true, rev: rev + 1, role: who.role });
    }

    if (action === 'sheets') {
      var sheetsIn = p.sheets;
      if (!sheetsIn || typeof sheetsIn !== 'object') return json_({ ok: false, error: 'bad-data' });
      var written = {};
      SHEET_NAMES_.forEach(function (name) {
        var sh = sheetsIn[name];
        if (sh) { var c = cleanSheet_(sh); if (c.header.length) written[name] = writeSheet_(ss, name, c.header, c.rows); }
      });
      var props = PropertiesService.getScriptProperties();
      props.setProperty('SHEETS_AT', String(Date.now()));
      props.setProperty('LAST_SYNC', new Date().toISOString());
      props.setProperty('LAST_COUNTS', JSON.stringify(written));
      SpreadsheetApp.flush();
      return json_({ ok: true, written: written, role: who.role });
    }
    return json_({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (x) { /* блокировка не была взята */ } }
  }
}

/** Лист от устройства: только числа и короткий текст, не больше 3000 строк × 20 столбцов (остальное отбрасывается). */
function cleanSheet_(sh) {
  var cell = function (v) { return typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' ? v.substring(0, 500) : ''; };
  var width = Math.min(20, Array.isArray(sh.header) ? sh.header.length : 0);
  var header = (Array.isArray(sh.header) ? sh.header : []).slice(0, width).map(cell);
  var rows = (Array.isArray(sh.rows) ? sh.rows : []).slice(0, 3000).map(function (r) {
    var row = (Array.isArray(r) ? r : []).slice(0, width).map(cell);
    while (row.length < width) row.push('');
    return row;
  });
  return { header: header, rows: rows };
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
/** Строка в конец листа как обычный текст: введённое посетителем («=IMAGE(…)») не станет формулой. */
function appendText_(sh, row) {
  var range = sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
  range.setNumberFormat('@');
  range.setValues([row.map(function (v) { return v instanceof Date ? v.toISOString() : v; })]);
}

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
  appendText_(sh, [new Date()].concat(cells));
  if (sh.getLastRow() > 1000) sh.deleteRows(1, sh.getLastRow() - 1000);
  if (!sh.isSheetHidden()) sh.hideSheet();
}
