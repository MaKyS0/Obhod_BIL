// E2E в настоящем браузере (Playwright + Chromium). Сайт обслуживается по подпути /Obhod_BIL/, как на GitHub Pages.
// Запуск: node tests/e2e/run.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startServer } from './server.mjs';
import { encryptJson } from '../../js/domain/crypto-box.js';
import { makeSandbox, call as gasCall, run as gasRun } from '../helpers/gas-sandbox.mjs';

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
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return; // E2E_ONLY=Роли node tests/e2e/run.mjs — один сценарий
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript("window.__LYCEUM_ACCESS_ENDPOINT__ = '';"); // обычные сценарии идут без допуска, чтобы не зависеть от config.js
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
await scenario('Первый запуск: 15 классов, главная — обход с пустым состоянием, DEMO из настроек, данные переживают перезагрузку', async (page) => {
  await open(page);
  eq(await page.textContent('h1'), 'Вечерний обход', 'главная страница — обход');
  assert((await page.textContent('main')).includes('База учеников пуста'), 'пустое состояние');
  eq(await page.locator('.kpis, .stat').count(), 0, 'на главной нет карточек с показателями');
  eq(await state(page, 'S.classes.length'), 15, 'классов в базе');
  eq(await state(page, 'S.settings.currentYearId'), await state(page, 'S.years[0].id'), 'год');
  await loadDemo(page);
  await go(page, '#/');
  await page.waitForSelector('section.round-class');
  const total = await state(page, "S.students.filter(s => s.status === 'active').length");
  assert(total > 300, 'демо загружено');
  eq(await page.locator('section.round-class').count(), 15, 'все 15 классов в обходе');
  const seven = await state(page, `S.enrollments.filter(e => e.classId && e.classId.includes(':7')).length`);
  assert(seven > 0, 'в седьмых классах есть ученики');
  eq(await page.locator('canvas').count(), 0, 'на главной нет декоративных графиков');
  await page.reload();
  await page.waitForSelector('section.round-class');
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
  // счётчик в меню пересчитан
  await go(page, '#/');
  eq((await page.textContent('#nav .nav-n[data-n=students]')).trim(), String(total - grads), 'число учеников в меню пересчитано');
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
  await go(page, '#/new-year');
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

// ---------------------------------------------------------------------------------------------
// Допуск посетителей: сервер — настоящий Code.gs в песочнице, подключённый вместо script.google.com.
const ENDPOINT = 'https://script.google.com/macros/s/TEST/exec';
async function accessSite(sb, { offline = { on: false } } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addInitScript(`window.__LYCEUM_ACCESS_ENDPOINT__ = ${JSON.stringify(ENDPOINT)}; window.__LYCEUM_POLL_MS__ = 300; window.__LYCEUM_LIVE_MS__ = 400; window.__LYCEUM_KICK_MS__ = 50; window.__LYCEUM_SHEETS_MS__ = 600;`);
  const errors = [];
  context.on('page', (pg) => {
    pg.on('console', (m) => m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
    pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  });
  await context.route('**/script.google.com/**', async (route) => {
    if (offline.on) return route.abort();
    if (offline.delayMs) await new Promise((r) => setTimeout(r, offline.delayMs)); // медленный скрипт Google
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*' };
    const body = req.method() === 'POST' ? gasCall(sb, 'doPost', { postData: { contents: req.postData() } }) : gasCall(sb, 'doGet', { parameter: Object.fromEntries(new URL(req.url()).searchParams) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), headers: cors });
  });
  const page = await context.newPage();
  return { context, page, errors };
}

await scenario('Допуск: запрос → письмо владельцу → решение → вход; отказ; отзыв стирает данные; права владельца', async () => {
  const sb = makeSandbox();
  const token = gasRun(sb, 'setup()');
  const opened = [];
  const site = async (o) => { const x = await accessSite(sb, o); opened.push(x); return x; };
  try {
    // --- посетитель видит только экран допуска
    const v = await site();
    await v.page.goto(srv.url);
    await v.page.waitForSelector('h1:has-text("Вход по разрешению")');
    assert(!(await v.page.locator('#sidebar').isVisible()), 'меню скрыто до допуска');
    assert(!(await v.page.innerText('body')).includes('Классы'), 'разделы сайта не показаны');
    await v.page.fill('input[name=visitorName]', 'Аб');
    await v.page.click('#requestAccessBtn');
    await v.page.waitForSelector('.field.invalid');
    eq(sb.mails.length, 0, 'с коротким именем запрос не ушёл');
    await v.page.fill('input[name=visitorName]', 'Мария Петрова');
    await v.page.fill('input[name=visitorEmail]', 'maria@example.org');
    await v.page.fill('textarea[name=visitorNote]', 'Воспитатель 8-х классов');
    await v.page.click('#requestAccessBtn');
    await v.page.waitForSelector('h1:has-text("Запрос отправлен")');
    eq(sb.mails.length, 1, 'владельцу ушло письмо');
    assert(sb.mails[0][2].includes('Мария Петрова') && sb.mails[0][2].includes('Воспитатель 8-х классов') && sb.mails[0][2].includes('maria@example.org'), 'в письме имя, почта и сообщение');
    // перезагрузка не даёт войти и не создаёт второй запрос
    await v.page.reload();
    await v.page.waitForSelector('h1:has-text("Запрос отправлен")');
    eq(sb.mails.length, 1, 'повторных писем нет');

    // --- владелец: неверный токен, затем верный
    const slow = { on: false, delayMs: 0 };
    const o = await site({ offline: slow });
    await o.page.goto(srv.url);
    await o.page.waitForSelector('#ownerLoginBtn');
    await o.page.click('#ownerLoginBtn');
    await o.page.fill('input[name=ownerToken]', 'неверный-токен');
    await o.page.click('#ownerLoginSubmit');
    await o.page.waitForSelector('.field.invalid');
    assert(!(await o.page.locator('#sidebar').isVisible()), 'с неверным токеном не пустило');
    await o.page.fill('input[name=ownerToken]', token);
    await o.page.click('#ownerLoginSubmit');
    await o.page.waitForSelector('#sidebar', { state: 'visible' });
    await o.page.waitForFunction(() => document.querySelector('#nav a[data-route=access] .nav-count')?.textContent.trim() === '1');
    eq(await o.page.evaluate(() => window.__lyceum.store.state.settings.sheetsUrl), ENDPOINT, 'адрес скрипта проставлен владельцу автоматически');
    await o.page.waitForTimeout(4500); // автосинхронизация стартует через 3 с после открытия
    eq(sb.sheets.has('Ученики'), false, 'пустая база владельца не затёрла таблицу автосинхронизацией');
    // повторное открытие не ждёт медленный скрипт Google (4 с на ответ): сайт виден сразу, доступ проверяется в фоне
    slow.delayMs = 4000;
    const tOpen = Date.now();
    await o.page.reload();
    await o.page.waitForSelector('#sidebar', { state: 'visible' });
    assert(Date.now() - tOpen < 2500, `сайт открылся без ожидания скрипта (${Date.now() - tOpen} мс)`);
    slow.delayMs = 0;
    await o.page.waitForFunction(() => document.querySelector('#nav a[data-route=access] .nav-count')?.textContent.trim() === '1', null, { timeout: 15000 });
    await o.page.click('#nav a[data-route=access]');
    await o.page.waitForSelector('tr:has-text("Мария Петрова")');
    assert((await o.page.textContent('tr:has-text("Мария Петрова")')).includes('Воспитатель 8-х классов'), 'сообщение видно владельцу');
    // посетитель всё ещё снаружи
    assert(!(await v.page.locator('#sidebar').isVisible()), 'до решения посетитель не вошёл');

    // администратор заранее загружает учебные данные: дежурный получит их без личных сведений
    await go(o.page, '#/settings');
    await o.page.click('#loadDemoBtn');
    await o.page.waitForFunction(() => window.__lyceum.store.state.students.length > 300);
    await o.page.waitForFunction(() => window.__lyceum.store.state.settings.liveRev > 0 && window.__lyceum.store.state.settings.liveOutbox.length === 0);
    await o.page.click('#nav a[data-route=access]');
    await o.page.waitForSelector('tr:has-text("Мария Петрова")');
    assert((await o.page.textContent('tr:has-text("Мария Петрова")')).includes('maria@example.org'), 'почта видна администратору');
    await o.page.click('tr:has-text("Мария Петрова") [data-act=allow]');
    await o.page.waitForSelector('tr:has-text("Мария Петрова"):has-text("Допущен")');
    await v.page.waitForSelector('#sidebar', { state: 'visible' });
    eq(await v.page.textContent('h1'), 'Вечерний обход', 'допущенный дежурный вошёл сам и видит обход');
    eq(await v.page.locator('#nav a').count(), 1, 'в меню дежурного один пункт — «Обход»');
    eq(await v.page.evaluate(() => document.body.dataset.role), 'user', 'роль — дежурный');
    assert(!(await v.page.locator('#searchForm').isVisible()), 'поиска по всем ученикам у дежурного нет');
    await v.page.waitForFunction(() => window.__lyceum.store.state.students.length > 300);
    // сервер не отдаёт дежурному личные сведения
    eq(await state(v.page, 'S.students.filter((s) => s.birthDate || s.notes || s.contacts).length'), 0, 'у дежурного нет дат рождения, заметок и контактов');
    assert(await state(o.page, 'S.students.some((s) => s.birthDate)'), 'у администратора личные сведения на месте');
    // разделы администратора закрыты: страница даже не строится
    for (const hash of ['#/access', '#/admin', '#/admin/logs', '#/students', '#/settings']) {
      await v.page.evaluate((h) => (location.hash = h), hash);
      await v.page.waitForSelector('#accessDenied');
      eq(await v.page.locator('#view table, #view form, #view #loadDemoBtn').count(), 0, `${hash}: данных нет, только сообщение`);
    }
    await v.page.evaluate(() => (location.hash = '#/'));
    await v.page.waitForSelector('section.round-class');

    // --- второй посетитель получает отказ и остаётся снаружи
    const v2 = await site();
    await v2.page.goto(srv.url);
    await v2.page.fill('input[name=visitorName]', 'Посторонний Человек');
    await v2.page.click('#requestAccessBtn');
    await v2.page.waitForSelector('h1:has-text("Запрос отправлен")');
    await o.page.click('#accessRefresh');
    await o.page.waitForSelector('tr:has-text("Посторонний Человек")');
    await o.page.click('tr:has-text("Посторонний Человек") [data-act=deny]');
    await o.page.locator('dialog.modal[open] button:has-text("Отклонить")').last().click();
    await o.page.waitForSelector('tr:has-text("Посторонний Человек"):has-text("Отклонён")');
    await v2.page.waitForSelector('h1:has-text("В доступе отказано")');
    await v2.page.reload();
    await v2.page.waitForSelector('h1:has-text("В доступе отказано")');
    assert(!(await v2.page.locator('#sidebar').isVisible()), 'отклонённый не видит сайт');

    // --- отзыв: после перезагрузки экран «Доступ отозван», локальные данные стёрты
    await o.page.click('tr:has-text("Мария Петрова") [data-act=revoke]');
    await o.page.locator('dialog.modal[open] button:has-text("Отозвать доступ")').click();
    await o.page.waitForSelector('tr:has-text("Мария Петрова"):has-text("Отозван")');
    // Устройство само узнаёт об отзыве (общая база отвечает «forbidden») и перезагружается — свою перезагрузку не гоняем наперегонки с ней.
    await v.page.waitForSelector('h1:has-text("Доступ отозван")', { timeout: 8000 });
    await v.page.waitForTimeout(300);
    eq(await v.page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'lyceum-db')), false, 'база посетителя удалена');
    assert(!(await v.page.locator('#sidebar').isVisible()), 'отозванный не видит сайт');

    // --- владелец после перезагрузки входит сразу (токен сохранён)
    await o.page.reload();
    await o.page.waitForSelector('#sidebar', { state: 'visible' });
    // --- нет связи: экран с повтором, сайт не открывается
    const off = { on: true };
    const v3 = await site({ offline: off });
    await v3.page.goto(srv.url);
    await v3.page.waitForSelector('h1:has-text("Нет связи с сервером допуска")');
    assert(!(await v3.page.locator('#sidebar').isVisible()), 'без связи сайт закрыт');
    off.on = false;
    await v3.page.click('#retryBtn');
    await v3.page.waitForSelector('h1:has-text("Вход по разрешению")');
    const all = opened.flatMap((x) => x.errors);
    if (all.length) throw new Error(`Ошибки в консоли браузера:\n  ${all.join('\n  ')}`);
  } finally {
    for (const x of opened) await x.context.close();
  }
});

