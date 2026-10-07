// Хранилище в памяти с тем же API, что и IndexedDB-обёртка.
// Используется в приватном режиме (когда IndexedDB недоступна) и в тестах Node.
import { DATA_STORES } from '../domain/state.js';

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function createMemoryDb(reason = '') {
  const data = { meta: new Map() };
  for (const s of DATA_STORES) data[s] = new Map();
  const backups = new Map();
  let backupSeq = 0;
  return {
    kind: 'memory',
    fallbackReason: reason,
    async loadAll() {
      const out = { settings: data.meta.get('settings') ? clone(data.meta.get('settings')) : null };
      for (const s of DATA_STORES) out[s] = [...data[s].values()].map(clone);
      return out;
    },
    async apply(changes, opts = {}) {
      if (opts.expectCurrentYear) {
        const cur = data.meta.get('settings');
        if (!cur || cur.currentYearId !== opts.expectCurrentYear) {
          const err = new Error('Учебный год уже изменён (возможно, в другой вкладке). Обновите страницу.');
          err.code = 'STALE';
          throw err;
        }
      }
      for (const s of changes.clear || []) data[s].clear();
      for (const [s, ids] of Object.entries(changes.del || {})) for (const id of ids) data[s].delete(id);
      for (const [s, recs] of Object.entries(changes.put || {})) {
        for (const r of recs) data[s].set(s === 'meta' ? r.key : r.id, clone(r));
      }
    },
    async addBackup(rec) {
      const id = ++backupSeq;
      backups.set(id, clone({ ...rec, id }));
      return id;
    },
    async listBackups() {
      return [...backups.values()].map(({ data: _d, ...meta }) => meta).sort((a, b) => b.id - a.id);
    },
    async getBackup(id) {
      const b = backups.get(id);
      return b ? clone(b) : null;
    },
    async deleteBackup(id) {
      backups.delete(id);
    },
  };
}
