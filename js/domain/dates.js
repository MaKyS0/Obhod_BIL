// Работа с датами. Даты рождения хранятся строкой ISO (ГГГГ-ММ-ДД), без часовых поясов.
export const pad = (n) => String(n).padStart(2, '0');

export function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowISO() {
  return new Date().toISOString();
}

export function isRealDate(y, m, d) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y, m, d) {
  return isRealDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

function fullYear(yy) {
  return yy <= 35 ? 2000 + yy : 1900 + yy;
}

// Возвращает ISO-строку или null, если дату распознать не удалось.
export function parseDate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return fromSerial(value);
  const s = String(value).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{4})$/))) return iso(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[./\-](\d{1,2})[./\-](\d{2})$/))) return iso(fullYear(+m[3]), +m[2], +m[1]);
  if ((m = s.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  if (/^\d{5}(\.\d+)?$/.test(s)) return fromSerial(Number(s));
  return null;
}

// Серийный номер даты Excel (эпоха 1899-12-30).
function fromSerial(n) {
  if (!(n >= 20000 && n <= 60000)) return null;
  const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function formatDate(isoStr) {
  if (!isoStr) return '';
  const m = String(isoStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(isoStr);
}

export function formatDateTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