// Читаем скачанный .xlsx настоящим openpyxl: заголовки, значения, автофильтр, закрепление шапки.
const PY_XLSX = 'import sys, json, openpyxl\nwb = openpyxl.load_workbook(sys.argv[1])\nws = wb.active\nprint(json.dumps({"title": ws.title, "rows": [[(str(c.value) if c.value is not None else None) for c in r] for r in ws.iter_rows()], "filter": ws.auto_filter.ref, "freeze": ws.freeze_panes}))';
const readXlsx = (file) => JSON.parse(execFileSync('python3', ['-I', '-c', PY_XLSX, file], { encoding: 'utf8' }));
const downloadOf = async (page, click) => {
  const [d] = await Promise.all([page.waitForEvent('download'), click()]);
  const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/lyc-dl-`);
  const file = `${dir}/${d.suggestedFilename()}`;
  await d.saveAs(file);
  return { name: d.suggestedFilename(), file };
};

await scenario('Роли: запрос → ACCEPT/REJECT → дежурный отмечает обход → администратор видит день, журнал и скачивает новый .xlsx каждый раз', async () => {
  const sb = makeSandbox();
  const token = gasRun(sb, 'setup()');
  const opened = [];
  const site = async (o) => { const x = await accessSite(sb, o); opened.push(x); return x; };
  try {
    const o = await site();
    await o.page.goto(srv.url);
    await o.page.click('#ownerLoginBtn');
    await o.page.fill('input[name=ownerToken]', token);
    await o.page.click('#ownerLoginSubmit');
    await o.page.waitForSelector('#sidebar', { state: 'visible' });
    await o.page.waitForFunction(() => window.__lyceum);
    await go(o.page, '#/settings');
    await o.page.click('#loadDemoBtn');
    await o.page.waitForFunction(() => window.__lyceum.store.state.students.length > 300);
    await o.page.waitForFunction(() => window.__lyceum.store.state.settings.liveRev > 0 && window.__lyceum.store.state.settings.liveOutbox.length === 0);

    // календарь: администратор назначает дежурного — дежурный увидит его на экране обхода
    await go(o.page, '#/admin/calendar');
    await o.page.click('tr.is-today [data-edit]');
    await modal(o.page).locator('input[name=dutyText]').fill('Иванов (воспитатель)');
    await modal(o.page).locator('button:has-text("Сохранить")').click();
    await o.page.waitForSelector('tr.is-today:has-text("Иванов (воспитатель)")');
    await o.page.waitForFunction(() => window.__lyceum.store.state.settings.liveOutbox.length === 0);

    // два запроса: один примет администратор, другой отклонит
    const asker = async (name, email) => {
      const x = await site();
      await x.page.goto(srv.url);
      await x.page.fill('input[name=visitorName]', name);
      await x.page.fill('input[name=visitorEmail]', email);
      await x.page.click('#requestAccessBtn');
      await x.page.waitForSelector('h1:has-text("Запрос отправлен")');
      return x;
    };
    const v = await asker('Дежурная Анна', 'anna@example.org');
    const v2 = await asker('Лишний Человек', 'x@example.org');
    eq(sb.mails.length, 2, 'на каждый запрос ушло письмо администратору');
    assert(sb.mails.every((m) => m[2].includes('@example.org')), 'в письмах есть почта просителя');
    await go(o.page, '#/access');
    await o.page.click('#accessRefresh');
    await o.page.waitForSelector('tr:has-text("Дежурная Анна") [data-act=allow]');
    // ACCEPT / REJECT
    await o.page.click('tr:has-text("Лишний Человек") [data-act=deny]');
    await o.page.locator('dialog.modal[open] button:has-text("Отклонить")').last().click();
    await o.page.waitForSelector('tr:has-text("Лишний Человек"):has-text("Отклонён")');
    await v2.page.waitForSelector('h1:has-text("В доступе отказано")');
    await o.page.click('tr:has-text("Дежурная Анна") [data-act=allow]');
    await o.page.waitForSelector('tr:has-text("Дежурная Анна"):has-text("Допущен")');
    await v.page.waitForSelector('#sidebar', { state: 'visible' });
    await v.page.waitForSelector('section.round-class');
    eq(await v.page.evaluate(() => document.body.dataset.role), 'user', 'принятая как дежурная');
    assert((await v.page.textContent('.duty-line')).includes('Иванов (воспитатель)'), 'дежурный видит назначенного дежурного');

    // дежурная отмечает двух учеников
    await v.page.click('button.round-head[data-class="2026-2027:7A"]');
    await v.page.locator('section[data-class="2026-2027:7A"] .round-row').nth(0).locator('button.rp-sleeping').click();
    await v.page.locator('section[data-class="2026-2027:7A"] .round-row').nth(1).locator('button.rp-sick').click();
    await modal(v.page).locator('.reason-chip:has-text("Температура")').click();
    await v.page.waitForFunction(() => window.__lyceum.store.state.settings.liveOutbox.length === 0 && window.__lyceum.store.state.rounds.filter((r) => r.by).length === 2, null, { timeout: 15000 });
    eq(await state(v.page, "S.rounds.every((r) => r.by === 'Дежурная Анна')"), true, 'сервер подписал отметки именем дежурной');

    // администратор: отметки пришли в общую базу, «Обзор дня» показывает их с временем и ответственным
    await o.page.waitForFunction(() => window.__lyceum.store.state.rounds.length >= 2, null, { timeout: 15000 });
    await go(o.page, '#/admin');
    await o.page.waitForSelector('h1:has-text("Обзор дня")');
    const row7a = o.page.locator('table:has(caption:text-is("Обход по классам")) tr:has-text("7A")');
    await row7a.waitFor();
    assert((await row7a.textContent()).includes('Дежурная Анна'), 'в строке класса — кто и когда отмечал последним');
    await o.page.waitForSelector('table:has(caption:text-is("Ученики и статусы")) tr:has-text("Болеет")');
    await o.page.waitForSelector('table:has(caption:text-is("Ученики и статусы")) tr:has-text("Температура")', { timeout: 15000 }); // причина видна администратору
    await o.page.selectOption('select[name=dayStatus]', 'sick');
    eq(await o.page.locator('table:has(caption:text-is("Ученики и статусы")) tbody tr').count(), 1, 'фильтр по статусу');
    await o.page.selectOption('select[name=dayStatus]', '');

    // Excel: каждый экспорт — новый файл с понятным именем
    const d1 = await downloadOf(o.page, () => o.page.click('#exportDayBtn'));
    assert(/^evening-round-\d{4}-\d\d-\d\d-\d\d-\d\d(-\d+)?\.xlsx$/.test(d1.name), `имя файла: ${d1.name}`);
    const x1 = readXlsx(d1.file);
    eq(x1.rows[0].join('|'), 'Дата|Время|Ученик|Класс|Статус|Причина|Ответственный', 'заголовки столбцов');
    assert(x1.rows.length > 300, `строк в файле: ${x1.rows.length}`);
    assert(x1.filter && x1.freeze === 'A2', 'автофильтр и закрепление шапки');
    const marked = x1.rows.filter((r) => r[6] === 'Дежурная Анна');
    eq(marked.length, 2, 'в файле две отметки дежурной');
    assert(marked.some((r) => r[4] === 'Болеет' && r[5] === 'Температура') && marked.every((r) => /^\d\d:\d\d/.test(r[1])), 'статус, причина и время отметки в файле');
    assert(x1.rows.slice(1).every((r) => /^\d{4}-\d\d-\d\d/.test(r[0])), 'даты — настоящие даты');
    const d2 = await downloadOf(o.page, () => o.page.click('#exportDayBtn'));
    assert(d2.name !== d1.name && /\.xlsx$/.test(d2.name), `второй экспорт — другой файл (${d1.name} / ${d2.name})`);

    // журнал: все события, фильтр по группе и участнику, запись о выгрузке
    await go(o.page, '#/admin/logs');
    await o.page.waitForSelector('tbody tr[data-event]', { timeout: 20000 });
    const seen = async () => (await o.page.$$eval('tbody tr[data-event]', (rows) => rows.map((r) => r.dataset.event)));
    const ev = await seen();
    for (const need of ['access-request', 'access-allow', 'access-deny', 'login', 'round-set', 'export']) assert(ev.includes(need), `в журнале есть событие ${need} (${[...new Set(ev)].join(',')})`);
    assert((await o.page.textContent('tbody')).includes('Дежурная Анна'), 'в журнале видно, кто что делал');
    await o.page.selectOption('select[name=logGroup]', 'export');
    await o.page.click('#logApply');
    await o.page.waitForFunction(() => [...document.querySelectorAll('tbody tr[data-event]')].every((r) => r.dataset.event === 'export') && document.querySelectorAll('tbody tr[data-event]').length >= 2, null, { timeout: 20000 });

    // отчёт за период и выгрузка периода
    await go(o.page, '#/admin/reports');
    await o.page.click('#repShow');
    await o.page.waitForSelector('table:has(caption:text-is("Итоги по дням")) tbody tr', { timeout: 20000 });
    const d3 = await downloadOf(o.page, () => o.page.click('#repDownload'));
    assert(d3.name !== d1.name && d3.name !== d2.name, 'выгрузка периода — тоже новый файл');
    eq(readXlsx(d3.file).rows.filter((r) => r[6] === 'Дежурная Анна').length, 2, 'в файле периода те же две отметки');

    if (process.env.E2E_SHOTS) { // E2E_SHOTS=папка — снимки экранов страниц администратора для ручного просмотра
      for (const [w, h] of [[1280, 900], [375, 812]]) {
        await o.page.setViewportSize({ width: w, height: h });
        for (const [name, hash, sel] of [['day', '#/admin', 'table.data'], ['logs', '#/admin/logs', 'tbody tr[data-event]'], ['reports', '#/admin/reports', 'table.data'], ['access', '#/access', 'table.data']]) {
          await go(o.page, hash);
          await o.page.waitForSelector(sel, { timeout: 20000 });
          await o.page.waitForTimeout(600);
          await o.page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}-${w}.png` });
        }
      }
      await o.page.setViewportSize({ width: 1280, height: 900 });
    }

    // отзыв доступа закрывает устройство дежурной
    await go(o.page, '#/access');
    await o.page.click('tr:has-text("Дежурная Анна") [data-act=revoke]');
    await o.page.locator('dialog.modal[open] button:has-text("Отозвать доступ")').click();
    await v.page.waitForSelector('h1:has-text("Доступ отозван")', { timeout: 10000 });
    const all = opened.flatMap((x) => x.errors);
    if (all.length) throw new Error(`Ошибки в консоли браузера:\n  ${all.join('\n  ')}`);
  } finally {
    for (const x of opened) await x.context.close();
  }
});

