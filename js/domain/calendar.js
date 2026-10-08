// Календарь: праздничные и выходные дни, кто дежурит. Запись `days` — по одной на дату: { id: 'YYYY-MM-DD', date, holiday?, note?, dutyStaffIds?, dutyText?, updatedAt }.
import { fullName } from './people.js';

export const DAY_NOTE_MAX = 120;
export const DUTY_MAX = 6;
export const cleanDayText = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DAY_NOTE_MAX);

/** Сведения о дне: выходной ли он, заметка, кто дежурит (сотрудники из базы) и произвольный текст о дежурстве. */
export function dayInfo(state, date) {
  const rec = (state.days || []).find((d) => d.id === date) || null;
  const staff = new Map((state.staff || []).map((s) => [s.id, s]));
  const duty = ((rec && rec.dutyStaffIds) || []).map((id) => staff.get(id)).filter(Boolean);
  const names = duty.map((s) => fullName(s));
  if (rec && rec.dutyText) names.push(rec.dutyText);
  return { date, holiday: !!(rec && rec.holiday), note: (rec && rec.note) || '', duty, dutyText: (rec && rec.dutyText) || '', dutyLabel: names.join(', '), rec };
}

/** Запись дня из частичных изменений; пустая запись (ничего не задано) → null, её нужно удалить. */
export function normalizeDay(date, patch, prev = null) {
  const merged = { ...(prev || {}), ...patch };
  const rec = { id: date, date };
  if (merged.holiday) rec.holiday = true;
  const note = cleanDayText(merged.note);
  if (note) rec.note = note;
  const ids = Array.isArray(merged.dutyStaffIds) ? [...new Set(merged.dutyStaffIds.filter((x) => typeof x === 'string' && x))].slice(0, DUTY_MAX) : [];
  if (ids.length) rec.dutyStaffIds = ids;
  const text = cleanDayText(merged.dutyText);
  if (text) rec.dutyText = text;
  return rec.holiday || rec.note || rec.dutyStaffIds || rec.dutyText ? rec : null;
}
