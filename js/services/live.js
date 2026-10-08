// Общая база: все допущенные устройства работают с одними и теми же данными.
// Хранилище — Google Apps Script (скрытый лист «_Резерв» + номер версии). Сайт:
//   • отправляет свои изменения (очередь settings.liveOutbox живёт в той же транзакции, что и данные);
//   • раз в несколько секунд спрашивает, не изменилось ли что-то у других, и подтягивает изменения.
// Конфликты решаются по записям: побеждает последняя отправка; смена учебного года защищена проверкой.
import { exportData } from '../domain/backup.js';
import { buildSheetsPayload } from '../domain/sheets-payload.js';
import { isUsableSnapshot, stateFromSnapshot, diffStates, sharedSettingsOf, sharedSettingsChanged } from '../domain/live.js';
import { deviceSecret } from './access.js';

const isEmptyDb = (state) => !state.students.length && !state.staff.length;
const num = (name, dflt) => (typeof globalThis[name] === 'number' ? globalThis[name] : dflt);

export class LiveError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

async function call(endpoint, body) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ type: 'live', ...body }), redirect: 'follow' });
  } catch {
    throw new LiveError('offline', 'Нет связи с сервером');
  }
  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new LiveError('bad-response', 'Сервер вернул неожиданный ответ');
  }
  if (!json.ok) {
    // Старая версия скрипта не знает запросов общей базы и отвечает «auth» / «Неверный формат данных».
    if (json.error === 'auth' || json.error === 'unknown-action' || json.error === 'Неверный формат данных') throw new LiveError('outdated', 'Скрипт Google устарел: обновите Code.gs и сделайте новое развёртывание');
    throw new LiveError(json.error || 'server', json.error === 'forbidden' ? 'Доступ закрыт' : `Ошибка сервера: ${json.error}`);
  }
  return json;
}

const wire = ({ put, del, clear, settings, expect, bid }) => ({ put, del, clear, settings, expect, bid });