await scenario('Общая база: два устройства видят одни данные, правки доходят без перезагрузки, ввод не прерывается, отзыв закрывает доступ', async () => {
  const sb = makeSandbox();
  const token = gasRun(sb, 'setup()');
  const opened = [];
  const site = async (o) => { const x = await accessSite(sb, o); opened.push(x); return x; };
  const addStudent = async (page, last, first) => {
    await go(page, classHash('7A'));
    await page.click('text=Добавить ученика');
    await modal(page).locator('input[name=lastName]').fill(last);
    await modal(page).locator('input[name=firstName]').fill(first);
    await modal(page).locator('button:has-text("Добавить")').click();
    await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
  };
  try {
    // --- владелец входит и загружает данные (первое устройство)
    const o = await site();
    await o.page.goto(srv.url);
    await o.page.click('#ownerLoginBtn');
    await o.page.fill('input[name=ownerToken]', token);
    await o.page.click('#ownerLoginSubmit');
    await o.page.waitForSelector('#sidebar', { state: 'visible' });
    await o.page.waitForFunction(() => window.__lyceum);
    await go(o.page, '#/settings');
    await o.page.click('#loadDemoBtn');
    await o.page.waitForFunction(() => window.__lyceum.store.state.students.length > 300);
    const total = await state(o.page, 'S.students.length');
    await o.page.waitForFunction(() => window.__lyceum.store.state.settings.liveRev > 0 && window.__lyceum.store.state.settings.liveOutbox.length === 0);
    assert(/База: актуально/.test(await o.page.textContent('#syncStatus')), 'в шапке «База: актуально»');

    // --- посетитель: запрос, допуск — и у него сразу те же данные, без импорта
    const v = await site();
    await v.page.goto(srv.url);
    await v.page.fill('input[name=visitorName]', 'Мария Петрова');
    await v.page.click('#requestAccessBtn');
    await v.page.waitForSelector('h1:has-text("Запрос отправлен")');
    await go(o.page, '#/access');
    await o.page.waitForSelector('tr:has-text("Мария Петрова")');
    await o.page.click('tr:has-text("Мария Петрова") [data-act=allow-admin]');
    await v.page.waitForSelector('#sidebar', { state: 'visible' });
    await v.page.waitForFunction((n) => window.__lyceum && window.__lyceum.store.state.students.length === n, total);
    eq(await state(v.page, 'S.settings.currentYearId'), await state(o.page, 'S.settings.currentYearId'), 'тот же учебный год');

    // --- правка посетителя доходит до владельца без перезагрузки и видна в списке
    await go(o.page, classHash('7A'));
    await addStudent(v.page, 'Живов', 'Посетитель');
    await o.page.waitForSelector('tr:has-text("Живов Посетитель")');
    eq(await state(o.page, "S.students.filter(s => s.lastName === 'Живов').length"), 1, 'у владельца одна запись');

    // --- владелец вводит данные в окне, пока приходит чужая правка: окно не закрывается, текст не теряется
    await o.page.click('text=Добавить ученика');
    await modal(o.page).locator('input[name=lastName]').fill('Черновиков');
    await addStudent(v.page, 'Второй', 'Посетитель');
    await o.page.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.lastName === 'Второй'));
    await o.page.waitForTimeout(2200);
    eq(await modal(o.page).count(), 1, 'окно владельца осталось открытым');
    eq(await modal(o.page).locator('input[name=lastName]').inputValue(), 'Черновиков', 'введённый текст не потерян');
    await modal(o.page).locator('input[name=firstName]').fill('Владелец');
    await modal(o.page).locator('button:has-text("Добавить")').click();
    await o.page.waitForSelector('dialog.modal[open]', { state: 'detached' });
    await o.page.waitForSelector('tr:has-text("Второй Посетитель")');
    await v.page.waitForFunction(() => window.__lyceum.store.state.students.some((s) => s.lastName === 'Черновиков'));
    await go(v.page, classHash('7A'));
    await v.page.waitForSelector('tr:has-text("Черновиков Владелец")');

    // --- оба состояния идентичны, а читаемые листы таблицы обновились
    const ids = async (p) => (await state(p, 'S.students.map((s) => s.id).sort().join()'));
    eq(await ids(o.page), await ids(v.page), 'у обоих одинаковый список учеников');
    await o.page.waitForFunction(() => window.__lyceum.store.state.settings.liveOutbox.length === 0);
    await v.page.waitForFunction(() => window.__lyceum.store.state.settings.liveOutbox.length === 0);
    await new Promise((r) => setTimeout(r, 1800));
    assert(sb.sheets.has('Ученики') && sb.sheets.get('Ученики').lastRow > total, 'лист «Ученики» заполнен сервером из общей базы');
    assert(JSON.parse(gasCall(sb, 'doGet', { parameter: { action: 'backup', token } }).backup).students.length === total + 3, 'на сервере все 3 новых ученика');

    // --- посетитель отчисляет ученика — у владельца он пропадает из класса
    await v.page.locator('tr:has-text("Живов Посетитель")').locator('button:has-text("Удалить")').click();
    await modal(v.page).locator('button:has-text("Отчислить в архив")').click();
    await o.page.waitForSelector('tr:has-text("Живов Посетитель")', { state: 'detached' });

    // --- отзыв: устройство посетителя само закрывается и стирает данные
    await go(o.page, '#/access');
    await o.page.click('tr:has-text("Мария Петрова") [data-act=revoke]');
    await o.page.locator('dialog.modal[open] button:has-text("Отозвать доступ")').click();
    await v.page.waitForSelector('h1:has-text("Доступ отозван")', { timeout: 8000 });
    await v.page.waitForTimeout(300);
    eq(await v.page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'lyceum-db')), false, 'база отозванного устройства стёрта');
    const all = opened.flatMap((x) => x.errors);
    if (all.length) throw new Error(`Ошибки в консоли браузера:\n  ${all.join('\n  ')}`);
  } finally {
    for (const x of opened) await x.context.close();
  }
});

