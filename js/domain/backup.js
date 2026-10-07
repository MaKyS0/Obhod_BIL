// Полная резервная копия: экспорт, проверка, сравнение.
import { DATA_STORES, SCHEMA_VERSION } from './state.js';

export const FORMAT = 'lyceum-registry';

export function exportData(state, { now = new Date().toISOString() } = {}) {
  const { sheetsToken, key, ...settings } = state.settings; // токен синхронизации в копию не попадает
  void sheetsToken;
  void key;
  const out = { format: FORMAT, version: SCHEMA_VERSION, exportedAt: now, app: 'Учёт лицея 1.0', settings };
  for (const s of DATA_STORES) out[s] = state[s].map((x) => ({ ...x }));
  return out;
}

export function validateBackup(data) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['Файл пуст или повреждён'], warnings };
  if (data.format !== FORMAT) errors.push('Это не резервная копия «Учёта лицея» (неверное поле format)');
  if (typeof data.version !== 'number') errors.push('Не указана версия формата');
  else if (data.version > SCHEMA_VERSION) errors.push(`Копия создана более новой версией (формат ${data.version}). Обновите сайт.`);
  for (const s of DATA_STORES) if (!Array.isArray(data[s])) errors.push(`Раздел «${s}» отсутствует или не является списком`);
  if (!data.settings || typeof data.settings !== 'object') errors.push('Отсутствуют настройки');
  if (errors.length) return { ok: false, errors, warnings };

  const ids = (arr) => new Set(arr.map((x) => x.id));
  const years = ids(data.years);
  const classes = ids(data.classes);
  const students = ids(data.students);
  const staff = ids(data.staff);
  for (const s of DATA_STORES) {
    const seen = new Set();
    for (const r of data[s]) {
      if (!r || typeof r.id !== 'string') {
        errors.push(`«${s}»: запись без id`);
        break;
      }
      if (seen.has(r.id)) {
        errors.push(`«${s}»: повторяющийся id ${r.id}`);
        break;
      }
      seen.add(r.id);
    }
  }
  if (!years.has(data.settings.currentYearId)) errors.push('Текущий учебный год из настроек отсутствует в списке годов');
  for (const c of data.classes) if (!years.has(c.yearId)) errors.push(`Класс ${c.id}: неизвестный учебный год`);
  for (const e of data.enrollments) {
    if (!students.has(e.studentId)) errors.push(`Зачисление ${e.id}: нет ученика`);
    if (e.classId && !classes.has(e.classId)) errors.push(`Зачисление ${e.id}: нет класса ${e.classId}`);
    if (!years.has(e.yearId)) errors.push(`Зачисление ${e.id}: неизвестный год`);
  }
  for (const a of data.assignments) {
    if (!staff.has(a.staffId)) errors.push(`Назначение ${a.id}: нет сотрудника`);
    if (!classes.has(a.classId)) errors.push(`Назначение ${a.id}: нет класса`);
  }
  if (errors.length > 20) errors.splice(20, errors.length, `…и ещё ошибок: ${errors.length - 20}`);
  return { ok: errors.length === 0, errors, warnings, counts: Object.fromEntries(DATA_STORES.map((s) => [s, data[s].length])) };
}

// Для сравнения экспортов в тестах: убираем метки времени.
export function canonicalForCompare(data) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) if (k !== 'updatedAt' && k !== 'exportedAt' && k !== 'dirtySinceSync' && k !== 'lastBackupAt' && k !== 'lastExportAt' && k !== 'changesSincePromotion') o[k] = strip(v[k]);
      return o;
    }
    return v;
  };
  const c = strip(data);
  for (const k of ['years', 'classes', 'students', 'enrollments', 'staff', 'assignments']) c[k].sort((a, b) => (a.id < b.id ? -1 : 1));
  return c;
}
