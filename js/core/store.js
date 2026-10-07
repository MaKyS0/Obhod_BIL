// Состояние приложения в памяти + запись в базу + уведомления подписчиков и других вкладок.
import { applyChanges, defaultSettings, emptyState, DATA_STORES, invalidate } from '../domain/state.js';
import { exportData } from '../domain/backup.js';

const KEEP_BACKUPS = 10;

export function createStore(db) {
  let state = emptyState();
  const listeners = new Set();
  let channel = null;
  let version = 0;

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

  /**
   * Применяет пакет изменений атомарно: сначала база, потом память.
   * opts.system — служебная запись (статус синхронизации и т. п.): не помечает данные «изменёнными».
   * opts.expectCurrentYear — проверка текущего года внутри транзакции.
   */
  async function commit(changes, opts = {}) {
    const patch = { ...(changes.settings || {}) };
    if (!opts.system) {
      if (!('changesSincePromotion' in patch) && state.settings.lastPromotionId) patch.changesSincePromotion = (state.settings.changesSincePromotion || 0) + 1;
      if (!('dirtySinceSync' in patch)) patch.dirtySinceSync = true;
    }
    const newSettings = { ...state.settings, ...patch, key: 'settings' };
    const full = { put: { ...(changes.put || {}), meta: [newSettings] }, del: changes.del || {}, clear: changes.clear || [] };
    await db.apply(full, { expectCurrentYear: opts.expectCurrentYear });
    applyChanges(state, { put: changes.put, del: changes.del, clear: changes.clear, settings: patch });
    if (!opts.system) version++;
    emit({ reason: 'commit', system: !!opts.system });
    if (channel && !opts.silent) channel.postMessage({ type: 'changed' });
  }

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
    load,
    commit,
    createBackup,
    listenOtherTabs,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
