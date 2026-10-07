// E2E в настоящем браузере (Playwright + Chromium). Сайт обслуживается по подпути /Obhod_BIL/, как на GitHub Pages.
// Запуск: node tests/e2e/run.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { encryptJson } from '../../js/domain/crypto-box.js';

let pw;
try { pw = await import('playwright'); } catch { pw = createRequire('/opt/node22/lib/node_modules/')('playwright'); }
const chromium = pw.chromium || pw.default?.chromium;

const srv = await startServer();
const browser = await chromium.launch();
const results = [];
let failed = 0;

function assert(cond, msg) { if (!cond) throw new Error(`Проверка не пройдена: ${msg}`); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: ожидалось ${JSON.stringify(b)}, получено ${JSON.stringify(a)}`); }

async function scenario(name, fn, { viewport = { width: 1280, height: 900 }, init, ignoreErrors = null } = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  if (init) await context.addInitScript(init);
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => m.type() === 'error' && !(ignoreErrors && ignoreErrors.test(m.text())) && errors.push(`console: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  };
  context.on('page', watch);
  const page = await context.newPage();
  if (process.env.LYC_SLOW) {
    for (const m of ['click', 'fill', 'waitForSelector', 'waitForFunction', 'selectOption', 'check']) {
      const orig = page[m].bind(page);
      page[m] = async (...a) => { const t = Date.now(); try { return await orig(...a); } finally { if (Date.now() - t > 800) console.log(`  slow ${m}(${String(a[0]).slice(0, 80)}) ${Date.now() - t} мс`); } };
    }
  }
  const t0 = Date.now();
  try {
    await fn(page, context);
    if (errors.length) throw new Error(`Ошибки в консоли браузера:\n  ${errors.join('\n  ')}`);
    results.push(`  ok   ${name} (${Date.now() - t0} мс)`);
  } catch (e) {
    failed++;
    results.push(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`);
    try { await page.screenshot({ path: `/tmp/lyceum-fail-${failed}.png` }); } catch { /* ignore */ }
  } finally {
    await context.close();
  }
}

const state = (page, expr) => page.evaluate(`(() => { const S = window.__lyceum.store.state; return ${expr}; })()`);
const open = async (page, hash = '') => { await page.goto(srv.url + hash); await page.waitForSelector('h1'); };
const go = async (page, hash) => { await page.evaluate((h) => (location.hash = h), hash); await page.waitForTimeout(120); };
const modal = (page) => page.locator('dialog.modal[open]');
const classHash = (name) => `#/class/${encodeURIComponent('2026-2027:' + name)}`;
const loadDemo = async (page) => {
  await open(page, '#/settings');
  await page.click('#loadDemoBtn');
  await page.waitForFunction(() => window.__lyceum.store.state.students.length > 0);
};

function cp1251(str) {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 128) bytes.push(c);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x350);
    else if (c === 0x401) bytes.push(0xa8);
    else if (c === 0x451) bytes.push(0xb8);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------
await scenario('Первый запуск: 15 классов, пустая главная, DEMO и числа на дашборде = числа в базе', async (page) => {
  await open(page);
  eq(await page.textContent('h1'), 'Главная', 'заголовок');
  assert((await page.textContent('main')).includes('База учеников пуста'), 'пустое состояние');
  eq(await state(page, 'S.classes.length'), 15, 'классов в базе');
  eq(await state(page, 'S.settings.currentYearId'), await state(page, 'S.years[0].id'), 'год');
  await page.click('text=Загрузить DEMO-данные');
  await page.waitForFunction(() => window.__lyceum.store.state.students.length > 0);
  await page.waitForSelector('.stat .value:not(:text-is("0"))');
  const total = await state(page, "S.students.filter(s => s.status === 'active').length");
  eq((await page.textContent('.stat .value')).trim(), String(total), 'всего учеников на дашборде');
  assert(total > 300, 'демо загружено');
  const sevenText = await page.textContent('.grade-line:nth-of-type(1)');
  const seven = await state(page, `S.enrollments.filter(e => e.classId && e.classId.includes(':7')).length`);
  assert(sevenText.includes(`${seven} учеников`) || sevenText.includes(`${seven} ученик`), `7 классы: ${sevenText} / ${seven}`);
  assert((await page.textContent('.banner.warn')).includes('DEMO'), 'плашка DEMO');
  eq(await page.locator('table.data tbody tr').count(), 15, 'строк в таблице классов');
  assert((await page.locator('canvas').count()) === 2, 'два графика Chart.js');
  await page.reload();
  await page.waitForSelector('.stat');
  eq(await state(page, 'S.students.length'), total, 'данные сохранились после перезагрузки');
});

await scenario('Ученики: добавление (с валидацией), правка, перевод, отмена и подтверждение удаления, архив', async (page) => {
  await loadDemo(page);
  await go(page, classHash('7A'));
  const n7a = await state(page, `S.enrollments.filter(e => e.classId === '2026-2027:7A').length`);
  await page.click('text=Добавить ученика');
  await modal(page).locator('button:has-text("Добавить")').click();
  assert(await modal(page).count() === 1, 'диалог остался открытым при пустых полях');
  assert((await modal(page).textContent()).includes('Укажите фамилию'), 'сообщение валидации');
  await modal(page).locator('input[name=lastName]').fill('Тестов');
  await modal(page).locator('input[name=firstName]').fill('Тест');
  await modal(page).locator('input[name=birthDate]').fill('2012-03-04');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
  eq(await state(page, `S.enrollments.filter(e => e.classId === '2026-2027:7A').length`), n7a + 1, 'в 7A стало больше');
  assert((await page.textContent('h2:has-text("Ученики (")')).includes(`(${n7a + 1})`), 'счётчик в заголовке');
  // правка
  await page.locator('tr:has-text("Тестов Тест")').locator('button:has-text("Изменить")').click();
  await modal(page).locator('input[name=firstName]').fill('Тестер');
  await modal(page).locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('tr:has-text("Тестов Тестер")');
  // перевод
  await page.locator('tr:has-text("Тестов Тестер")').locator('button:has-text("Перевести")').click();
  await modal(page).locator('select').selectOption('2026-2027:7B');
  await modal(page).locator('button:has-text("Перевести")').click();
  await page.waitForSelector('tr:has-text("Тестов")', { state: 'detached' });
  eq(await state(page, `S.enrollments.filter(e => e.classId === '2026-2027:7A').length`), n7a, '7A вернулась к исходному числу');
  await go(page, classHash('7B'));
  await page.waitForSelector('tr:has-text("Тестов Тестер")');
  // удаление: сначала отмена
  await page.locator('tr:has-text("Тестов Тестер")').locator('button:has-text("Удалить")').click();
  assert((await modal(page).textContent()).includes('Удаление ученика'), 'окно подтверждения');
  await modal(page).locator('button:has-text("Отмена")').click();
  await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
  eq(await state(page, `S.students.filter(s => s.lastName === 'Тестов').length`), 1, 'после отмены ученик на месте');
  // подтверждение: в архив
  await page.locator('tr:has-text("Тестов Тестер")').locator('button:has-text("Удалить")').click();
  await modal(page).locator('button:has-text("Отчислить в архив")').click();
  await page.waitForSelector('tr:has-text("Тестов Тестер")', { state: 'detached' });
  eq(await state(page, `S.students.find(s => s.lastName === 'Тестов').status`), 'left', 'статус left');
  await go(page, '#/archive');
  await page.click('button[role=tab]:has-text("Выбывшие")');
  await page.waitForSelector('tr:has-text("Тестов Тестер")');
  // вернуть в класс
  await page.locator('tr:has-text("Тестов Тестер")').locator('button:has-text("Вернуть в класс")').click();
  await modal(page).locator('select').selectOption('2026-2027:7C');
  await modal(page).locator('button:has-text("Вернуть")').last().click();
  await page.waitForFunction(() => window.__lyceum.store.state.students.find((s) => s.lastName === 'Тестов').status === 'active');
  // удалить навсегда через карточку класса
  await go(page, classHash('7C'));
  await page.locator('tr:has-text("Тестов Тестер")').locator('button:has-text("Удалить")').click();
  await modal(page).locator('label:has-text("Удалить навсегда") input').check();
  await modal(page).locator('button:has-text("Удалить навсегда")').click();
  assert(await modal(page).count() === 1, 'без галочки удаление не выполняется');
  await modal(page).locator('.notice.danger input[type=checkbox]').check();
  await modal(page).locator('button:has-text("Удалить навсегда")').click();
  await page.waitForFunction(() => !window.__lyceum.store.state.students.some((s) => s.lastName === 'Тестов'));
});

await scenario('Глобальный поиск: ученик, сотрудник, класс', async (page) => {
  await loadDemo(page);
  await page.fill('#globalSearch', 'Ученик 9B-01');
  await page.waitForSelector('h2:has-text("Ученики (")');
  assert((await page.textContent('main')).includes('Демо Ученик 9B-01'), 'найден ученик');
  await page.fill('#globalSearch', 'руководитель 8c');
  await page.waitForSelector('h2:has-text("Персонал (")');
  assert((await page.textContent('main')).includes('Демо Руководитель 8C'), 'найден учитель');
  await page.fill('#globalSearch', '10 в');
  await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('10B'));
  assert((await page.textContent('main')).includes('10B'), 'найден класс 10B (кириллица «в»)');
  await page.fill('#globalSearch', 'нетакогоимени');
  await page.waitForSelector('text=Ничего не найдено');
  await page.fill('#globalSearch', 'Демо');
  await page.waitForSelector('h2:has-text("Ученики (")');
  await page.locator('main a:has-text("Демо Ученик")').first().click();
  assert((await modal(page).textContent()).includes('Карточка ученика'), 'карточка ученика');
});