// role — роль, которую устройство получило при входе (admin | user); onRole срабатывает, если сервер вдруг ответил другой ролью (права изменили).
// canSheets — отправлять ли читаемые листы таблицы (только администратор).
export function createLive({ store, endpoint, getDevice = deviceSecret, onForbidden = () => {}, onConflict = () => {}, role: initialRole = null, onRole = () => {}, canSheets = true }) {
  let role = initialRole;
  const status = { state: store.state.settings.liveRev == null ? 'connecting' : 'online', lastOkAt: null, error: null };
  const subs = new Set();
  const notify = () => subs.forEach((fn) => fn(snapshotStatus()));
  const snapshotStatus = () => ({ ...status, pending: (store.state.settings.liveOutbox || []).length });
  let running = false;
  let again = false;
  let stopped = false;
  let timer = null;
  let kick = null;
  let sheetsTimer = null;
  let failures = 0;

  // Запрос к серверу с контролем роли: ответ всегда содержит role, определённую сервером.
  const request = async (body) => {
    const r = await call(endpoint, body);
    if (r.role && role && r.role !== role) { const prev = role; role = r.role; onRole(r.role, prev); } else if (r.role && !role) role = r.role;
    return r;
  };

  const settings = () => store.state.settings;
  const auth = () => ({ token: settings().sheetsToken || '', device: getDevice() });
  const quiet = { remote: true, quiet: true }; // служебные поля: экран не перерисовывается, но другие вкладки этого браузера перечитывают базу

  if (settings().liveRev != null) store.setLive(true);

  function applySnapshot(snapshot, rev, { sent = 0, dropOutbox = false } = {}) {
    return store.commitFrom((cur) => {
      const outbox = dropOutbox ? [] : (cur.settings.liveOutbox || []).slice(sent);
      const next = stateFromSnapshot(snapshot, cur.settings, outbox);
      const d = diffStates(cur, next);
      const changed = d.count > 0 || sharedSettingsChanged(cur.settings, next.settings);
      const patch = { ...sharedSettingsOf(next.settings), liveRev: rev, liveOutbox: outbox };
      return { changes: { put: d.put, del: d.del, settings: patch }, opts: changed ? { remote: true } : quiet };
    });
  }

  const finishPush = (rev, sent) =>
    store.commitFrom((cur) => ({ changes: { put: {}, del: {}, settings: { liveRev: rev, liveOutbox: (cur.settings.liveOutbox || []).slice(sent) } }, opts: quiet }));

  // Первое подключение этого браузера: забираем общую базу (или, если она пуста, отдаём свои данные).
  async function attach() {
    const r = await request({ ...auth(), action: 'pull', sinceRev: -1 });
    if (r.data) {
      if (!isUsableSnapshot(r.data)) throw new LiveError('bad-data', 'Общая база повреждена или создана другой версией сайта');
      if (!isEmptyDb(store.state)) await store.createBackup('before-live'); // прежние данные этого браузера остаются в «Резервных копиях»
      await applySnapshot(r.data, r.rev, { dropOutbox: true });
    } else if (!isEmptyDb(store.state)) {
      const s = await request({ ...auth(), action: 'seed', data: exportData(store.state) });
      await store.commit({ put: {}, del: {}, settings: { liveRev: s.rev, liveOutbox: [] } }, { system: true });
    } else {
      await store.commit({ put: {}, del: {}, settings: { liveRev: 0, liveOutbox: [] } }, { system: true });
    }
    store.setLive(true);
  }

  async function pull() {
    const r = await request({ ...auth(), action: 'pull', sinceRev: settings().liveRev });
    if (r.same) return;
    if (!isUsableSnapshot(r.data)) throw new LiveError('bad-data', 'Общая база повреждена или создана другой версией сайта');
    await applySnapshot(r.data, r.rev);
  }

  // Сервер подписал отметки (ответственный, время): подставляем подписи в локальные записи тихо, не трогая то, что ещё не отправлено.
  async function applyPatched(rounds, sentCount) {
    if (!rounds || !rounds.length) return;
    const pending = new Set();
    for (const b of (settings().liveOutbox || []).slice(sentCount)) {
      for (const r of (b.put && b.put.rounds) || []) pending.add(r.id);
      for (const id of (b.del && b.del.rounds) || []) pending.add(id);
    }
    await store.commitFrom((cur) => {
      const have = new Map((cur.rounds || []).map((r) => [r.id, r]));
      const put = rounds.filter((r) => have.has(r.id) && !pending.has(r.id) && (have.get(r.id).by !== r.by || have.get(r.id).at !== r.at));
      return { changes: { put: put.length ? { rounds: put } : {}, del: {}, settings: {} }, opts: quiet };
    });
  }

  async function push() {
    const sent = (settings().liveOutbox || []).slice(0, 200);
    let r;
    try {
      r = await request({ ...auth(), action: 'push', baseRev: settings().liveRev, batches: sent.map(wire) });
    } catch (e) {
      if (e.code !== 'no-state') throw e;
      // На сервере базу удалили: подключаемся заново и отдаём свои данные.
      store.setLive(false);
      await store.commit({ put: {}, del: {}, settings: { liveRev: null, liveOutbox: [] } }, { system: true });
      return;
    }
    if (r.data) {
      if (!isUsableSnapshot(r.data)) throw new LiveError('bad-data', 'Общая база повреждена или создана другой версией сайта');
      await applySnapshot(r.data, r.rev, { sent: sent.length });
    } else {
      await finishPush(r.rev, sent.length);
      await applyPatched(r.patched && r.patched.rounds, sent.length);
    }
    if (r.rejected) onConflict(r.rejected);
    scheduleSheets();
  }

  async function runOnce() {
    for (let i = 0; i < 5; i++) {
      const s = settings();
      if (s.liveRev == null) await attach();
      else if ((s.liveOutbox || []).length) await push();
      else {
        await pull();
        return;
      }
      if (!(settings().liveOutbox || []).length) return; // подключились или отправили — свежее состояние уже получено
    }
  }

  const locked = (fn) => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('lyceum-live', { ifAvailable: true }, (lock) => (lock ? fn() : undefined)) : fn());

  async function tick() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    try {
      await locked(runOnce);
      failures = 0;
      status.state = 'online';
      status.lastOkAt = Date.now();
      status.error = null;
    } catch (e) {
      failures++;
      status.error = e.message;
      if (e.code === 'forbidden') {
        status.state = 'forbidden';
        stopped = true;
        onForbidden();
      } else status.state = e.code === 'offline' ? 'offline' : 'error';
    } finally {
      running = false;
      notify();
      if (!stopped) {
        if (again) {
          again = false;
          setTimeout(tick, 0);
        } else schedule();
      }
    }
  }

  function schedule() {
    clearTimeout(timer);
    const base = typeof document !== 'undefined' && document.hidden ? num('__LYCEUM_LIVE_HIDDEN_MS__', 30000) : num('__LYCEUM_LIVE_MS__', 5000);
    const delay = Math.min(60000, base * 2 ** Math.min(failures, 4));
    timer = setTimeout(tick, failures ? delay : base);
    timer.unref?.();
  }

  function scheduleSheets() {
    clearTimeout(sheetsTimer);
    sheetsTimer = setTimeout(sendSheets, num('__LYCEUM_SHEETS_MS__', 20000));
    sheetsTimer.unref?.();
  }

  // Читаемые листы таблицы («Ученики», «Классы» …) обновляет тот, кто внёс изменение.
  async function sendSheets() {
    if (stopped || !canSheets || (settings().liveOutbox || []).length) return;
    try {
      await request({ ...auth(), action: 'sheets', sheets: buildSheetsPayload(store.state, { includeBackup: false }).sheets });
    } catch (e) {
      if (e.code === 'forbidden') return;
    }
  }

  // Изменили данные → отправить почти сразу (небольшая пауза, чтобы собрать серию правок в один запрос).
  store.on((detail) => {
    if (detail.reason !== 'commit' || !store.live || !(settings().liveOutbox || []).length) return;
    clearTimeout(kick);
    kick = setTimeout(tick, num('__LYCEUM_KICK_MS__', 250));
    kick.unref?.();
    notify();
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
    window.addEventListener('online', () => {
      failures = 0;
      tick();
    });
  }

  return {
    get status() {
      return snapshotStatus();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    tick,
    sendSheetsNow: sendSheets,
    /** Запрос администратора к серверу (журнал, отметки за период, сводки): { action, ...параметры } → ответ сервера. */
    request: (action, extra = {}) => request({ ...auth(), action, ...extra }),
    get role() { return role; },
    // Первое подключение с ожиданием (для нового браузера); для уже подключённого — просто запуск в фоне.
    async start({ wait = false, timeoutMs = 15000 } = {}) {
      const first = tick();
      if (wait) await Promise.race([first, new Promise((r) => setTimeout(r, timeoutMs))]);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(kick);
      clearTimeout(sheetsTimer);
    },
  };
}

export function describeLive(st) {
  if (st.state === 'forbidden') return { kind: 'error', text: 'Общая база: доступ закрыт' };
  if (st.state === 'offline') return { kind: 'warn', text: st.pending ? `Общая база: нет связи, ${st.pending} изм. ждут отправки` : 'Общая база: нет связи' };
  if (st.state === 'error') return { kind: 'error', text: `Общая база: ошибка (${st.error})` };
  if (st.state === 'connecting') return { kind: 'warn', text: 'Общая база: подключение…' };
  return st.pending ? { kind: 'warn', text: 'Общая база: отправка…' } : { kind: 'ok', text: 'Общая база: актуально' };
}
