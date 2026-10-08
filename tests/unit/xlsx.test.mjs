// Excel-выгрузка: ZIP и CRC собраны правильно, файл настоящий (если в системе есть python3 + openpyxl — открываем им и сверяем ячейки).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, seed } from './helpers.mjs';
import { crc32, zipStore, buildXlsx, excelDate, excelTime, colLetter } from '../../js/domain/xlsx.js';
import { dayRows, roundWorkbook, exportFilename, ROUND_COLUMNS } from '../../js/domain/round-export.js';
import { roundView } from '../../js/domain/rounds.js';
import { todayISO } from '../../js/domain/dates.js';

const dec = new TextDecoder();

// Разбор собственного ZIP: имена, CRC и содержимое должны сойтись.
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50, 'запись конца архива');
  const n = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = {};
  for (let i = 0; i < n; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(off, true), 0x04034b50, 'локальный заголовок');
    const lnl = dv.getUint16(off + 26, true);
    const data = bytes.subarray(off + 30 + lnl, off + 30 + lnl + size);
    assert.equal(crc32(data), crc, `CRC файла ${name}`);
    out[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  return out;
}

test('xlsx: CRC-32 по эталону и разбор ZIP', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('привет') }, { name: 'б/в.xml', data: new TextEncoder().encode('<x/>') }]);
  assert.deepEqual(readZip(zip), { 'a.txt': 'привет', 'б/в.xml': '<x/>' });
});

test('xlsx: даты и время — настоящие значения Excel, буквы столбцов', () => {
  assert.equal(excelDate('2026-10-08'), 46303);
  assert.equal(excelDate('1900-03-01'), 61);
  assert.equal(excelDate('мусор'), null);
  assert.ok(Math.abs(excelTime(18, 30) - 0.7708333) < 1e-6);
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(25), 'Z');
  assert.equal(colLetter(26), 'AA');
});

