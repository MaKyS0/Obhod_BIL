// Структура состояния в памяти и применение пакета изменений (put / del / settings).
import { DEFAULT_LETTERS, MIN_GRADE, MAX_GRADE } from './classes.js';
import { yearFromDate } from './years.js';

export const DATA_STORES = ['years', 'classes', 'students', 'enrollments', 'staff', 'assignments', 'promotions', 'rounds'];
// Разделы, которых может не быть в старых копиях и в старой общей базе (появились позже): считаются пустыми.
export const OPTIONAL_STORES = ['rounds'];
export const SCHEMA_VERSION = 1;

// Настройки, общие для всех устройств (остальное — локальное: адрес и токен, статусы, служебные поля общей базы).
export const SHARED_SETTINGS = ['lyceumName', 'currentYearId', 'letters', 'minGrade', 'maxGrade', 'lastPromotionId', 'changesSincePromotion'];
// Служебные поля общей базы: хранятся только в этом браузере и не попадают в экспорт.
export const LIVE_SETTINGS = ['liveRev', 'liveOutbox'];

export function defaultSettings(now = new Date()) {
  return {
    key: 'settings',
    lyceumName: 'Лицей',
    currentYearId: yearFromDate(now),
    letters: [...DEFAULT_LETTERS],
    minGrade: MIN_GRADE,
    maxGrade: MAX_GRADE,
    sheetsUrl: '',
    sheetsToken: '',
    autoSync: true,
    includeBackupInSync: true,
    lastSyncAt: null,
    lastSyncStatus: null,
    dirtySinceSync: false,
    lastBackupAt: null,
    lastExportAt: null,
    lastPromotionId: null,
    changesSincePromotion: 0,
    initialized: false,
    schemaVersion: SCHEMA_VERSION,
    liveRev: null, // номер версии общей базы, с которой совпадает этот браузер (null — ещё не подключён)
    liveOutbox: [], // изменения, ещё не отправленные в общую базу
  };
}

export function emptyState() {
  const s = { settings: defaultSettings() };
  for (const k of DATA_STORES) s[k] = [];
  return s;
}

// Индексы по id, пересоздаются лениво после каждого изменения состояния.
export function getIndex(state) {
  if (state._idx) return state._idx;
  const byId = (arr) => new Map(arr.map((x) => [x.id, x]));
  const idx = {
    students: byId(state.students),
    classes: byId(state.classes),
    staff: byId(state.staff),
    years: byId(state.years),
    enrollmentsByYear: new Map(),
    enrollmentsByStudent: new Map(),
    assignmentsByYear: new Map(),
    assignmentsByStaff: new Map(),
    classesByYear: new Map(),
  };
  const push = (map, key, val) => {
    let a = map.get(key);
    if (!a) map.set(key, (a = []));
    a.push(val);
  };
  for (const e of state.enrollments) {
    push(idx.enrollmentsByYear, e.yearId, e);
    push(idx.enrollmentsByStudent, e.studentId, e);
  }
  for (const a of state.assignments) {
    push(idx.assignmentsByYear, a.yearId, a);
    push(idx.assignmentsByStaff, a.staffId, a);
  }
  for (const c of state.classes) push(idx.classesByYear, c.yearId, c);
  state._idx = idx;
  return idx;
}

export function invalidate(state) {
  state._idx = undefined;
}

const KEY = (store) => (store === 'meta' ? 'key' : 'id');

// Чистая функция: применяет изменения к состоянию (мутирует его).
export function applyChanges(state, changes) {
  for (const store of changes.clear || []) state[store] = [];
  for (const [store, ids] of Object.entries(changes.del || {})) {
    if (!ids.length) continue;
    const drop = new Set(ids);
    state[store] = state[store].filter((x) => !drop.has(x.id));
  }
  for (const [store, recs] of Object.entries(changes.put || {})) {
    if (!recs.length) continue;
    const k = KEY(store);
    const pos = new Map(state[store].map((x, i) => [x[k], i]));
    for (const r of recs) {
      if (pos.has(r[k])) state[store][pos.get(r[k])] = r;
      else {
        pos.set(r[k], state[store].length);
        state[store].push(r);
      }
    }
  }
  if (changes.settings) state.settings = { ...state.settings, ...changes.settings };
  invalidate(state);
  return state;
}

export function emptyChanges() {
  return { put: {}, del: {} };
}

export function addPut(changes, store, rec) {
  (changes.put[store] ||= []).push(rec);
}

export function addDel(changes, store, id) {
  (changes.del[store] ||= []).push(id);
}
