// Слой хранения: IndexedDB (основной) с автоматическим переходом на память, если база недоступна.
import { DATA_STORES } from '../domain/state.js';
import { createMemoryDb } from './memory-db.js';

const DB_NAME = 'lyceum-db';
const DB_VERSION = 1;

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Миграции: switch по oldVersion при будущих изменениях схемы.
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      for (const s of DATA_STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('backups')) db.createObjectStore('backups', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Не удалось открыть IndexedDB'));
    req.onblocked = () => reject(new Error('Открытие базы заблокировано другой вкладкой'));
  });
}

function createIdbDb(db, hooks) {
  db.onversionchange = () => {
    db.close();
    hooks.onVersionChange?.();
  };
  return {
    kind: 'indexeddb',
    async loadAll() {
      const tx = db.transaction(['meta', ...DATA_STORES], 'readonly');
      const out = { settings: (await reqP(tx.objectStore('meta').get('settings'))) || null };
      for (const s of DATA_STORES) out[s] = await reqP(tx.objectStore(s).getAll());
      return out;
    },
    apply(changes, opts = {}) {
      return new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(['meta', ...DATA_STORES], 'readwrite');
        } catch (e) {
          reject(e);
          return;
        }
        let failure = null;
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          failure = failure || tx.error;
        };
        tx.onabort = () => reject(failure || tx.error || new Error('Транзакция отменена'));
        const write = () => {
          for (const s of changes.clear || []) tx.objectStore(s).clear();
          for (const [s, ids] of Object.entries(changes.del || {})) {
            const os = tx.objectStore(s);
            for (const id of ids) os.delete(id);
          }
          for (const [s, recs] of Object.entries(changes.put || {})) {
            const os = tx.objectStore(s);
            for (const r of recs) os.put(r);
          }
        };
        if (opts.expectCurrentYear) {
          // Проверка внутри той же транзакции: защита от двойного клика и от второй вкладки.
          const r = tx.objectStore('meta').get('settings');
          r.onsuccess = () => {
            if (!r.result || r.result.currentYearId !== opts.expectCurrentYear) {
              const err = new Error('Учебный год уже изменён (возможно, в другой вкладке). Обновите страницу.');
              err.code = 'STALE';
              failure = err;
              tx.abort();
              return;
            }
            write();
          };
        } else write();
      });
    },
    // Полное удаление базы (включая резервные копии в браузере) — при отзыве доступа.
    async wipe() {
      db.close();
      await new Promise((res, rej) => {
        const r = indexedDB.deleteDatabase(DB_NAME);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
        r.onblocked = () => res();
      });
    },
    async addBackup(rec) {
      const tx = db.transaction('backups', 'readwrite');
      const id = await reqP(tx.objectStore('backups').add(rec));
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('Не удалось сохранить резервную копию'));
      });
      return id;
    },
    async listBackups() {
      const all = await reqP(db.transaction('backups', 'readonly').objectStore('backups').getAll());
      return all.map(({ data: _d, ...meta }) => meta).sort((a, b) => b.id - a.id);
    },
    async getBackup(id) {
      return (await reqP(db.transaction('backups', 'readonly').objectStore('backups').get(id))) || null;
    },
    async deleteBackup(id) {
      const tx = db.transaction('backups', 'readwrite');
      tx.objectStore('backups').delete(id);
      await new Promise((res, rej) => {
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
  };
}

export async function openDb(hooks = {}) {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB недоступна в этом браузере');
    const db = await Promise.race([openIdb(), new Promise((_, rej) => setTimeout(() => rej(new Error('IndexedDB не отвечает')), 4000))]);
    return createIdbDb(db, hooks);
  } catch (e) {
    return createMemoryDb(e && e.message ? e.message : 'IndexedDB недоступна');
  }
}