await scenario('Персонал: добавление, назначение, замена, снятие, удаление с предупреждением', async (page) => {
  await open(page, '#/staff');
  await page.click('button:has-text("Добавить классного руководителя")');
  await modal(page).locator('input[name=lastName]').fill('Новиков');
  await modal(page).locator('input[name=firstName]').fill('Нил');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page.waitForSelector('tr:has-text("Новиков Нил")');
  await page.locator('tr:has-text("Новиков Нил")').locator('button:has-text("Назначить")').click();
  await modal(page).locator('select').selectOption('2026-2027:8A');
  await modal(page).locator('button:has-text("Назначить")').last().click();
  await page.waitForSelector('tr:has-text("Новиков Нил") .chip:has-text("8A")');
  eq(await state(page, `S.assignments.find(a => a.id === '2026-2027:8A:teacher').staffId === S.staff[0].id`), true, 'назначение в базе');
  // второй руководитель вытесняет первого
  await page.click('button:has-text("Добавить классного руководителя")');
  await modal(page).locator('input[name=lastName]').fill('Орлов');
  await modal(page).locator('input[name=firstName]').fill('Олег');
  await modal(page).locator('select[name=classId]').selectOption('2026-2027:8A');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page.waitForSelector('tr:has-text("Орлов Олег") .chip:has-text("8A")');
  assert((await page.locator('tr:has-text("Новиков Нил")').textContent()).includes('не назначен'), 'прежний руководитель снят');
  // назначение через выпадающий список в таблице назначений
  await page.locator('.assign-grid select').nth(1).selectOption({ label: 'Новиков Нил' });
  await page.waitForSelector('tr:has-text("Новиков Нил") .chip:has-text("7B")');
  // снять назначение крестиком
  await page.click('button[aria-label="Снять назначение с класса 7B"]');
  await page.waitForFunction(() => !window.__lyceum.store.state.assignments.some((a) => a.id === '2026-2027:7B:teacher'));
  // воспитатели
  await page.click('button[role=tab]:has-text("Воспитатели")');
  await page.click('button:has-text("Добавить воспитателя")');
  await modal(page).locator('input[name=lastName]').fill('Власов');
  await modal(page).locator('input[name=firstName]').fill('Влас');
  await modal(page).locator('select[name=classId]').selectOption('2026-2027:9C');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page.waitForSelector('tr:has-text("Власов Влас") .chip:has-text("9C")');
  // удаление с предупреждением
  await page.locator('tr:has-text("Власов Влас")').locator('button:has-text("Удалить")').click();
  assert((await modal(page).textContent()).includes('9C'), 'предупреждение называет класс 9C');
  await modal(page).locator('button:has-text("Отмена")').click();
  eq(await state(page, `S.staff.filter(s => s.lastName === 'Власов').length`), 1, 'после отмены остался');
  await page.locator('tr:has-text("Власов Влас")').locator('button:has-text("Удалить")').click();
  await modal(page).locator('label:has-text("Удалить навсегда") input').check();
  await modal(page).locator('button:has-text("Подтвердить")').click();
  await page.waitForFunction(() => !window.__lyceum.store.state.staff.some((s) => s.lastName === 'Власов'));
  eq(await state(page, `S.assignments.some(a => a.id === '2026-2027:9C:tutor')`), false, 'назначение удалено вместе с человеком');
  // поиск
  await page.click('button[role=tab]:has-text("Классные руководители")');
  await page.fill('input[aria-label="Поиск по ФИО"]', 'орлов');
  eq(await page.locator('tbody tr').count(), 1, 'поиск по ФИО');
  // карточка класса: выпадающие списки
  await go(page, classHash('8A'));
  eq(await page.locator('select[name=teacher]').inputValue(), await state(page, `S.staff.find(s => s.lastName === 'Орлов').id`), 'в карточке класса виден руководитель');
});

