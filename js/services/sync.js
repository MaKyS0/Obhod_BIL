// Синхронизация с Google Таблицами через Google Apps Script Web App.
import { buildSheetsPayload } from '../domain/sheets-payload.js';
import { nowISO, formatDateTime } from '../domain/dates.js';

const DAY = 24 * 3600 * 1000;
const RETRY_MIN = [5, 15, 60];

async function post(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Сервер вернул не JSON. Проверьте, что в «Доступ» выбрано «Все», и что адрес оканчивается на /exec.');
    }
    return { json, confirmed: true };
  } catch (e) {
    if (e instanceof TypeError && navigator.onLine !== false) {
      // Часто это ограничение CORS при доступе «только Google-аккаунт»: отправляем «вслепую».
      await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body });
      return { json: { ok: true }, confirmed: false };
    }
    throw e;
  }
}

export const isEmptyDb = (state) => !state.students.length && !state.staff.length;

export async function syncNow(store, repo, { reason = 'manual', allowEmpty = false } = {}) {
  const s = store.state.settings;
  if (!s.sheetsUrl) return { ok: false, error: 'Адрес Google Apps Script не указан в настройках' };
  // Защита: пустая база не должна затирать данные в таблице (например, в новом браузере владельца).
  if (!allowEmpty && isEmptyDb(store.state)) return { ok: false, empty: true, error: 'В этом браузере нет данных — выгрузка стёрла бы таблицу. Сначала загрузите данные (Импорт и экспорт).' };
  const versionAtStart = store.version;
  // В режиме общей базы полную копию хранит сама общая база (её версию ведёт сервер), поэтому отсюда она не отправляется.
  const payload = buildSheetsPayload(store.state, { includeBackup: s.includeBackupInSync && s.liveRev == null });
  try {
    const { json, confirmed } = await post(s.sheetsUrl, JSON.stringify(payload));
    if (!json.ok) throw new Error(json.error === 'auth' ? 'Неверный токен доступа' : json.error || 'Сервер отклонил данные');
    const clean = store.version === versionAtStart;
    await repoSettings(store, {
      lastSyncAt: nowISO(),
      lastSyncStatus: confirmed ? 'ok' : 'unconfirmed',
      ...(clean ? { dirtySinceSync: false } : {}),
    });
    return { ok: true, confirmed, written: json.written || null, reason };
  } catch (e) {
    await repoSettings(store, { lastSyncStatus: `error: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

function repoSettings(store, patch) {
  return store.commit({ settings: patch, put: {}, del: {} }, { system: true, silent: true });
}

export async function checkConnection(store) {
  const s = store.state.settings;
  if (!s.sheetsUrl) return { ok: false, error: 'Адрес Google Apps Script не указан' };
  try {
    const url = `${s.sheetsUrl}${s.sheetsUrl.includes('?') ? '&' : '?'}action=status&token=${encodeURIComponent(s.sheetsToken || '')}`;
    const res = await fetch(url, { redirect: 'follow' });
    const json = JSON.parse(await res.text());
    if (!json.ok) return { ok: false, error: json.error === 'auth' ? 'Неверный токен доступа' : json.error || 'Ошибка сервера' };
    return { ok: true, info: json };
  } catch (e) {
    return { ok: false, error: `Нет ответа от сервера: ${e.message}` };
  }
}

export function describeSync(settings) {
  if (!settings.sheetsUrl) return { kind: 'off', text: 'Google Таблицы не подключены' };
  const st = settings.lastSyncStatus;
  if (st && st.startsWith('error')) return { kind: 'error', text: `Ошибка синхронизации: ${st.slice(7)}` };
  if (!settings.lastSyncAt) return { kind: 'warn', text: 'Ещё не синхронизировано' };
  const when = formatDateTime(settings.lastSyncAt);
  const stale = Date.now() - new Date(settings.lastSyncAt).getTime() > DAY;
  const base = st === 'unconfirmed' ? `Отправлено без подтверждения: ${when}` : `Синхронизировано: ${when}`;
  return { kind: settings.dirtySinceSync ? 'warn' : stale ? 'warn' : 'ok', text: settings.dirtySinceSync ? `${base} (есть несинхронизированные изменения)` : base };
}

// Автосинхронизация: при открытии сайта, при возвращении на вкладку и раз в час.
export function startAutoSync(store, repo, { delayMs = 3000 } = {}) {
  let failures = 0;
  let timer = null;
  let running = false;

  const due = () => {
    const s = store.state.settings;
    if (!s.autoSync || !s.sheetsUrl) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (isEmptyDb(store.state)) return false;
    return s.dirtySinceSync || !s.lastSyncAt || Date.now() - new Date(s.lastSyncAt).getTime() > DAY;
  };

  async function tick(reason) {
    if (running || !due()) return;
    running = true;
    try {
      const run = () => syncNow(store, repo, { reason });
      const r = navigator.locks ? await navigator.locks.request('lyceum-sync', { ifAvailable: true }, (lock) => (lock ? run() : { ok: true, skipped: true })) : await run();
      if (r.ok) failures = 0;
      else {
        const min = RETRY_MIN[Math.min(failures, RETRY_MIN.length - 1)];
        failures++;
        clearTimeout(timer);
        timer = setTimeout(() => tick('retry'), min * 60000);
      }
    } finally {
      running = false;
    }
  }

  setTimeout(() => tick('open'), delayMs);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick('visible'));
  setInterval(() => tick('hourly'), 3600 * 1000);
  return { tick };
}