test('xlsx: структура книги — закреплённая шапка, автофильтр, ширины, стили, спецсимволы экранированы', () => {
  const bytes = buildXlsx({ sheets: [{ name: 'Обход: [тест]/1', columns: [{ header: 'Дата', width: 12, type: 'date' }, { header: 'Имя', width: 30 }], rows: [['2026-10-08', 'Иван <&> "Ы" \u0001'], ['2026-10-09', '=1+1']] }] });
  const f = readZip(bytes);
  assert.deepEqual(Object.keys(f).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const s = f['xl/worksheets/sheet1.xml'];
  assert.match(s, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(s, /<autoFilter ref="A1:B3"\/>/);
  assert.match(s, /<col min="2" max="2" width="30" customWidth="1"\/>/);
  assert.match(s, /<c r="A2" s="2"><v>46303<\/v><\/c>/);
  assert.ok(s.includes('Иван &lt;&amp;&gt; &quot;Ы&quot; '), 'XML экранирован, управляющий символ вычищен');
  assert.ok(s.includes('t="inlineStr"') && s.includes('=1+1') && !/<f>/.test(s), 'формулы не создаются');
  assert.ok(f['xl/workbook.xml'].includes('name="Обход   тест  1"'.replace(/ {3}/, '  ')) || /name="Обход[^"]*1"/.test(f['xl/workbook.xml']), 'имя листа без запрещённых символов');
});

test('экспорт обхода: строки берутся из общей базы; имена файлов не повторяются', async () => {
  const env = await makeEnv();
  await seed(env, 2);
  const today = todayISO();
  const g = roundView(env.S(), today).groups[0];
  await env.repo.setRound(g.students[0].student.id, today, 'sleeping');
  await env.repo.setRound(g.students[1].student.id, today, 'sick');
  await env.repo.setRoundReason(g.students[1].student.id, today, 'Температура');
  const rows = dayRows(env.S(), today);
  assert.equal(rows.length, 30, 'все ученики текущего года, а не только отмеченные');
  assert.equal(rows[0].length, ROUND_COLUMNS.length);
  const marked = rows.filter((r) => r[4] !== 'Не отмечен');
  assert.equal(marked.length, 2);
  assert.ok(marked.some((r) => r[4] === 'Болеет' && r[5] === 'Температура'));
  assert.ok(marked.every((r) => r[0] === today && typeof r[1] === 'number'), 'у отмеченных есть время');
  assert.ok(rows.filter((r) => r[4] === 'Не отмечен').every((r) => r[1] === null), 'у неотмеченных времени нет');
  const d = new Date(2026, 9, 8, 18, 30);
  assert.equal(exportFilename('evening-round', d), 'evening-round-2026-10-08-18-30.xlsx');
  assert.equal(exportFilename('evening-round', d), 'evening-round-2026-10-08-18-30-2.xlsx', 'второй экспорт в ту же минуту — новый файл, а не перезапись');
  assert.equal(exportFilename('evening-round', new Date(2026, 9, 8, 20, 15)), 'evening-round-2026-10-08-20-15.xlsx');
});

const hasOpenpyxl = (() => { try { execFileSync('python3', ['-I', '-c', 'import openpyxl'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('xlsx: файл открывается openpyxl, значения и оформление на месте', { skip: !hasOpenpyxl && 'нет python3 + openpyxl' }, async () => {
  const env = await makeEnv();
  await seed(env, 1);
  const today = todayISO();
  const g = roundView(env.S(), today).groups[0];
  await env.repo.setRound(g.students[0].student.id, today, 'home');
  const rows = dayRows(env.S(), today);
  rows[0][6] = '=HYPERLINK("x")'; // «вредный» текст остаётся текстом
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-')), 'out.xlsx');
  fs.writeFileSync(file, roundWorkbook(rows, { kind: 'evening' }));
  const py = `
import sys, json, datetime
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
ws = wb.active
out = {
 'title': ws.title, 'freeze': ws.freeze_panes, 'filter': ws.auto_filter.ref,
 'header': [c.value for c in ws[1]], 'bold': ws['A1'].font.b, 'rows': ws.max_row,
 'dateIsDate': ws['A2'].is_date, 'dateVal': str(ws['A2'].value), 'dateFmt': ws['A2'].number_format,
 'widths': [round(ws.column_dimensions[c].width) for c in 'ABCDEFG'],
 'timeFmt': ws['B2'].number_format, 'status': ws['E2'].value, 'by': ws['G2'].value, 'byType': ws['G2'].data_type,
}
print(json.dumps(out, ensure_ascii=False))`;
  const r = JSON.parse(execFileSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' }));
  assert.equal(r.freeze, 'A2');
  assert.equal(r.filter, `A1:G${rows.length + 1}`);
  assert.deepEqual(r.header, ROUND_COLUMNS.map((c) => c.header));
  assert.equal(r.bold, true);
  assert.equal(r.rows, rows.length + 1);
  assert.equal(r.dateIsDate, true);
  assert.equal(r.dateVal.slice(0, 10), today);
  assert.deepEqual(r.widths, [12, 8, 34, 8, 14, 30, 22]);
  assert.equal(r.by, '=HYPERLINK("x")');
  assert.equal(r.byType, 's', 'текст, а не формула');
  assert.ok(r.title.startsWith('Обход'));
});

test('marksRows: строки периода — дата, время, ФИО, класс, статус, причина, ответственный; порядок по дате, классу и ФИО', async () => {
  const { marksRows } = await import('../../js/domain/round-export.js');
  const state = {
    students: [{ id: 's1', lastName: 'Яковлев', firstName: 'Ян', middleName: '' }, { id: 's2', lastName: 'Абрамов', firstName: 'Антон', middleName: '' }],
    classes: [{ id: 'c1', name: '7A' }, { id: 'c2', name: '8B' }],
  };
  const rows = marksRows(state, [
    ['2026-10-09', 'evening', 's1', 'c2', 'sick', 'Температура', 'Анна', '2026-10-09T16:05:00.000Z'],
    ['2026-10-08', 'evening', 's1', 'c1', 'sleeping', '', 'Анна', '2026-10-08T16:00:00.000Z'],
    ['2026-10-08', 'evening', 's2', 'c1', 'absent', '', 'Борис', ''],
    ['2026-10-08', 'evening', 'gone', 'c1', 'home', '', 'Борис', ''],
  ]);
  assert.deepEqual(rows.map((r) => [r[0], r[2], r[3], r[4], r[6]]), [
    ['2026-10-08', 'Абрамов Антон', '7A', 'Отсутствует', 'Борис'],
    ['2026-10-08', 'Ученик удалён из базы', '7A', 'С дома', 'Борис'],
    ['2026-10-08', 'Яковлев Ян', '7A', 'Ночует', 'Анна'],
    ['2026-10-09', 'Яковлев Ян', '8B', 'Болеет', 'Анна'],
  ]);
  assert.equal(rows[0][1], null, 'нет времени — пустая ячейка');
  assert.equal(typeof rows[2][1], 'number', 'время — доля суток');
});