await scenario('Новый учебный год: предпросмотр, отмена, переход 7→8…10→11, выпуск, история, отмена перехода', async (page) => {
  await loadDemo(page);
  const before = await state(page, `(() => { const o = {}; for (const c of S.classes) o[c.name] = S.enrollments.filter(e => e.classId === c.id && e.status === 'studying').length; return o; })()`);
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  const grads = before['11A'] + before['11B'] + before['11C'];
  await go(page, '#/new-year');
  await page.click('#startYearBtn');
  await page.waitForSelector('.preview-list li');
  const items = await page.locator('.preview-list li').allTextContents();
  eq(items.length, 15, 'строк в предпросмотре');
  const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'ученик' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'ученика' : 'учеников');
  eq(items[0], `7A — ${before['7A']} ${word(before['7A'])} → 8A`, 'первая строка');
  eq(items[12], `11A — ${before['11A']} ${word(before['11A'])} → выпуск`, 'строка выпуска');
  assert((await modal(page).textContent()).includes('Ученики 11 классов выпускаются'), 'предупреждение о выпуске');
  assert((await modal(page).textContent()).includes('Архивировать выпуск'), 'вариант «архивировать»');
  assert((await modal(page).textContent()).includes('Оставить в текущем году'), 'вариант «оставить»');
  assert(await modal(page).locator('button:has-text("Подтвердить переход")').isDisabled(), 'подтверждение заблокировано до ввода года');
  // отмена
  await modal(page).locator('button:has-text("Отменить")').click();
  await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
  eq(await state(page, 'S.settings.currentYearId'), '2026-2027', 'год не изменился после отмены');
  eq(await state(page, 'S.years.length'), 1, 'нового года нет');
  // подтверждение
  await page.click('#startYearBtn');
  await page.waitForSelector('.preview-list li');
  await modal(page).locator('input#' + (await modal(page).locator('input[name=typed]').getAttribute('id'))).fill('2027–2028');
  await modal(page).locator('button:has-text("Подтвердить переход")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.settings.currentYearId === '2027-2028');
  const after = await state(page, `(() => { const o = {}; for (const c of S.classes.filter(c => c.yearId === '2027-2028')) o[c.name] = S.enrollments.filter(e => e.classId === c.id && e.status === 'studying').length; return o; })()`);
  for (const [from, to] of [['7A', '8A'], ['7B', '8B'], ['7C', '8C'], ['8A', '9A'], ['8B', '9B'], ['8C', '9C'], ['9A', '10A'], ['9B', '10B'], ['9C', '10C'], ['10A', '11A'], ['10B', '11B'], ['10C', '11C']]) eq(after[to], before[from], `${from} → ${to}`);
  eq(after['7A'] + after['7B'] + after['7C'], 0, '7 классы пусты');
  eq(await state(page, `S.students.filter(s => s.status === 'graduated').length`), grads, 'выпускники в архиве');
  eq(await state(page, 'S.students.length'), total, 'никто не удалён');
  // история сохранилась
  await go(page, '#/history/2026-2027');
  assert((await page.textContent('.history-banner')).includes('Только просмотр'), 'история — только просмотр');
  eq((await page.textContent('.stat .value')).trim(), String(total), 'в истории 2026–2027 прежнее число учеников');
  assert((await page.textContent('main')).includes('Демо Руководитель 7A'), 'в истории виден прежний руководитель');
  await page.locator('details.class-block').first().locator('summary').click();
  await page.waitForSelector('details.class-block[open] tbody tr');
  await go(page, '#/history/2027-2028');
  eq((await page.textContent('.stat .value')).trim(), String(total - grads), 'в 2027–2028 без выпускников');
  // архив выпускников
  await go(page, '#/archive');
  assert((await page.textContent('button[role=tab][aria-selected=true]')).includes(`(${grads})`), 'выпускники в архиве');
  // дашборд пересчитан
  await go(page, '#/');
  eq((await page.textContent('.stat .value')).trim(), String(total - grads), 'дашборд пересчитан');
  // отмена перехода
  await go(page, '#/new-year');
  await page.click('button:has-text("Отменить переход")');
  await modal(page).locator('button:has-text("Отменить переход")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.settings.currentYearId === '2026-2027');
  eq(await state(page, 'S.years.length'), 1, 'год удалён');
  eq(await state(page, `S.students.filter(s => s.status === 'graduated').length`), 0, 'выпускники вернулись');
  await page.reload();
  await page.waitForSelector('h1');
  eq(await state(page, 'S.settings.currentYearId'), '2026-2027', 'после перезагрузки год прежний');
});

await scenario('Защита перехода в IndexedDB: повторное применение того же плана отклоняется', async (page) => {
  await loadDemo(page);
  const res = await page.evaluate(async () => {
    const { repo, store } = window.__lyceum;
    const plan = repo.previewPromotion({});
    await repo.runPromotion(plan);
    let code = null;
    try { await store.commit(plan.changes, { system: true, expectCurrentYear: plan.from }); } catch (e) { code = e.code; }
    return { code, years: store.state.years.length, year: store.state.settings.currentYearId };
  });
  eq(res.code, 'STALE', 'повторный переход отклонён транзакцией');
  eq(res.years, 2, 'создан ровно один новый год');
  eq(res.year, '2027-2028', 'текущий год');
  await page.reload();
  await page.waitForSelector('h1');
  eq(await state(page, 'S.years.length'), 2, 'после перезагрузки в базе тоже два года');
});

await scenario('Новый год: «оставить выпуск», второй год, оформление выпуска позже', async (page) => {
  await loadDemo(page);
  await go(page, '#/new-year');
  await page.click('#startYearBtn');
  await page.waitForSelector('.preview-list li');
  await modal(page).locator('label.radio-card:has-text("Оставить в текущем году") input').check();
  await page.waitForFunction(() => document.querySelector('.preview-list li:nth-child(13)')?.textContent.includes('ожидают выпуска'));
  await modal(page).locator('summary:has-text("второй год")').click();
  await modal(page).locator('select[name=holdClass]').selectOption('2026-2027:9A');
  await modal(page).locator('.check').first().click();
  await modal(page).locator('input[name=typed]').fill('2027-2028');
  await modal(page).locator('button:has-text("Подтвердить переход")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.settings.currentYearId === '2027-2028');
  eq(await state(page, `S.enrollments.filter(e => e.status === 'pending-graduation').length`), await state(page, `S.enrollments.filter(e => e.yearId === '2026-2027' && e.classId && e.classId.includes(':11')).length`), 'ожидающие выпуска');
  eq(await state(page, `S.enrollments.filter(e => e.heldBack).length`), 1, 'один остался на второй год');
  await go(page, '#/');
  await page.click('button:has-text("Оформить выпуск")');
  await modal(page).locator('button:has-text("Оформить выпуск")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.status === 'graduated'));
  eq(await state(page, `S.enrollments.filter(e => e.status === 'pending-graduation').length`), 0, 'ожидающих нет');
});

await scenario('Импорт: CSV (Windows-1251, «;»), вставка из Excel (TSV), JSON, ошибки строк', async (page) => {
  await open(page, '#/import');
  const csv = cp1251('Фамилия;Имя;Отчество;Класс;Дата рождения\r\nИмпортов;Иван;Петрович;8A;05.04.2012\r\nПлохой;Ученик;;99Z;\r\nБезимени;;;7A;\r\nИмпортов;Иван;Петрович;8А;05.04.2012\r\n');
  await page.setInputFiles('#importFile', { name: 'class.csv', mimeType: 'text/csv', buffer: csv });
  await page.waitForSelector('#importOut table');
  const txt = await page.textContent('#importOut');
  assert(txt.includes('Создать: 1') && txt.includes('Ошибки: 2') && txt.includes('Пропустить: 1'), `сводка: ${txt.slice(0, 200)}`);
  assert(txt.includes('99Z'), 'ошибка по классу показана');
  assert(txt.includes('Фамилия') && txt.includes('Имя'), 'сопоставление колонок показано');
  await page.click('#importApply');
  await page.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.lastName === 'Импортов'));
  eq(await state(page, `S.students.find(s => s.lastName === 'Импортов').birthDate`), '2012-04-05', 'дата распознана');
  eq(await state(page, `S.enrollments.find(e => e.classId === '2026-2027:8A') !== undefined`), true, 'ученик в 8A');
  // TSV из буфера
  await page.fill('#importText', 'ФИО\tКласс\nПетров Пётр Сергеевич\t7A\nСидорова Анна\t9С\n');
  await page.click('#importParse');
  await page.waitForSelector('#importOut table');
  await page.click('#importApply');
  await page.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.lastName === 'Сидорова'));
  eq(await state(page, `S.enrollments.find(e => e.studentId === S.students.find(s => s.lastName === 'Сидорова').id).classId`), '2026-2027:9C', 'кириллическая С распознана как C');
  // персонал
  await open(page, '#/import');
  await page.locator('label.radio-card:has-text("Персонал") input').check();
  await page.fill('#importText', 'ФИО;Должность;Класс\nНовая Учитель Иванна;Классный руководитель;10A\nНовый Воспитатель Петрович;воспитатель;10A\n');
  await page.click('#importParse');
  await page.waitForSelector('#importOut table');
  await page.click('#importApply');
  await page.waitForFunction(() => window.__lyceum.store.state.assignments.length === 2);
  // JSON
  await open(page, '#/import');
  await page.fill('#importText', JSON.stringify({ students: [{ fio: 'Джейсонов Джейсон', class: '11B', birthDate: '2009-09-09' }], teachers: [{ fio: 'Учитель Джейсон', class: '11B' }] }));
  await page.click('#importParse');
  await page.waitForSelector('#importOut table');
  await page.click('#importApply');
  await page.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.lastName === 'Джейсонов'));
  // перед импортом создавались резервные копии
  eq(await state(page, `S.settings.lastBackupAt !== null`), true, 'резервная копия перед импортом');
});