await scenario('Обход (телефон 375×812): главная страница сайта, 4 статуса, время и имя, класс зеленеет, причина, поиск, фильтр, подтверждение массовой отметки', async (page) => {
  await loadDemo(page);
  await go(page, '#/');
  await page.waitForSelector('section.round-class');
  eq(await page.textContent('h1'), 'Вечерний обход', 'после входа открывается обход, а не дашборд');
  eq(await page.locator('section.round-class').count(), 15, 'все классы в списке');
  eq(await page.locator('section.round-class[data-done="true"]').count(), 0, 'пока ни один класс не готов');
  const bg = (sel) => page.$eval(sel, (e) => getComputedStyle(e).backgroundColor);
  eq(await bg('section.round-class[data-class="2026-2027:7A"]'), 'rgb(236, 239, 243)', 'незавершённый класс серый');
  assert(/^\d\d:\d\d$/.test((await page.textContent('#roundClock')).trim()), 'на экране текущее время');
  assert((await page.textContent('.pagehead .sub')).length > 8, 'на экране текущая дата');
  eq((await page.textContent('#roundMarked')).trim(), '0', 'отмечено: 0');
  eq((await page.textContent('#roundLeft')).trim(), '15', 'осталось классов: 15');
  assert((await page.textContent('.duty-line')).includes('не назначен'), 'дежурный не назначен');
  assert(await page.locator('.seg [data-kind=morning]').count() === 1, 'есть переключатель вида проверки');

  // раскрыть 7A, проверить удобство на телефоне
  await page.click('button.round-head[data-class="2026-2027:7A"]');
  const n = await page.locator('section[data-class="2026-2027:7A"] .round-row').count();
  assert(n > 5, `в 7A есть ученики (${n})`);
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  assert(w[0] <= w[1], `нет горизонтальной прокрутки на 375px (${w[0]} > ${w[1]})`);
  const sizes = await page.$$eval('section[data-class="2026-2027:7A"] .rp', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  assert(sizes.every(([sw, sh]) => sh >= 48 && sw >= 60), `кнопки крупные для пальца: ${JSON.stringify(sizes.slice(0, 4))}`);
  eq(await page.$$eval('section[data-class="2026-2027:7A"] .round-row:first-child .rp', (els) => els.map((e) => e.innerText.trim()).join('|')), 'Болеет|С дома|Нет|Ночует', 'четыре статуса');

  // отметки: разные места; последняя отметка делает класс зелёным и сворачивает его. Красный статус сам открывает окно причины.
  const places = ['sleeping', 'sick', 'home', 'absent'];
  for (let i = 0; i < n; i++) {
    const row = page.locator('section[data-class="2026-2027:7A"] .round-row').nth(i);
    const place = places[i % 4];
    if (i === 2) {
      await page.evaluate(() => window.scrollTo(0, 400));
      const y0 = await page.evaluate(() => window.scrollY);
      await row.locator(`button.rp-${place}`).click();
      await page.waitForSelector('dialog.modal[open]');
      await modal(page).locator('button:has-text("Без причины")').click();
      await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
      const y1 = await page.evaluate(() => window.scrollY);
      assert(Math.abs(y1 - y0) < 6, `прокрутка не прыгает после отметки (${y0} → ${y1})`);
      continue;
    }
    if (await page.locator('section[data-class="2026-2027:7A"] .round-row').count() <= i) break;
    await row.locator(`button.rp-${place}`).click();
    if (place !== 'sleeping') {
      if (i === 1) { // готовая причина одним касанием
        await page.waitForSelector('dialog.modal[open]');
        eq(await modal(page).locator('.reason-chip:has-text("Температура")').count(), 1, 'готовые причины для «Болеет»');
        await modal(page).locator('.reason-chip:has-text("Температура")').click();
      } else {
        await page.waitForSelector('dialog.modal[open]');
        await modal(page).locator('button:has-text("Без причины")').click();
      }
      await page.waitForSelector('dialog.modal[open]', { state: 'detached' });
    }
  }
  await page.waitForSelector('section[data-class="2026-2027:7A"][data-done="true"]');
  eq(await bg('section.round-class[data-class="2026-2027:7A"]'), 'rgb(229, 241, 231)', 'цвет зелёный');
  await page.waitForSelector('button.round-head[data-class="2026-2027:7A"][aria-expanded="false"]');
  eq(await page.locator('section.round-class[data-done="true"]').count(), 1, 'готов ровно один класс');
  eq(await state(page, "S.rounds.filter(r => r.classId === '2026-2027:7A').length"), n, 'отметки записаны в базу');
  eq((await page.textContent('#roundLeft')).trim(), '14', 'осталось классов: 14');
  assert(await state(page, "S.rounds.every(r => /^\\d{4}-\\d\\d-\\d\\dT/.test(r.at))"), 'у каждой отметки есть время');

  // время отметки видно в строке; причина — своя
  await page.click('button.round-head[data-class="2026-2027:7A"]');
  const first = page.locator('section[data-class="2026-2027:7A"] .round-row').nth(0);
  const second = page.locator('section[data-class="2026-2027:7A"] .round-row').nth(1);
  assert(/^\d\d:\d\d/.test((await first.locator('.round-when').innerText()).trim()), 'у отмеченного показано время');
  eq(await second.locator('button.rp-sick').getAttribute('aria-pressed'), 'true', 'второй ученик отмечен «Болеет»');
  assert((await second.locator('.round-reason').innerText()).includes('Температура'), 'причина «Температура» сохранена');
  assert((await first.locator('.round-reason').innerText()).trim() === 'Причина', 'у «Ночует» есть кнопка «Причина»');
  await first.locator('.round-reason').click();
  await modal(page).locator('input[name=roundReason]').fill('Был у врача');
  await modal(page).locator('button:has-text("Сохранить")').click();
  await page.waitForSelector('section[data-class="2026-2027:7A"] .round-row:has-text("Причина: Был у врача")');
  eq(await state(page, 'S.rounds.filter((r) => r.reason).length'), 2, 'две причины в базе');
  // смена места сбрасывает причину (окно причины открывается заново — закрываем)
  await second.locator('button.rp-home').click();
  await page.waitForSelector('dialog.modal[open]');
  await modal(page).locator('button:has-text("Без причины")').click();
  await page.waitForFunction(() => window.__lyceum.store.state.rounds.filter((r) => r.reason).length === 1);

  // снять отметку — класс снова серый; повторное касание того же места снимает
  await page.locator('section[data-class="2026-2027:7A"] .round-row').first().locator('button[aria-pressed="true"]').click();
  await page.waitForSelector('section[data-class="2026-2027:7A"][data-done="false"]');
  eq(await bg('section.round-class[data-class="2026-2027:7A"]'), 'rgb(236, 239, 243)', 'серый');
  await page.locator('section[data-class="2026-2027:7A"] .round-row').first().locator('button.rp-sleeping').click();
  await page.waitForSelector('section[data-class="2026-2027:7A"][data-done="true"]');

  // массовая отметка в 7B с подтверждением
  await page.click('button.round-head[data-class="2026-2027:7B"]');
  await page.locator('section[data-class="2026-2027:7B"] .rp-sick').first().click();
  await modal(page).locator('button:has-text("Без причины")').click();
  await page.waitForSelector('section[data-class="2026-2027:7B"] button[aria-pressed="true"].rp-sick');
  await page.click('button[data-bulk="2026-2027:7B"]');
  await page.waitForSelector('dialog.modal[open]');
  await modal(page).locator('button:has-text("Отмена")').click();
  eq(await page.locator('section[data-class="2026-2027:7B"][data-done="true"]').count(), 0, 'без подтверждения класс не закрыт');
  await page.click('button[data-bulk="2026-2027:7B"]');
  await modal(page).locator('button:has-text("Отметить:")').click();
  await page.waitForSelector('section[data-class="2026-2027:7B"][data-done="true"]');
  eq(await state(page, "S.rounds.filter(r => r.classId === '2026-2027:7B' && r.place === 'sick').length"), 1, 'ранее выбранное «Болеет» не затёрто');

  // фильтры и поиск
  await page.click('[data-filter=open]');
  eq(await page.locator('section.round-class[data-done="true"]').count(), 0, 'готовые классы скрыты фильтром');
  eq(await page.locator('section.round-class').count(), 13, 'остались неготовые');
  await page.click('[data-filter=all]');
  await page.click('[data-filter=away]');
  assert(await page.locator('section.round-class .round-row').count() >= 3, 'фильтр «Отсутствуют» показывает ушедших');
  assert(await page.locator('section.round-class .rp-sleeping[aria-pressed="true"]').count() === 0, 'в «Отсутствуют» нет «Ночует»');
  await page.click('[data-filter=all]');
  const lastName = await state(page, "S.students.find(s => s.id === S.rounds[0].studentId).lastName");
  await page.fill('#roundSearch', lastName);
  await page.waitForSelector('.round-class.found .round-row');
  assert(await page.locator('.round-class.found .round-row').count() >= 1, 'поиск находит ученика среди всех классов');
  await page.fill('#roundSearch', '');

  // сохранение после перезагрузки
  const total = await state(page, 'S.rounds.length');
  await page.reload();
  await page.waitForSelector('section.round-class');
  eq(await state(page, 'S.rounds.length'), total, 'отметки сохранились');
  eq(await page.locator('section.round-class[data-done="true"]').count(), 2, 'зелёные классы после перезагрузки');
  // утренняя проверка — отдельный список, вечерние отметки не затрагивает
  await page.click('.seg [data-kind=morning]');
  await page.waitForSelector('h1:has-text("Утренняя проверка")');
  eq(await page.locator('section.round-class[data-done="true"]').count(), 0, 'утренняя проверка пока пустая');
  await page.click('button.round-head[data-class="2026-2027:7A"]');
  await page.locator('section[data-class="2026-2027:7A"] .rp-sleeping').first().click();
  await page.waitForFunction(() => window.__lyceum.store.state.rounds.some((r) => r.kind === 'morning'));
  eq(await state(page, "S.rounds.filter(r => r.kind === 'morning').length"), 1, 'утренняя отметка отдельная');
  eq(await state(page, 'S.rounds.length'), total + 1, 'вечерние отметки на месте');
  // пункт меню на телефоне
  await page.click('#menuBtn');
  await page.waitForSelector('#nav a[data-route=rounds]', { state: 'visible' });
  await page.waitForTimeout(250);
  const navH = await page.$eval('#nav a[data-route=rounds]', (e) => e.getBoundingClientRect().height);
  assert(navH >= 44, `пункт меню крупный (${navH})`);
}, { viewport: { width: 375, height: 812 } });

await scenario('Анимации и подпись разработчика: включаются вне автотестов, плавно играют, не ломают работу; подпись видна', async (page) => {
  await open(page, '#/');
  assert(!(await page.evaluate(() => document.documentElement.classList.contains('no-anim'))), 'анимации включены (window.__LYCEUM_ANIMATE__)');
  // страница появляется по очереди
  await page.waitForSelector('#view.page-enter');
  const first = await page.$eval('#view.page-enter > *', (e) => getComputedStyle(e).animationName);
  eq(first, 'rise', 'блоки страницы появляются анимацией rise');
  // подпись разработчика на каждом экране
  const foot = page.locator('footer.site-foot');
  assert(await foot.isVisible(), 'подпись разработчика видна');
  assert((await foot.textContent()).includes('Разработчик MaKyS0'), 'имя разработчика');
  eq(await foot.locator('a').first().getAttribute('href'), 'https://github.com/MaKyS0', 'ссылка на GitHub');
  assert((await foot.locator('a').first().getAttribute('rel')).includes('noopener'), 'ссылка с noopener');
  await loadDemo(page);
  // навигация: новая страница снова анимируется, прокрутка вверх; обновление данных страницу не перезапускает
  await go(page, '#/rounds');
  await page.waitForSelector('section.round-class');
  await page.click('button.round-head[data-class="2026-2027:7A"]');
  eq(await page.$eval('section[data-class="2026-2027:7A"] .round-body', (e) => getComputedStyle(e).animationName), 'open-body', 'тело класса раскрывается анимацией');
  const n = await page.locator('section[data-class="2026-2027:7A"] .round-row').count();
  for (let i = 0; i < n; i++) {
    await page.locator('section[data-class="2026-2027:7A"] .round-row').nth(i).locator('button.rp-sleeping').click();
    await page.waitForTimeout(30);
  }
  await page.waitForSelector('section[data-class="2026-2027:7A"][data-done="true"]');
  eq(await page.$eval('section[data-class="2026-2027:7A"]', (e) => e.classList.contains('just-done')), true, 'готовый класс «выскакивает» один раз');
  await page.click('button.round-head[data-class="2026-2027:7B"]');
  eq(await page.$eval('section[data-class="2026-2027:7A"]', (e) => e.classList.contains('just-done')), false, 'эффект не повторяется при следующих перерисовках');
  // всплывающее уведомление закрывается плавно и исчезает
  await go(page, '#/settings');
  await page.click('text=Удалить DEMO-данные');
  await modal(page).locator('button:has-text("Удалить DEMO")').click();
  await page.waitForSelector('.toast:has-text("DEMO-данные удалены")');
  const closeBtn = page.locator('.toast:not(.out) button[aria-label="Закрыть"]');
  while (await closeBtn.count()) await closeBtn.first().click();
  await page.waitForSelector('.toast.out');
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0, null, { timeout: 2500 });
}, { init: 'window.__LYCEUM_ANIMATE__ = true; window.__LYCEUM_SPLASH_MS__ = 0;' });

