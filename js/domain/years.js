// Учебные годы. Идентификатор — «2026-2027» (ASCII-дефис), на экране — «2026–2027» (en dash).
export function yearId(start) {
  return `${start}-${start + 1}`;
}

export function yearLabel(id) {
  return String(id || '').replace('-', '–');
}

// Принимает 2026-2027, 2026–2027, 2026—2027, 2026/2027, 2026/27, 2026-27. Возвращает id или null.
export function parseYearLabel(str) {
  const m = String(str || '').trim().match(/^(\d{4})\s*[-–—/]\s*(\d{4}|\d{2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  let end = Number(m[2]);
  if (m[2].length === 2) {
    if ((start + 1) % 100 !== end) return null;
    end = start + 1;
  }
  if (end !== start + 1 || start < 2000 || start > 2100) return null;
  return yearId(start);
}

export function yearStart(id) {
  return Number(String(id).slice(0, 4));
}

export function nextYearId(id) {
  return yearId(yearStart(id) + 1);
}

export function prevYearId(id) {
  return yearId(yearStart(id) - 1);
}

// С 1 августа начинается новый учебный год.
export function yearFromDate(d = new Date()) {
  return yearId(d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1);
}

export function compareYears(a, b) {
  return yearStart(a) - yearStart(b);
}
