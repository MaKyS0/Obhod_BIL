// CSV: определение кодировки и разделителя, разбор и запись (RFC 4180).
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return new TextDecoder('windows-1251').decode(u8);
  }
}

const CANDIDATES = [';', '\t', ',', '|'];

function countOutsideQuotes(line, ch) {
  let n = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ch && !q) n++;
  }
  return n;
}

export function detectDelimiter(text) {
  const lines = String(text).split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 10);
  let best = ';';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const c0 = counts[0] || 0;
    if (!c0) continue;
    const score = c0 * counts.filter((c) => c === c0).length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsv(text, delimiter) {
  const src = String(text).replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === d) endCell();
    else if (c === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
    } else if (c === '\n') endRow();
    else cell += c;
    i++;
  }
  if (cell !== '' || row.length) endRow();
  return rows
    .map((r) => r.map((x) => x.trim()))
    .filter((r) => r.some((x) => x !== ''));
}

function guard(v) {
  // Защита от внедрения формул при открытии в Excel / Google Таблицах.
  return typeof v === 'string' && /^[=@]|^[+-](?![\d\s().-])/.test(v) ? `'${v}` : v;
}

export function stringifyCsv(rows, { delimiter = ';', bom = true } = {}) {
  const out = rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === null || v === undefined ? '' : String(guard(v));
          return /["\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(delimiter),
    )
    .join('\r\n');
  return (bom ? '﻿' : '') + out + '\r\n';
}
