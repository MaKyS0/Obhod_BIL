// Состояние приложения в памяти + запись в базу + уведомления подписчиков и других вкладок.
import { applyChanges, defaultSettings, emptyState, DATA_STORES, invalidate } from '../domain/state.js';
import { exportData } from '../domain/backup.js';
import { sharedBatch } from '../domain/live.js';
import { uid } from '../domain/ids.js';

const KEEP_BACKUPS = 10;

export function createStore(db) {
  let state = emptyState();
  const listeners = new Set();
  let channel = null;
  let version = 0;
  let live = false; // общая база подключена: изменения данных копятся в очереди отправки (settings.liveOutbox)
  let chain = Promise.resolve(); // все записи идут по очереди, чтобы пакеты не перемешивались

  const emit = (detail) => listeners.forEach((fn) => fn(detail));

  async function load(detail = {}) {
    const data = await db.loadAll();
    const next = emptyState();
    next.settings = { ...defaultSettings(), ...(data.settings || {}) };
    for (const s of DATA_STORES) next[s] = data[s] || [];
    invalidate(next);
    state = next;
    emit({ reason: 'load', ...detail });
  }

  async function doCommit(changes, opts) {
    const patch = { ...(changes.settings || {}) };
    if (!opts.system && !opts.remote) {
      if (!('changesSincePromotion' in patch) && state.settings.lastPromotionId) patch.changesSincePromotion = (state.settings.changesSincePromotion || 0) + 1;
      if (!('dirtySinceSync' in patch)) patch.dirtySinceSync = true;
    }
    if (live && !opts.remote) {
      // Изменение данных → в очередь отправки, в той же транзакции, что и сама запись.
      const batch = sharedBatch(changes, patch);
      if (batch) patch.liveOutbox = [...(patch.liveOutbox ?? state.settings.liveOutbox ?? []), { ...batch, expect: opts.expectCurrentYear || null, bid: uid() }];
    }
    const newSettings = { ...state.settings, ...patch, key: 'settings' };
    const full = { put: { ...(changes.put || {}), meta: [newSettings] }, del: changes.del || {}, clear: changes.clear || [] };
    await db.apply(full, { expectCurrentYear: opts.expectCurrentYear });
    applyChanges(state, { put: changes.put, del: changes.del, clear: changes.clear, settings: patch });
    if (!opts.system && !opts.remote) version++;
    // Изменения, пришедшие от других людей, обновляют экран (reason: 'remote'); тихие — только служебные поля.
    emit({ reason: opts.remote ? 'remote' : 'commit', system: opts.remote ? !!opts.quiet : !!opts.system });
    if (channel && !opts.silent) channel.postMessage({ type: 'changed' });
  }

  const enqueue = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  /**
   * Применяет пакет изменений атомарно: сначала база, потом память.
   * opts.system — служебная запись (статус синхронизации и т. п.): не помечает данные «изменёнными».
   * opts.expectCurrentYear — проверка текущего года внутри транзакции.
   * opts.remote — изменения пришли из общей базы: не попадают в очередь отправки.
   */
  const commit = (changes, opts = {}) => enqueue(() => doCommit(changes, opts));

  // Как commit, но пакет считается по свежему состоянию уже внутри очереди (compute возвращает { changes, opts } или null).
  const commitFrom = (compute) =>
    enqueue(async () => {
      const r = compute(state);
      if (r) await doCommit(r.changes, r.opts || {});
      return !!r;
    });

  async function createBackup(reason = 'manual') {
    const data = exportData(state);
    const counts = { students: state.students.length, staff: state.staff.length, classes: state.classes.length, years: state.years.length };
    const id = await db.addBackup({ createdAt: new Date().toISOString(), reason, counts, data });
    const list = await db.listBackups();
    for (const b of list.slice(KEEP_BACKUPS)) await db.deleteBackup(b.id);
    await commit({ settings: { lastBackupAt: new Date().toISOString() } }, { system: true, silent: true });
    return id;
  }

  function listenOtherTabs() {
    if (typeof BroadcastChannel === 'undefined' || db.kind !== 'indexeddb') return;
    channel = new BroadcastChannel('lyceum-registry');
    channel.onmessage = () => load({ reason: 'external' });
  }

  return {
    db,
    get state() {
      return state;
    },
    get version() {
      return version;
    },
    get live() {
      return live;
    },
    setLive(v) {
      live = !!v;
    },
    load,
    commit,
    commitFrom,
    createBackup,
    listenOtherTabs,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