await scenario('Тёмная тема: кнопка в шапке и выбор в Настройках, «как в системе», сохранение без мигания, контраст, печать остаётся светлой', async (page) => {
  const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themePref]);
  const bg = (sel) => page.$eval(sel, (e) => getComputedStyle(e).backgroundColor);
  await open(page, '#/');
  assert((await theme()).join() === 'light,auto', 'по умолчанию «как в системе» → светлая');
  eq(await bg('body'), 'rgb(242, 243, 245)', 'светлый фон');
  // кнопка в шапке: как в системе → светлая → тёмная → как в системе
  await page.click('#themeBtn');
  assert((await theme()).join() === 'light,light', 'первое нажатие: светлая');
  await page.click('#themeBtn');
  assert((await theme()).join() === 'dark,dark', 'второе нажатие: тёмная');
  eq(await bg('body'), 'rgb(14, 20, 27)', 'тёмный фон');
  assert((await page.getAttribute('meta[name=theme-color]', 'content')) === '#0c121a', 'цвет адресной строки браузера');
  // сохранение: после перезагрузки тема уже применена в самом начале (до отрисовки страницы)
  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('h1');
  assert((await theme()).join() === 'dark,dark', 'тема сохранилась');
  const early = await page.evaluate(() => performance.getEntriesByType('navigation').length >= 0 && document.documentElement.dataset.theme);
  eq(early, 'dark', 'тёмная с первого кадра');

  // контраст ключевых элементов не ниже 4.5:1 (WCAG AA)
  await loadDemo(page);
  await go(page, '#/history');
  await page.waitForSelector('.stat .label');
  const contrast = (pairs) => page.evaluate((list) => {
    const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(parse(a)), lum(parse(b))]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    return list.map(([sel, bgSel]) => { const e = document.querySelector(sel); const b = document.querySelector(bgSel || sel); return [sel, e && b ? ratio(getComputedStyle(e).color, getComputedStyle(b).backgroundColor) : null]; });
  }, pairs);
  const check = (ratios) => { for (const [sel, r] of ratios) { assert(r !== null, `элемент ${sel} не найден`); assert(r >= 4.5, `контраст ${sel}: ${r.toFixed(2)} < 4.5`); } };
  check(await contrast([['.stat .label', '.stat'], ['#nav a[aria-current=page]'], ['#nav a:not([aria-current])', '.sidebar'], ['.pagehead .sub', 'body'], ['.mini-table td', 'body'], ['.nav-group-label', '.sidebar']]));
  await go(page, '#/new-year');
  await page.waitForSelector('#startYearBtn');
  check(await contrast([['.btn-primary']]));
  // экран обхода: сводка, статусы, подписи — в тёмной теме
  await page.evaluate(async () => {
    const { repo, store } = window.__lyceum;
    const t = new Date(); const iso = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const ids = store.state.students.slice(0, 6).map((x) => x.id);
    await repo.setRounds(ids.slice(0, 2), iso, 'sleeping', { by: 'Проверка' });
    await repo.setRounds(ids.slice(2, 3), iso, 'sick', { by: 'Проверка' });
    await repo.setRounds(ids.slice(3, 4), iso, 'home', { by: 'Проверка' });
    await repo.setRounds(ids.slice(4, 5), iso, 'absent', { by: 'Проверка' });
  });
  await go(page, '#/');
  await page.waitForSelector('section.round-class');
  await page.click('button.round-head[data-class="2026-2027:7A"]');
  check(await contrast([['.round-stats', '.round-sum'], ['.duty-line .k', 'body'], ['.round-clock', 'body'], ['.rc-sick'], ['.rc-home'], ['.rc-sleeping'], ['.rc-absent'], ['.round-when', '.round-body'], ['.rp-sleeping[aria-pressed="true"]'], ['.rp-sick[aria-pressed="true"]'], ['.rp-home[aria-pressed="true"]'], ['.rp-absent[aria-pressed="true"]'], ['.seg button[aria-pressed="true"]'], ['.round-reason', '.round-body']]));
  // печать всегда светлая
  await page.emulateMedia({ media: 'print' });
  eq(await bg('body'), 'rgb(255, 255, 255)', 'печать белая даже в тёмной теме');
  await page.emulateMedia({ media: 'screen' });

  // выбор в Настройках: три варианта, нажатое подсвечено
  await go(page, '#/settings');
  await page.waitForSelector('.theme-opt');
  eq(await page.locator('.theme-opt').count(), 3, 'три варианта темы');
  eq(await page.getAttribute('[data-theme-opt=dark]', 'aria-pressed'), 'true', 'выбрана тёмная');
  await page.click('[data-theme-opt=light]');
  assert((await theme()).join() === 'light,light', 'выбор светлой');
  eq(await page.getAttribute('[data-theme-opt=light]', 'aria-pressed'), 'true', 'подсветка варианта');
  // «как в системе» следует за системой
  await page.click('[data-theme-opt=auto]');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  // графики и обход в тёмной теме открываются без ошибок
  await page.click('[data-theme-opt=dark]');
  await go(page, '#/history');
  await page.waitForSelector('.kpis');
  await go(page, '#/reports');
  await page.waitForSelector('.tabs');
  await go(page, '#/rounds');
  await page.waitForSelector('section.round-class');
  assert((await bg('section.round-class')) !== 'rgb(236, 239, 243)', 'классы обхода перекрашены в тёмной теме');
});

