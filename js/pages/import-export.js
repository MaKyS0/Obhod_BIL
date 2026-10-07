import { h } from '../ui/dom.js';
import { pageHead, btn, badge, notice } from '../ui/common.js';
import { field, radioCard, checkbox } from '../ui/form.js';
import { confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { downloadText, readFileBytes } from '../services/download.js';
import { saveBackupFile } from '../services/backup-file.js';
import { decodeBytes, parseCsv, detectDelimiter, stringifyCsv } from '../domain/csv.js';
import { autoMap, hasRecognizedHeader, rowsToRecords, parseJsonImport, FIELD_LABELS, STUDENT_FIELDS, STAFF_FIELDS } from '../domain/importer.js';
import { validateBackup } from '../domain/backup.js';
import { isEncryptedBox } from '../domain/crypto-box.js';
import { unlockBox } from '../ui/unlock.js';
import { studentsCsv, classesCsv, staffCsv, STUDENT_TEMPLATE, STAFF_TEMPLATE } from '../domain/exports.js';
import { nRows } from '../domain/plural.js';
import { formatDate } from '../domain/dates.js';
import { yearLabel } from '../domain/years.js';

export const title = 'Импорт и экспорт';
const PREVIEW_LIMIT = 200;

export function render(ctx) {
  const { state: s, repo, view: el } = ctx;
  const yid = s.settings.currentYearId;
  el.append(pageHead({ title: 'Импорт и экспорт', sub: 'Загрузка списков из CSV / JSON и выгрузка данных' }));

  // ---------- Экспорт ----------
  const dl = (name, text, mime = 'text/csv;charset=utf-8') => () => { downloadText(name, text(), mime); toast('Файл сохранён'); };
  el.append(h('div', { class: 'card' }, h('h2', null, 'Экспортировать данные'),
    h('p', { class: 'muted' }, 'Полная резервная копия в JSON содержит все годы, классы, учеников, персонал и историю переходов. Храните её в надёжном месте — это ваша страховка.'),
    h('div', { class: 'row' },
      btn('Экспортировать всё (JSON)', async () => { await saveBackupFile(repo); toast('Резервная копия сохранена'); }, 'primary', { id: 'exportJsonBtn' }),
      btn('Ученики (CSV)', dl(`ученики-${yid}.csv`, () => studentsCsv(ctx.state, yid))),
      btn('Классы (CSV)', dl(`классы-${yid}.csv`, () => classesCsv(ctx.state, yid))),
      btn('Персонал (CSV)', dl(`персонал-${yid}.csv`, () => staffCsv(ctx.state, yid)))),
    h('p', { class: 'muted', style: 'margin-top:8px' }, `CSV выгружается за ${yearLabel(yid)} учебный год в кодировке UTF-8 с разделителем «;» — открывается в Excel и Google Таблицах.`)));

  // ---------- Импорт ----------
  const kindR = [
    radioCard({ name: 'kind', value: 'students', checked: true, title: 'Ученики', text: 'Фамилия, имя, отчество, класс, дата рождения', onChange: () => reparse() }),
    radioCard({ name: 'kind', value: 'staff', title: 'Персонал', text: 'ФИО, должность (классный руководитель / воспитатель), класс', onChange: () => reparse() }),
  ];
  const fileInput = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.json,text/csv,application/json', id: 'importFile', 'aria-label': 'Файл для импорта', onchange: onFile });
  const paste = h('textarea', { id: 'importText', rows: 5, placeholder: 'Или вставьте сюда таблицу из Excel / Google Таблиц (с заголовком в первой строке) либо JSON', 'aria-label': 'Текст для импорта' });
  const parseBtn = btn('Разобрать данные', () => { source = paste.value; reparse(); }, 'primary', { id: 'importParse' });
  const out = h('div', { id: 'importOut', style: 'margin-top:16px' });
  let source = '';
  let csv = null; // { delimiter, table, hasHeader, mapping }
  const dupSel = field({ label: 'Если такой человек уже есть', name: 'dup', value: 'skip', options: [{ value: 'skip', label: 'Пропустить' }, { value: 'update', label: 'Обновить данные и класс' }, { value: 'create', label: 'Создать ещё одну запись' }] });
  dupSel.input.addEventListener('change', () => draw());
  const roleSel = field({ label: 'Должность по умолчанию (если нет колонки)', name: 'defRole', value: 'teacher', options: [{ value: 'teacher', label: 'Классный руководитель' }, { value: 'tutor', label: 'Воспитатель' }] });
  roleSel.input.addEventListener('change', () => draw());
  const onlyProblems = checkbox({ label: 'Показывать только строки с ошибками и замечаниями', onChange: () => draw() });

  async function onFile() {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      source = decodeBytes(await readFileBytes(f));
      paste.value = '';
      reparse();
    } catch (e) { toastError(e); }
  }

  const kind = () => kindR[0].input.checked ? 'students' : 'staff';

  // Зашифрованный набор данных, лежащий рядом с сайтом (data/lyceum-data.enc.json).
  async function loadFromRepo() {
    try {
      const res = await fetch(new URL('../../data/lyceum-data.enc.json', import.meta.url), { cache: 'no-store' });
      if (!res.ok) throw new Error('Файл data/lyceum-data.enc.json не найден на сайте');
      source = await res.text();
      paste.value = '';
      await reparse();
    } catch (e) { toastError(e); }
  }
  if (ctx.query.source === 'repo') {
    history.replaceState(null, '', '#/import'); // чтобы перерисовка страницы не запускала загрузку повторно
    queueMicrotask(loadFromRepo);
  }

  async function reparse() {
    out.replaceChildren();
    csv = null;
    let text = String(source || '').trim();
    if (!text) return;
    if (text.startsWith('{')) {
      let maybe = null;
      try { maybe = JSON.parse(text); } catch { /* не JSON — разберём ниже */ }
      if (isEncryptedBox(maybe)) {
        const data = await unlockBox(maybe);
        if (!data) return void (source = '');
        text = JSON.stringify(data);
        source = text; // расшифрованный текст живёт только в памяти страницы и сбрасывается после импорта
      }
    }
    if (/^[{[]/.test(text)) {
      const j = parseJsonImport(text);
      if (!j.ok) return void out.append(notice('danger', j.error));
      if (j.type === 'full') return void drawFull(j.data);
      csv = { json: j };
    } else {
      const delimiter = detectDelimiter(text);
      const table = parseCsv(text, delimiter);
      if (table.length < 1) return void out.append(notice('danger', 'Не найдено ни одной строки данных'));
      const hasHeader = hasRecognizedHeader(table[0]);
      const cols = Math.max(...table.map((r) => r.length));
      const mapping = hasHeader ? autoMap(table[0]) : table[0].map((_, i) => (cols === 1 && i === 0 ? 'fullName' : ''));
      csv = { delimiter, table, hasHeader, mapping };
    }
    draw();
  }

  function drawFull(data) {
    const v = validateBackup(data);
    out.replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Полная резервная копия'),
      v.ok ? notice('info', `Копия от ${String(data.exportedAt || '').slice(0, 10)}: учеников — ${data.students.length}, сотрудников — ${data.staff.length}, учебных годов — ${data.years.length}, классов — ${data.classes.length}.`) : notice('danger', h('strong', null, 'Копия не прошла проверку:'), h('ul', null, v.errors.map((e) => h('li', null, e)))),
      notice('warn', 'Восстановление ЗАМЕНИТ все текущие данные данными из файла. Перед заменой автоматически создаётся резервная копия текущей базы.'),
      btn('Заменить все данные этой копией…', async () => {
        const ok = await confirmAction({ title: 'Восстановление из копии', message: 'Все текущие данные будут заменены данными из файла.', details: [`Сейчас в базе: учеников — ${ctx.state.students.length}, сотрудников — ${ctx.state.staff.length}.`, `В копии: учеников — ${data.students.length}, сотрудников — ${data.staff.length}.`, 'Текущая база будет сохранена в автоматической резервной копии.'], confirmLabel: 'Заменить данные', typeToConfirm: 'ЗАМЕНИТЬ' });
        if (!ok) return;
        try { await repo.restoreBackup(data); toast('Данные восстановлены'); source = ''; out.replaceChildren(); location.hash = '#/'; } catch (e) { toastError(e); }
      }, 'danger', { disabled: !v.ok, id: 'restoreFull' })));
  }

  function plans() {
    const opts = { onDuplicate: dupSel.get(), defaultRole: roleSel.get() };
    if (csv.json) {
      const res = [];
      if (csv.json.students.length) res.push({ label: 'Ученики', plan: repo.previewImport('students', csv.json.students, opts) });
      if (csv.json.staff.length) res.push({ label: 'Персонал', plan: repo.previewImport('staff', csv.json.staff, { ...opts, defaultRole: null }) });
      return res;
    }
    const rows = csv.hasHeader ? csv.table.slice(1) : csv.table;
    const records = rowsToRecords(rows, csv.mapping);
    return [{ label: kind() === 'students' ? 'Ученики' : 'Персонал', plan: repo.previewImport(kind(), records, opts) }];
  }

  function draw() {
    if (!csv) return;
    out.replaceChildren();
    const head = h('div', { class: 'card' }, h('h2', null, 'Предварительный просмотр'));
    if (!csv.json) {
      const fields = kind() === 'students' ? STUDENT_FIELDS : STAFF_FIELDS;
      const cols = Math.max(...csv.table.map((r) => r.length));
      const names = csv.hasHeader ? csv.table[0] : Array.from({ length: cols }, (_, i) => `Колонка ${i + 1}`);
      const hdr = checkbox({ label: 'Первая строка — заголовок', checked: csv.hasHeader, onChange: () => { csv.hasHeader = hdr.get(); csv.mapping = csv.hasHeader ? autoMap(csv.table[0]) : csv.table[0].map(() => ''); draw(); } });
      head.append(h('p', { class: 'muted' }, `Разделитель: ${csv.delimiter === '\t' ? 'табуляция' : `«${csv.delimiter}»`} · строк в файле: ${csv.table.length - (csv.hasHeader ? 1 : 0)}. Проверьте, какая колонка что означает.`), hdr.el,
        h('div', { class: 'mapping-grid', style: 'margin-bottom:12px' }, names.map((n, i) => {
          const f = field({ label: `«${n || `колонка ${i + 1}`}»`, name: `map${i}`, value: csv.mapping[i] || '', options: [{ value: '', label: '— не импортировать —' }, ...fields.map((k) => ({ value: k, label: FIELD_LABELS[k] }))] });
          f.input.addEventListener('change', () => { csv.mapping[i] = f.get(); draw(); });
          return f.el;
        })));
    }
    head.append(h('div', { class: 'field-row' }, dupSel.el, kind() === 'staff' && !csv.json ? roleSel.el : null), onlyProblems.el);
    out.append(head);

    const list = plans();
    if (!list.length) return void out.append(notice('warn', 'В файле нет данных для импорта'));
    let canApply = 0;
    for (const { label, plan } of list) {
      const sm = plan.summary;
      canApply += sm.create + sm.update;
      const isStaff = plan.kind === 'staff';
      const problems = plan.rows.filter((r) => r.errors.length || r.warnings.length);
      const shown = (onlyProblems.get() ? problems : plan.rows).slice(0, PREVIEW_LIMIT);
      out.append(h('div', { class: 'card flush', style: 'margin-top:16px' },
        h('div', { class: 'card-head' }, h('h2', null, label), h('div', { class: 'row' }, badge(`Создать: ${sm.create}`, 'ok'), badge(`Обновить: ${sm.update}`, 'info'), badge(`Пропустить: ${sm.skip}`), badge(`Ошибки: ${sm.error}`, sm.error ? 'danger' : ''))),
        h('div', { class: 'import-preview table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, '№'), h('th', null, 'ФИО'), isStaff ? h('th', null, 'Должность') : null, h('th', null, 'Класс'), isStaff ? null : h('th', null, 'Дата рождения'), h('th', null, 'Действие'), h('th', null, 'Замечания'))),
          h('tbody', null, shown.map((r) => h('tr', null,
            h('td', null, String(r.n)), h('td', null, r.fio || '—'),
            isStaff ? h('td', null, r.role === 'teacher' ? 'Классный руководитель' : r.role === 'tutor' ? 'Воспитатель' : '—') : null,
            h('td', null, r.className || '—'), isStaff ? null : h('td', null, r.birthDate ? formatDate(r.birthDate) : '—'),
            h('td', null, badge({ create: 'Создать', update: 'Обновить', skip: 'Пропустить', error: 'Ошибка' }[r.action], { create: 'ok', update: 'info', skip: '', error: 'danger' }[r.action])),
            h('td', null, r.errors.map((e) => h('div', { class: 'cell-err' }, e)), r.warnings.map((w) => h('div', { class: 'cell-warn' }, w)))))))),
        plan.rows.length > PREVIEW_LIMIT ? h('p', { class: 'muted', style: 'padding:8px 16px' }, `Показаны первые ${PREVIEW_LIMIT} из ${nRows(plan.rows.length)}.`) : null,
        problems.length ? h('div', { style: 'padding:8px 16px' }, btn('Скачать список замечаний (CSV)', () => downloadText('замечания-импорта.csv', stringifyCsv([['№ строки', 'ФИО', 'Ошибки', 'Замечания'], ...problems.map((r) => [r.n, r.fio, r.errors.join('; '), r.warnings.join('; ')])]), 'text/csv;charset=utf-8'), 'sm')) : null));
    }
    out.append(h('div', { class: 'row', style: 'margin-top:16px' },
      btn(`Импортировать (${canApply})`, async () => {
        try {
          let n = 0;
          for (const { plan } of list) if (plan.summary.create + plan.summary.update) n += await repo.applyImport(plan);
          toast(`Импорт завершён: обработано записей — ${n}`);
          source = ''; csv = null; paste.value = ''; fileInput.value = ''; out.replaceChildren();
          out.append(notice('info', `Готово. Перейдите в раздел `, h('a', { href: '#/students' }, 'Ученики'), ' или ', h('a', { href: '#/staff' }, 'Персонал'), '.'));
        } catch (e) { toastError(e); }
      }, 'primary', { disabled: !canApply, id: 'importApply' }),
      h('span', { class: 'muted' }, 'Перед импортом автоматически создаётся резервная копия.')));
  }

  el.append(h('div', { class: 'card', style: 'margin-top:16px' }, h('h2', null, 'Импортировать данные'),
    h('p', { class: 'muted' }, 'Поддерживаются CSV (в том числе сохранённый из Excel; кодировки UTF-8 и Windows-1251, разделители «;», «,», табуляция), а также JSON. Excel-файл (.xlsx) сначала сохраните как «CSV».'),
    h('div', { class: 'field' }, h('div', { class: 'label' }, 'Что импортируем'), kindR.map((x) => x.el)),
    h('div', { class: 'field' }, h('label', { for: 'importFile' }, 'Файл'), fileInput),
    h('div', { class: 'field' }, h('label', { for: 'importText' }, 'Или вставьте данные'), paste), parseBtn,
    h('div', { class: 'notice info', style: 'margin-top:12px' }, h('strong', null, 'Зашифрованные данные лицея. '), 'Файл ', h('code', null, 'data/lyceum-data.enc.json'), ' (или такой же файл, выбранный выше) расшифровывается паролем в вашем браузере и проходит обычный предпросмотр импорта. ', btn('Загрузить зашифрованные данные лицея', loadFromRepo, 'sm', { id: 'loadEncBtn' })),
    h('div', { class: 'row', style: 'margin-top:12px' }, btn('Шаблон CSV: ученики', () => downloadText('шаблон-ученики.csv', STUDENT_TEMPLATE, 'text/csv;charset=utf-8'), 'sm'), btn('Шаблон CSV: персонал', () => downloadText('шаблон-персонал.csv', STAFF_TEMPLATE, 'text/csv;charset=utf-8'), 'sm')),
    out));
}