await scenario('Зашифрованные данные: выбор файла, неверный пароль, расшифровка, предпросмотр, импорт; файл из data/ с неверным паролем', async (page) => {
  const box = await encryptJson({ students: [{ fio: 'Шифров Шифр Шифрович', class: '9B', birthDate: '2011-05-05' }, { fio: 'Тайнов Тайн', class: '9С', birthDate: '2011-06-06' }], teachers: [{ fio: 'Секретова Секрета', class: '9B' }] }, 'тестовый-пароль-123');
  assert(!JSON.stringify(box).includes('Шифров'), 'в зашифрованном файле нет открытого текста');
  await open(page, '#/import');
  await page.setInputFiles('#importFile', { name: 'data.enc.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(box)) });
  await modal(page).locator('input[name=unlockPass]').fill('неверный-пароль');
  await modal(page).locator('button:has-text("Расшифровать")').click();
  await page.waitForSelector('.toast.error:has-text("Неверный пароль")');
  assert(await modal(page).count() === 1, 'окно пароля осталось открытым');
  eq(await state(page, 'S.students.length'), 0, 'ничего не импортировано');
  await modal(page).locator('input[name=unlockPass]').fill('тестовый-пароль-123');
  await modal(page).locator('button:has-text("Расшифровать")').click();
  await page.waitForSelector('#importOut table');
  assert((await page.textContent('#importOut')).includes('Шифров Шифр Шифрович'), 'предпросмотр показывает расшифрованные данные');
  await page.click('#importApply');
  await page.waitForFunction(() => window.__lyceum.store.state.students.length === 2 && window.__lyceum.store.state.staff.length === 1);
  eq(await state(page, `S.enrollments.find(e => e.studentId === S.students.find(s => s.lastName === 'Тайнов').id).classId`), '2026-2027:9C', 'класс 9С распознан');
  // отмена ввода пароля — ничего не происходит
  await open(page, '#/import');
  await page.setInputFiles('#importFile', { name: 'data.enc.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(box)) });
  await modal(page).locator('button:has-text("Отмена")').click();
  await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
  eq(await page.locator('#importOut table').count(), 0, 'без пароля предпросмотра нет');
  // файл data/lyceum-data.enc.json из репозитория: с неверным паролем данные не раскрываются
  await open(page, '#/import');
  await page.click('#loadEncBtn');
  await modal(page).locator('input[name=unlockPass]').fill('точно-неверный-пароль');
  await modal(page).locator('button:has-text("Расшифровать")').click();
  await page.waitForSelector('.toast.error:has-text("Неверный пароль")');
  await modal(page).locator('button:has-text("Отмена")').click();
  eq(await state(page, 'S.students.length'), 2, 'данные из репозитория не загружены без пароля');
});

await scenario('Экспорт JSON, очистка, восстановление из файла и из копии в браузере, CSV-экспорт', async (page) => {
  await loadDemo(page);
  const total = await state(page, 'S.students.length');
  await go(page, '#/import');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportJsonBtn')]);
  const file = await dl.path();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq(data.format, 'lyceum-registry', 'формат файла');
  eq(data.students.length, total, 'учеников в файле');
  eq(data.settings.sheetsToken, undefined, 'токена в копии нет');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Ученики (CSV)")')]);
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  assert(csvText.startsWith('﻿Фамилия;Имя;Отчество;Класс'), 'CSV: BOM и заголовок');
  eq(csvText.trim().split('\r\n').length, total + 1, 'CSV: строк');
  // очистка
  await go(page, '#/settings');
  await page.click('#clearAllBtn');
  assert(await modal(page).locator('button:has-text("Очистить всё")').isDisabled(), 'очистка заблокирована до ввода слова');
  await modal(page).locator('input#confirm-typed').fill('ОЧИСТИТЬ');
  await modal(page).locator('button:has-text("Очистить всё")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.students.length === 0);
  eq(await state(page, 'S.classes.length'), 15, 'после очистки снова 15 классов');
  // восстановление из файла
  await go(page, '#/settings');
  await page.waitForSelector('#restoreFile');
  await page.setInputFiles('#restoreFile', file);
  await modal(page).locator('input#confirm-typed').fill('ЗАМЕНИТЬ');
  await modal(page).locator('button:has-text("Заменить данные")').click();
  await page.waitForFunction((n) => window.__lyceum.store.state.students.length === n, total);
  eq(await state(page, 'S.staff.length'), data.staff.length, 'сотрудники восстановлены');
  // автоматическая копия перед очисткой есть в списке
  await go(page, '#/settings');
  await page.waitForSelector('.backup-list li');
  assert((await page.textContent('.backup-list')).includes('перед очисткой'), 'в списке есть копия «перед очисткой»');
});

await scenario('Google Таблицы: проверка, выгрузка (структура запроса), ошибка сервера, автосинхронизация при открытии', async (page, context) => {
  const posts = [];
  let mode = 'ok';
  await context.route('**/script.google.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      posts.push(JSON.parse(req.postData()));
      if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom', headers: { 'access-control-allow-origin': '*' } });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, written: { 'Ученики': 1 } }), headers: { 'access-control-allow-origin': '*' } });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, lastSyncAt: new Date().toISOString() }), headers: { 'access-control-allow-origin': '*' } });
  });
  await loadDemo(page);
  await go(page, '#/settings');
  await page.fill('input[name=sheetsUrl]', 'https://evil.example.com/exec');
  await page.click('#sheets button:has-text("Сохранить")');
  assert((await page.locator('.toast.error').count()) >= 1, 'чужой адрес отклоняется');
  await page.fill('input[name=sheetsUrl]', 'https://script.google.com/macros/s/TEST/exec');
  await page.fill('input[name=sheetsToken]', 'секретный-токен');
  await page.click('#sheets button:has-text("Проверить соединение")');
  await page.waitForSelector('#sheets .notice:has-text("Соединение установлено")');
  await page.click('#syncNowBtn');
  await page.waitForSelector('#sheets .notice:has-text("Синхронизировано")');
  eq(posts.length, 1, 'один POST');
  const p = posts[0];
  eq(p.type, 'lyceum-sync', 'тип');
  eq(p.token, 'секретный-токен', 'токен');
  eq(Object.keys(p.sheets).join(','), 'Ученики,Классы,Учителя,Воспитатели,Отчёт,Архив,История', 'листы');
  eq(p.sheets['Ученики'].rows.length, await state(page, 'S.students.length'), 'строк учеников');
  eq(p.sheets['Классы'].rows.length, 15, 'строк классов');
  assert(JSON.parse(p.backup).format === 'lyceum-registry' && !p.backup.includes('секретный-токен'), 'резервная копия без токена');
  eq((await page.textContent('#syncStatus')).trim(), 'Google: синхронизировано', 'статус в шапке');
  eq(await state(page, 'S.settings.dirtySinceSync'), false, 'флаг изменений сброшен');
  // ошибка сервера
  mode = 'fail';
  await page.click('#syncNowBtn');
  await page.waitForSelector('#sheets .notice:has-text("Ошибка синхронизации")');
  // автосинхронизация при открытии: есть изменения → после загрузки уходит POST
  mode = 'ok';
  await go(page, classHash('7A'));
  await page.click('text=Добавить ученика');
  await modal(page).locator('input[name=lastName]').fill('Автосинк');
  await modal(page).locator('input[name=firstName]').fill('Тест');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.settings.dirtySinceSync === true);
  const before = posts.length;
  await page.reload();
  await page.waitForFunction(() => window.__lyceum?.store.state.settings.dirtySinceSync === false, null, { timeout: 15000 });
  assert(posts.length > before, 'автосинхронизация отправила данные при открытии');
  assert(posts[posts.length - 1].sheets['Ученики'].rows.some((r) => r[1] === 'Автосинк'), 'новый ученик в выгрузке');
}, { ignoreErrors: /status of 500/ });

for (const [name, vp] of [['смартфон 375×812', { width: 375, height: 812 }], ['планшет 768×1024', { width: 768, height: 1024 }], ['планшет 1024×768', { width: 1024, height: 768 }], ['ноутбук 1440×900', { width: 1440, height: 900 }]]) {
  await scenario(`Адаптивность: ${name}`, async (page) => {
    await loadDemo(page);
    for (const h of ['#/', '#/classes', classHash('9B'), '#/students', '#/staff', '#/new-year', '#/history', '#/reports', '#/archive', '#/import', '#/settings']) {
      await go(page, h);
      await page.waitForSelector('h1');
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      assert(w.sw <= w.iw + 1, `${h}: горизонтальная прокрутка (${w.sw} > ${w.iw})`);
    }
    if (vp.width < 1024) {
      assert(!(await page.locator('#sidebar').isVisible()), 'меню скрыто');
      await page.click('#menuBtn');
      await page.waitForSelector('#sidebar', { state: 'visible' });
      await page.click('#nav a:has-text("Ученики")');
      await page.waitForFunction(() => !document.body.classList.contains('nav-open'));
      eq(await page.textContent('h1'), 'Ученики', 'переход из меню');
    } else {
      assert(await page.locator('#sidebar').isVisible(), 'меню видно');
    }
    await go(page, '#/students');
    await page.click('button:has-text("Добавить ученика")');
    const box = await modal(page).boundingBox();
    assert(box.x >= -1 && box.x + box.width <= vp.width + 1 && box.y >= -1 && box.y + box.height <= vp.height + 1, `окно помещается в экран: ${JSON.stringify(box)}`);
    await modal(page).locator('button:has-text("Отмена")').click();
    if (vp.width < 640) {
      assert(await page.locator('table.responsive thead').evaluate((el) => el.getBoundingClientRect().height <= 1), 'на телефоне таблица превращается в карточки');
    }
  }, { viewport: vp });
}

await scenario('Хранилище недоступно (приватный режим): баннер и работа в памяти', async (page) => {
  await open(page);
  assert((await page.textContent('#banner')).includes('Данные не сохраняются'), 'красный баннер');
  await go(page, classHash('7A'));
  await page.click('text=Добавить ученика');
  await modal(page).locator('input[name=lastName]').fill('Память');
  await modal(page).locator('input[name=firstName]').fill('Тест');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page.waitForSelector('tr:has-text("Память Тест")');
}, { init: 'Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });' });

await scenario('Две вкладки: изменение видно в другой (BroadcastChannel)', async (page, context) => {
  await open(page, '#/students');
  const page2 = await context.newPage();
  await page2.goto(srv.url + '#/students');
  await page2.waitForSelector('h1');
  await go(page, classHash('7A'));
  await page.click('text=Добавить ученика');
  await modal(page).locator('input[name=lastName]').fill('Двухвкладков');
  await modal(page).locator('input[name=firstName]').fill('Тест');
  await modal(page).locator('button:has-text("Добавить")').click();
  await page2.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.lastName === 'Двухвкладков'), null, { timeout: 5000 });
});

await scenario('Печать: меню и кнопки скрыты; отчёты: общий, по классам, по персоналу', async (page) => {
  await loadDemo(page);
  await go(page, '#/reports');
  const total = await state(page, 'S.students.length');
  assert((await page.textContent('main table')).includes(String(total)), 'общий отчёт содержит число учеников');
  await page.click('button[role=tab]:has-text("По классам")');
  await page.waitForSelector('th:has-text("Классный руководитель")');
  eq(await page.locator('tbody tr').count(), 15, 'строк в отчёте по классам');
  assert((await page.textContent('main')).includes(`Итого: ${total} учеников в 15 классах`), 'итог');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Скачать CSV")')]);
  assert(fs.readFileSync(await dl.path(), 'utf8').includes('Класс;Учеников;Классный руководитель;Воспитатель'), 'CSV отчёта по классам');
  await page.click('button[role=tab]:has-text("По персоналу")');
  await page.waitForSelector('th:has-text("Закреплено классов")');
  eq(await page.locator('tbody tr').count(), 30, 'строк в отчёте по персоналу');
  await page.emulateMedia({ media: 'print' });
  eq(await page.locator('#sidebar').evaluate((el) => getComputedStyle(el).display), 'none', 'при печати меню скрыто');
});

await scenario('Настройки: название лицея, резервная копия в браузере и восстановление из неё', async (page) => {
  await loadDemo(page);
  await go(page, '#/settings');
  await page.fill('input[name=name]', 'Лицей №1 (тест)');
  await page.click('button:has-text("Сохранить") >> nth=0');
  await page.waitForFunction(() => window.__lyceum.store.state.settings.lyceumName === 'Лицей №1 (тест)');
  eq((await page.textContent('#brandName')).trim(), 'Лицей №1 (тест)', 'название в шапке');
  await page.click('button:has-text("Создать копию в браузере")');
  await page.waitForSelector('.backup-list li');
  await page.click('button:has-text("Удалить DEMO-данные")');
  await modal(page).locator('button:has-text("Удалить DEMO")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.students.length === 0);
  await page.locator('.backup-list li', { hasText: 'вручную' }).locator('button:has-text("Восстановить")').click();
  await modal(page).locator('input#confirm-typed').fill('ВОССТАНОВИТЬ');
  await modal(page).locator('button:has-text("Восстановить")').last().click();
  await page.waitForFunction(() => window.__lyceum.store.state.students.length > 300);
});

await scenario('Страница инструкции Google Apps Script доступна и содержит код', async (page) => {
  await page.goto(srv.url + 'google-apps-script/index.html');
  await page.waitForSelector('h1');
  await page.waitForFunction(() => document.querySelector('#code')?.textContent.includes('function doPost'));
  assert((await page.textContent('body')).includes('Развернуть'), 'шаги развёртывания');
});

await browser.close();
await srv.close();
console.log(`\nE2E (Chromium, подпуть /Obhod_BIL/)\n${results.join('\n')}\n\n${results.length - failed} из ${results.length} сценариев пройдено`);
process.exit(failed ? 1 : 0);