await scenario('Интерфейс: меню по группам с иконками, таблица (выбор, пагинация, массовый перевод), нет emoji, единый набор иконок', async (page) => {
  await loadDemo(page);
  await go(page, '#/');
  // меню: четыре группы, у каждого пункта своя svg-иконка из единого набора
  eq(await page.locator('#nav .nav-group').count(), 4, 'четыре группы меню');
  eq((await page.locator('#nav .nav-group-label').allTextContents()).join('|'), 'Администрирование|Учебный год|Система', 'подписи групп');
  const items = await page.$$eval('#nav a', (as) => as.map((a) => [a.dataset.route, !!a.querySelector('svg.ico'), a.querySelector('.nav-label').textContent]));
  eq(items.map((x) => x[0]).join(','), 'rounds,day,students,classes,staff,logs,access,round-reports,calendar,new-year,history,reports,archive,import,settings', 'порядок разделов');
  assert(items.every((x) => x[1]), 'у каждого пункта есть иконка');
  eq(await page.$$eval('#nav a[aria-current=page]', (e) => e.length), 1, 'активный раздел один');
  // во всём интерфейсе нет emoji и случайных символов-иконок
  for (const h of ['#/', '#/rounds', '#/classes', '#/students', '#/staff', '#/settings', '#/reports', '#/archive']) {
    await go(page, h);
    await page.waitForSelector('h1');
    const bad = await page.evaluate(() => document.body.innerText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}]/gu));
    assert(!bad, `${h}: найдены символы вместо иконок: ${bad}`);
  }
  // таблица учеников: постраничный вывод
  await go(page, '#/students');
  await page.waitForSelector('table.data');
  eq(await page.locator('table.data tbody tr').count(), 50, '50 строк на странице');
  assert((await page.textContent('.pager')).includes('1–50 из 412'), 'счётчик страницы');
  await page.click('button[aria-label="Следующая страница"]');
  assert((await page.textContent('.pager')).includes('51–100 из 412'), 'вторая страница');
  await page.selectOption('.pager select', '100');
  eq(await page.locator('table.data tbody tr').count(), 100, '100 строк на странице');
  await page.selectOption('.pager select', '25');
  // сортировка по классу и поиск сбрасывают страницу
  await page.fill('input[aria-label="Поиск по ФИО"]', 'Демо Ученик 7A-05');
  await page.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length === 1);
  assert(!(await page.locator('.pager').count()), 'при одной строке пагинации нет');
  await page.fill('input[aria-label="Поиск по ФИО"]', '');
  // массовый выбор и перевод
  await page.waitForFunction(() => document.querySelectorAll('table.data tbody tr').length === 25);
  await page.locator('table.data tbody tr').nth(0).locator('input[type=checkbox]').check();
  await page.locator('table.data tbody tr').nth(1).locator('input[type=checkbox]').check();
  assert((await page.textContent('.bulkbar')).includes('Выбрано: 2'), 'панель массовых действий');
  const ids = await page.$$eval('table.data tbody tr.is-selected td:nth-child(2) a', (as) => as.map((a) => a.textContent));
  eq(ids.length, 2, 'две выбранные строки подсвечены');
  await page.click('.bulkbar button[data-bulk=move]');
  await modal(page).locator('select').selectOption('2026-2027:11C');
  await modal(page).locator('button:has-text("Перевести")').last().click();
  await page.waitForSelector('.bulkbar', { state: 'detached' });
  eq(await state(page, `S.enrollments.filter(e => e.classId === '2026-2027:11C' && ${JSON.stringify(ids)}.some((n) => S.students.find((s) => s.id === e.studentId && (s.lastName + ' ' + s.firstName + ' ' + s.middleName).includes(n.split(' ')[0])))).length > 0`), true, 'выбранные переведены в 11C');
  // «выбрать все на странице» и «снять выбор»
  await page.locator('table.data thead input[type=checkbox]').check();
  assert((await page.textContent('.bulkbar')).includes('Выбрано: 25'), 'выбраны все на странице');
  await page.click('.bulkbar button:has-text("Снять выбор")');
  await page.waitForSelector('.bulkbar', { state: 'detached' });
  // классы — таблица с поиском и фильтром по параллели
  await go(page, '#/classes');
  await page.waitForSelector('table.data');
  eq(await page.locator('table.data tbody tr').count(), 15, '15 классов в таблице');
  await page.selectOption('select[aria-label="Параллель"]', '9');
  eq(await page.locator('table.data tbody tr').count(), 3, 'фильтр по параллели');
});

