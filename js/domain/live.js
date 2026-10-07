// Общая база: чистые функции (без сети и без хранилища). Те же правила применяет сервер (Code.gs → applyChanges_).
import { DATA_STORES, OPTIONAL_STORES, SHARED_SETTINGS, applyChanges, emptyState, invalidate } from './state.js';
import { FORMAT } from './backup.js';

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
};

/**
 * Часть пакета изменений, которую нужно отправить всем: записи данных и общие настройки.
 * Возвращает null, если отправлять нечего (например, сменился только статус синхронизации).
 */
export function sharedBatch(changes, patch) {
  const put = {};
  const del = {};
  for (const s of DATA_STORES) {
    if (changes.put && changes.put[s] && changes.put[s].length) put[s] = changes.put[s];
    if (changes.del && changes.del[s] && changes.del[s].length) del[s] = changes.del[s];
  }
  const clear = (changes.clear || []).filter((s) => DATA_STORES.includes(s));
  const settings = pick(patch || {}, SHARED_SETTINGS);
  if (!Object.keys(put).length && !Object.keys(del).length && !clear.length && !Object.keys(settings).length) return null;
  return { put, del, clear, settings };
}

// Применяет один пакет из очереди к состоянию (так же, как это делает сервер).
export function applyBatch(state, batch) {
  applyChanges(state, { put: batch.put || {}, del: batch.del || {}, clear: batch.clear || [], settings: batch.settings && Object.keys(batch.settings).length ? batch.settings : null });
  return state;
}

/** Проверка снимка общей базы, полученного с сервера. */
export function isUsableSnapshot(data) {
  if (!data || typeof data !== 'object' || data.format !== FORMAT) return false;
  if (typeof data.version !== 'number') return false;
  for (const s of DATA_STORES) if (!Array.isArray(data[s]) && !(OPTIONAL_STORES.includes(s) && data[s] === undefined)) return false;
  const st = data.settings;
  return !!(st && typeof st === 'object' && typeof st.currentYearId === 'string' && data.years.some((y) => y.id === st.currentYearId));
}

/** Состояние «как на сервере» + ещё не отправленные локальные пакеты поверх него. Локальные настройки сохраняются. */
export function stateFromSnapshot(snapshot, localSettings, pendingBatches = []) {
  const next = emptyState();
  next.settings = { ...localSettings, ...pick(snapshot.settings, SHARED_SETTINGS) };
  for (const s of DATA_STORES) next[s] = (snapshot[s] || []).map((x) => ({ ...x }));
  for (const b of pendingBatches) applyBatch(next, b);
  invalidate(next);
  return next;
}

/** Минимальный пакет изменений, переводящий состояние cur в next (только записи; настройки считает вызывающий). */
export function diffStates(cur, next) {
  const put = {};
  const del = {};
  let count = 0;
  for (const s of DATA_STORES) {
    const have = new Map(cur[s].map((x) => [x.id, JSON.stringify(x)]));
    const want = new Map(next[s].map((x) => [x.id, x]));
    for (const [id, rec] of want) {
      if (have.get(id) !== JSON.stringify(rec)) (put[s] ||= []).push(rec);
    }
    for (const id of have.keys()) if (!want.has(id)) (del[s] ||= []).push(id);
    count += (put[s]?.length || 0) + (del[s]?.length || 0);
  }
  return { put, del, count };
}

export const sharedSettingsOf = (settings) => pick(settings, SHARED_SETTINGS);

export function sharedSettingsChanged(a, b) {
  return SHARED_SETTINGS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