await scenario('Экран загрузки: эмблема БИЛ (птица на книгах и орнамент) играет анимацию, показывает этапы, убирается сам или по нажатию; в автотестах скрыт', async (page, context) => {
  // обычный режим автотестов (без анимации): экрана загрузки нет, эмблема стоит в меню
  await open(page, '');
  eq(await page.evaluate(() => getComputedStyle(document.getElementById('splash') || document.body).display === 'none' || !document.getElementById('splash')), true, 'без анимации экран загрузки скрыт');
  eq(await page.locator('#brandMark svg .lg-bird').count(), 1, 'в меню — знак БИЛ (птица на книгах)');
  // с анимацией: экран виден, эмблема из 10 частей орнамента и птицы
  const p2 = await context.newPage();
  await p2.addInitScript('window.__LYCEUM_ANIMATE__ = true; window.__LYCEUM_ACCESS_ENDPOINT__ = "";');
  await p2.goto(srv.url, { waitUntil: 'commit' });
  await p2.waitForSelector('#splash .lg-bird', { state: 'attached' });
  eq(await p2.locator('#splash .lg-orn').count(), 10, 'десять частей орнамента');
  assert(await p2.evaluate(() => getComputedStyle(document.getElementById('splash')).display !== 'none'), 'экран загрузки виден');
  eq(await p2.evaluate(() => getComputedStyle(document.querySelector('#splash .lg-bird')).fill), 'rgb(20, 26, 60)', 'птица тёмно-синяя (токен --logo-ink)');
  await p2.waitForSelector('h1');
  assert(await p2.locator('#splash').count() === 1, 'экран держится, пока играет анимация');
  // нажатие пропускает ожидание
  await p2.mouse.click(300, 300);
  await p2.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 3000 });
  // без нажатия экран уходит сам, не позже ~3 с
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.addInitScript('window.__LYCEUM_ANIMATE__ = true; window.__LYCEUM_ACCESS_ENDPOINT__ = "";');
  const t0 = Date.now();
  await p3.goto(srv.url);
  await p3.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5000 });
  const took = Date.now() - t0;
  assert(took >= 1500 && took < 4000, `экран показан около 2 с (было ${took} мс)`);
  // повторное открытие в тот же день — короткий экран
  const t1 = Date.now();
  await p3.goto(srv.url + '?again');
  await p3.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5000 });
  assert(Date.now() - t1 < 1500, `в тот же день экран короткий (было ${Date.now() - t1} мс)`);
  await ctx3.close();
});

await scenario('Аудит интерфейса: шапка и подвал выровнены, показатели в одну строку, счётчики меню, иконки действий, фильтры в строке поиска', async (page) => {
  await loadDemo(page);
  await go(page, '#/');
  await page.waitForSelector('.round-sum');
  const box = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) }; }, sel);
  // подвал начинается там же, где и содержимое страницы
  const main = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft) + document.querySelector('main').getBoundingClientRect().left);
  const foot = await page.evaluate(() => document.querySelector('.site-foot span').getBoundingClientRect().left);
  assert(Math.abs(main - foot) <= 1, `подвал выровнен по содержимому (${main} / ${foot})`);
  // граница шапки совпадает с границей блока названия в меню
  eq((await box('.brand')).b, (await box('.topbar')).b, 'линии под логотипом и шапкой на одной высоте');
  // элементы шапки одной высоты
  const hs = await page.evaluate(() => ['#globalSearch', '#syncStatus', '#themeBtn'].map((q) => Math.round(document.querySelector(q).getBoundingClientRect().height)));
  assert(Math.max(...hs) - Math.min(...hs) <= 2, `поиск, статус базы и тема одной высоты: ${hs}`);
  // меню: «Система» прижата к низу, у классов, учеников и персонала — счётчики
  const nums = await page.$$eval('#nav .nav-n', (e) => e.map((n) => n.textContent));
  eq(nums.join(','), `${await state(page, 'S.students.filter(x => x.status === "active").length')},15,${await state(page, 'S.staff.filter(x => !x.archived).length')}`, 'счётчики в меню');
  const last = await box('.nav-group-end');
  const sb = await box('.sidebar-foot');
  assert(sb.y - last.b <= 12, 'группа «Система» стоит над подвалом меню');
  // сводка обхода — одна полоса, а не россыпь карточек
  eq(await page.locator('.round-sum').count(), 1, 'сводка обхода — одна полоса');
  assert((await box('.round-sum')).h < 120, 'сводка компактная');
  // таблицы: заголовки без КАПСА, действия в строке — иконки, ссылки без подчёркивания
  await go(page, '#/students');
  await page.waitForSelector('table.data');
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('table.data thead th')).textTransform), 'none', 'заголовки таблицы без капса');
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('table.data td.actions .btn > span')).display), 'none', 'подписи действий спрятаны (остались в подсказке)');
  assert(await page.evaluate(() => !!document.querySelector('table.data td.actions .btn[title="Изменить"]')), 'у кнопки-иконки есть подсказка');
  eq(await page.evaluate(() => getComputedStyle(document.querySelector('table.data td a')).textDecorationLine), 'none', 'ссылки в таблице без подчёркивания');
  // фильтры стоят в одной строке с поиском
  const s1 = await box('.table-tools .search-box');
  const f1 = await box('.table-tools .filters-box');
  assert(Math.abs(s1.y - f1.y) <= 8, 'поиск и фильтры в одной строке');
  // подписи фильтров остаются для скринридеров
  eq(await page.locator('.filters-box label:has-text("Параллель")').count(), 1, 'подпись фильтра есть в разметке');
  // строки таблицы плотные
  assert((await box('table.data tbody tr')).h <= 42, 'строка таблицы не выше 42px');
});

await scenario('Все страницы на четырёх размерах экрана: без горизонтальной прокрутки и ошибок в консоли', async (page) => {
  await loadDemo(page);
  const hashes = ['#/', '#/rounds', '#/admin', '#/admin/logs', '#/admin/reports', '#/admin/calendar', '#/classes', classHash('7A'), '#/students', '#/staff', '#/new-year', '#/history', '#/reports', '#/archive', '#/import', '#/access', '#/settings', '#/search?q=7A'];
  for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024], [375, 812]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const hash of hashes) {
      await go(page, hash);
      await page.waitForSelector('h1');
      await page.waitForTimeout(80);
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      assert(o.sw <= o.iw + 1, `${w}×${h} ${hash}: горизонтальная прокрутка ${o.sw} > ${o.iw}`);
    }
  }
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
  await page.waitForSelector('.status-line:has-text("Соединение установлено")');
  await page.click('#syncNowBtn');
  await page.waitForSelector('.status-line:has-text("Синхронизировано")');
  eq(posts.length, 1, 'один POST');
  const p = posts[0];
  eq(p.type, 'lyceum-sync', 'тип');
  eq(p.token, 'секретный-токен', 'токен');
  eq(Object.keys(p.sheets).join(','), 'Ученики,Классы,Учителя,Воспитатели,Отчёт,Архив,История,Вечерний обход', 'листы');
  eq(p.sheets['Ученики'].rows.length, await state(page, 'S.students.length'), 'строк учеников');
  eq(p.sheets['Классы'].rows.length, 15, 'строк классов');
  assert(JSON.parse(p.backup).format === 'lyceum-registry' && !p.backup.includes('секретный-токен'), 'резервная копия без токена');
  eq((await page.textContent('#syncStatus')).trim(), 'Google: синхронизировано', 'статус в шапке');
  eq(await state(page, 'S.settings.dirtySinceSync'), false, 'флаг изменений сброшен');
  // ошибка сервера
  mode = 'fail';
  await page.click('#syncNowBtn');
  await page.waitForSelector('.status-line:has-text("Ошибка синхронизации")');
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
    if (vp.width >= 768 && vp.width < 1024) {
      // планшет: узкая колонка иконок вместо выезжающего меню
      assert(await page.locator('#sidebar').isVisible(), 'на планшете меню видно как колонка иконок');
      const sbw = await page.$eval('#sidebar', (e) => Math.round(e.getBoundingClientRect().width));
      assert(sbw < 80, `колонка узкая (${sbw}px)`);
      assert(!(await page.locator('#nav .nav-label').first().isVisible()), 'подписи скрыты, остались иконки');
      // кнопка «Меню» раскрывает колонку поверх страницы с подписями; страница при этом не сдвигается
      assert(await page.locator('#menuBtn').isVisible(), 'на планшете есть кнопка «Меню»');
      const mainX = await page.$eval('main', (e) => Math.round(e.getBoundingClientRect().left));
      await page.click('#menuBtn');
      await page.waitForTimeout(250);
      assert(await page.locator('#nav .nav-label').first().isVisible(), 'после нажатия видны подписи пунктов');
      eq(await page.$eval('main', (e) => Math.round(e.getBoundingClientRect().left)), mainX, 'содержимое не сдвинулось');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      assert(!(await page.locator('#nav .nav-label').first().isVisible()), 'Esc сворачивает колонку обратно');
      await page.click('#nav a[data-route=students]');
      await page.waitForSelector('h1:has-text("Ученики")');
    } else if (vp.width < 768) {
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
  eq((await page.textContent('#brandName')).trim(), 'Костанай БИЛ', 'название системы в шапке меню неизменно');
  eq((await page.textContent('#brandSub')).trim(), 'Лицей №1 (тест)', 'название лицея под названием системы');
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
