// Точка входа: открытие базы, первый запуск, маршрутизация, общий каркас страницы.
import { openDb } from './core/db.js';
import { createStore } from './core/store.js';
import { createRouter } from './core/router.js';
import { createRepo } from './services/repo.js';
import { startAutoSync, syncNow, describeSync } from './services/sync.js';
import { createLive, describeLive } from './services/live.js';
import { saveBackupFile } from './services/backup-file.js';
import { h, $, $$ } from './ui/dom.js';
import { toast, toastError } from './ui/toast.js';
import { yearLabel } from './domain/years.js';
import * as classes from './pages/classes.js';
import * as classDetail from './pages/class-detail.js';
import * as students from './pages/students.js';
import * as staff from './pages/staff.js';
import * as newYear from './pages/new-year.js';
import * as history from './pages/history.js';
import * as reports from './pages/reports.js';
import * as archive from './pages/archive.js';
import * as importExport from './pages/import-export.js';
import * as settings from './pages/settings.js';
import * as search from './pages/search.js';
import * as accessPage from './pages/access.js';
import * as rounds from './pages/rounds.js';
import * as day from './pages/day.js';
import * as logs from './pages/logs.js';
import * as calendar from './pages/calendar.js';
import * as roundReports from './pages/round-reports.js';
import { accessEndpoint } from './config.js';
import { runGate, watchAccess, knownRole, forgetRole } from './ui/gate.js';
import { listRequests, verifyOwner, accessStatus } from './services/access.js';
import { enterPage, countUp } from './ui/anim.js';
import { THEMES, getPref, cyclePref, onThemeChange } from './ui/theme.js';
import { icon } from './ui/icons.js';
import { createSplash } from './ui/splash.js';
import { logoMark } from './ui/logo.js';
import { yearView } from './domain/stats.js';

// Автотесты (WebDriver) работают без анимации: так проверки не зависят от движения элементов. Включить — window.__LYCEUM_ANIMATE__ = true.
if (navigator.webdriver && window.__LYCEUM_ANIMATE__ !== true) document.documentElement.classList.add('no-anim');

// Четвёртый элемент — раздел только для администратора: дежурный (USER) его не откроет, страница даже не строится.
const ROUTES = [
  ['rounds', '/', rounds],
  ['rounds', '/rounds', rounds],
  ['day', '/admin', day, true],
  ['logs', '/admin/logs', logs, true],
  ['round-reports', '/admin/reports', roundReports, true],
  ['calendar', '/admin/calendar', calendar, true],
  ['classes', '/classes', classes, true],
  ['classes', '/class/:id', classDetail, true],
  ['students', '/students', students, true],
  ['staff', '/staff', staff, true],
  ['new-year', '/new-year', newYear, true],
  ['history', '/history', history, true],
  ['history', '/history/:yearId', history, true],
  ['reports', '/reports', reports, true],
  ['archive', '/archive', archive, true],
  ['import', '/import', importExport, true],
  ['settings', '/settings', settings, true],
  ['search', '/search', search, true],
  ['access', '/access', accessPage, true],
].map(([name, path, mod, admin]) => ({ name, path, render: mod.render, title: mod.title, admin: !!admin }));

// Меню. Пункт с признаком admin виден только администратору (и закрыт на самом маршруте); дежурному остаётся «Обход».
const NAV = [
  { items: [['rounds', '/', 'Обход', 'moon']] },
  { label: 'Администрирование', admin: true, items: [['day', '/admin', 'Обзор дня', 'eye'], ['students', '/students', 'Ученики', 'users'], ['classes', '/classes', 'Классы', 'layers'], ['staff', '/staff', 'Персонал', 'badge'], ['logs', '/admin/logs', 'Журнал', 'file'], ['access', '/access', 'Запросы доступа', 'shield'], ['round-reports', '/admin/reports', 'Отчёты обхода', 'chart'], ['calendar', '/admin/calendar', 'Календарь', 'calendar']] },
  { label: 'Учебный год', admin: true, items: [['new-year', '/new-year', 'Новый учебный год', 'calendar-next'], ['history', '/history', 'История', 'history'], ['reports', '/reports', 'Отчёты года', 'chart'], ['archive', '/archive', 'Архив', 'archive']] },
  { label: 'Система', admin: true, items: [['import', '/import', 'Импорт и экспорт', 'swap'], ['settings', '/settings', 'Настройки', 'sliders']] },
];

// Разделы, у которых в меню справа показано число записей (как в привычных рабочих программах).
const COUNTED = new Set(['classes', 'students', 'staff']);

function buildNav(nav, isAdmin) {
  const groups = NAV.filter((g) => isAdmin || !g.admin);
  nav.replaceChildren(...groups.map((g, gi) => h('div', { class: `nav-group${gi === groups.length - 1 ? ' nav-group-end' : ''}`, role: 'group', 'aria-label': g.label || 'Основные разделы' },
    g.label ? h('div', { class: 'nav-group-label', 'aria-hidden': 'true' }, g.label) : null,
    g.items.map(([route, path, label, ic]) => h('a', { href: `#${path}`, 'data-route': route, title: label }, icon(ic, 18), h('span', { class: 'nav-label' }, label), COUNTED.has(route) ? h('span', { class: 'nav-n', 'data-n': route }) : null, route === 'access' ? h('span', { class: 'nav-count', 'aria-label': 'Новых запросов' }) : null)))));
}

const DAY = 24 * 3600 * 1000;

// Дежурному резервные копии в браузере не нужны (а данные могли остаться от прежней роли): удаляем.
async function removeLocalBackups(db) {
  try { for (const b of await db.listBackups()) await db.deleteBackup(b.id); } catch { /* не критично */ }
}

async function main() {
  const splash = createSplash();
  // Защита от кликджекинга: страница не работает внутри чужого <iframe> (заголовок frame-ancestors на GitHub Pages задать нельзя).
  if (window.top !== window.self) {
    document.getElementById('splash')?.remove();
    document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Сайт нельзя открывать внутри другой страницы. Откройте его напрямую.' }));
    return;
  }
  const view = $('#view');
  let versionBanner = false;
  splash.status('Открываем хранилище…');
  const db = await openDb({ onVersionChange: () => { versionBanner = true; updateChrome(); } });
  const store = createStore(db);
  splash.status('Читаем данные…');
  await store.load();
  const repo = createRepo(store);
  await repo.initialize();
  store.listenOtherTabs();

  // Допуск: если в js/config.js указан адрес скрипта, без решения администратора сайт не открывается.
  // Роль определяет сервер (admin | user); значок роли на устройстве нужен только для быстрого открытия, права он не даёт.
  const endpoint = accessEndpoint();
  const access = { endpoint, role: 'admin', admin: true, owner: true, isOwner: !endpoint, pending: 0, onPending: null };
  let live = null;
  if (endpoint) {
    // Устройство уже допущено и данные на нём есть: открываем сразу, доступ проверяем в фоне (иначе каждое открытие ждёт скрипт Google 4–30 с).
    const known = knownRole();
    const token = store.state.settings.sheetsToken;
    const quick = known && store.state.settings.liveRev != null;
    let role;
    if (quick) {
      role = known;
      (async () => {
        try {
          if (token) await verifyOwner(endpoint, token);
          else {
            const st = await accessStatus(endpoint);
            if (st.status !== 'allowed' || (st.role || 'user') !== known) throw Object.assign(new Error('closed'), { code: 'auth' });
          }
        } catch (e) {
          if (e.code === 'auth') { forgetRole(); location.reload(); } // доступ закрыт или роль изменена — экран допуска разберётся заново
        } // нет связи — работаем с тем, что на устройстве
      })();
    } else ({ role } = await runGate({ endpoint, store, repo, db, view, onShown: () => splash.hide() }));
    access.role = role;
    access.admin = role === 'admin';
    access.owner = access.admin;
    access.isOwner = access.admin && !!store.state.settings.sheetsToken;
    if (!access.isOwner) watchAccess(endpoint);
    view.replaceChildren();
    // Общая база: все допущенные устройства работают с одними данными (см. services/live.js).
    live = createLive({
      store,
      endpoint,
      role,
      canSheets: access.admin,
      onForbidden: () => location.reload(), // доступ закрыт — экран допуска сотрёт локальные данные
      onRole: () => { forgetRole(); location.reload(); }, // сервер назвал другую роль: перезагрузка соберёт экран заново
      onConflict: () => toast('Часть ваших изменений не применена: те же данные (например, учебный год) успел изменить другой пользователь. Экран обновлён.', 'error'),
    });
    splash.status('Подключаем общую базу…');
    const firstJoin = store.state.settings.liveRev == null;
    if (firstJoin) view.replaceChildren(h('p', { class: 'loading' }, 'Загрузка общих данных…'));
    await live.start({ wait: firstJoin });
    view.replaceChildren();
    if (!access.admin) await removeLocalBackups(db);
  }

  // Своё имя (для подписи отметок и вопроса «изменить чужую отметку?»): помним на устройстве, уточняем у сервера.
  const NAME_KEY = 'lyceum-name';
  try { access.name = access.isOwner ? 'Владелец' : localStorage.getItem(NAME_KEY) || ''; } catch { access.name = access.isOwner ? 'Владелец' : ''; }
  if (endpoint && !access.isOwner) {
    accessStatus(endpoint).then((st) => { if (st.name) { access.name = st.name; try { localStorage.setItem(NAME_KEY, st.name); } catch { /* ignore */ } } }).catch(() => {});
  }

  if (access.admin) document.body.dataset.admin = '1';
  if (access.isOwner) document.body.dataset.owner = '1';
  document.body.dataset.role = access.role;

  buildNav($('#nav'), access.admin);
  $('#brandMark').appendChild(logoMark(30));
  $('#menuBtn').appendChild(icon('menu', 18));
  $('#searchForm').prepend(icon('search', 16));
  if (!access.admin) $('#searchForm').hidden = true; // поиск ведёт по всем ученикам и персоналу — только администратору

  const router = createRouter({
    view,
    routes: ROUTES,
    canEnter: (r) => !r.admin || access.admin,
    makeContext: ({ view: v, params, query, route }) => ({ view: v, params, query, route, store, repo, router, access, get live() { return live; }, get state() { return store.state; }, refresh: () => router.refresh() }),
    onChange: (route) => {
      $$('#nav a').forEach((a) => (a.dataset.route === route.name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
      const r = ROUTES.find((x) => x.name === route.name);
      document.title = `${(r && r.title) || 'Костанай БИЛ'} — Костанай БИЛ`;
      closeNav();
      if (!route.refreshed) { enterPage(view); countUp(view); }
      if (!route.refreshed) window.scrollTo(0, 0); // при обновлении той же страницы (чужая правка, своя отметка) прокрутка остаётся на месте
      const inSearch = route.name === 'search';
      if (!inSearch && document.activeElement !== searchInput) searchInput.value = '';
    },
  });

  // ---------- каркас ----------
  const searchInput = $('#globalSearch');
  const nav = $('#nav');
  void nav;
  function openNav() {
    document.body.classList.add('nav-open');
    $('#backdrop').hidden = false;
    $('#menuBtn').setAttribute('aria-expanded', 'true');
  }
  function closeNav() {
    document.body.classList.remove('nav-open');
    $('#backdrop').hidden = true;
    $('#menuBtn').setAttribute('aria-expanded', 'false');
  }
  $('#menuBtn').addEventListener('click', () => (document.body.classList.contains('nav-open') ? closeNav() : openNav()));
  $('#backdrop').addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeNav());

  let searchTimer = null;
  const goSearch = () => {
    const q = searchInput.value.trim();
    clearTimeout(searchTimer);
    const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/';
    if (router.current?.name === 'search') router.go(target, { replace: true });
    else if (q) location.hash = target;
  };
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(goSearch, 200); });
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); goSearch(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && access.admin && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !document.querySelector('dialog[open]')) { e.preventDefault(); searchInput.focus(); }
  });

  // Тема: кнопка в шапке по кругу переключает «как в системе» → светлая → тёмная; выбор — также в Настройках.
  const themeBtn = $('#themeBtn');
  const paintTheme = () => {
    const t = THEMES.find((x) => x.key === getPref());
    themeBtn.replaceChildren(icon(t.icon, 16));
    themeBtn.title = `Тема: ${t.label}. Нажмите, чтобы сменить`;
    themeBtn.setAttribute('aria-label', `Тема оформления: ${t.label}. Нажмите, чтобы сменить`);
  };
  themeBtn.addEventListener('click', cyclePref);
  paintTheme();
  onThemeChange(() => {
    paintTheme();
    if (['day', 'round-reports', 'reports', 'history'].includes(router.current?.name)) router.refresh(); // графики берут цвета из темы
  });

  const syncBtn = $('#syncStatus');
  syncBtn.addEventListener('click', async () => {
    const st = store.state.settings;
    if (!st.sheetsUrl) { location.hash = '#/settings'; return; }
    syncBtn.disabled = true;
    if (live) await live.tick(); // отправить своё и забрать чужое прямо сейчас
    const r = live && !access.isOwner ? { ok: live.status.state === 'online', error: live.status.error } : await syncNow(store, repo, { reason: 'manual' }); // владелец ещё и обновляет читаемые листы таблицы; пустую базу сразу не отправляет — защита таблицы
    syncBtn.disabled = false;
    toast(r.ok ? (live ? 'Общая база актуальна' : 'Данные отправлены в Google Таблицы') : r.error, r.ok ? 'success' : 'error');
  });

  function updateChrome() {
    const s = store.state.settings;
    $('#brandSub').textContent = s.lyceumName && s.lyceumName !== 'Лицей' ? s.lyceumName : 'Система учёта лицея';
    $('#yearBadge').replaceChildren(icon('calendar', 15), h('span', { class: 'yb-label' }, 'Учебный год'), h('strong', null, yearLabel(s.currentYearId)));
    const d = live ? describeLive(live.status) : describeSync(s);
    syncBtn.dataset.kind = d.kind;
    const syncText = live ? d.text.replace(/^Общая база: /, 'База: ') : d.kind === 'off' ? 'Google не подключён' : d.kind === 'ok' ? 'Google: синхронизировано' : d.kind === 'error' ? 'Google: ошибка' : 'Google: ждёт отправки';
    syncBtn.replaceChildren(h('span', { class: 'dot' }), h('span', null, syncText));
    syncBtn.title = live ? `${d.text}${live.status.lastOkAt ? `. Последнее обновление: ${new Date(live.status.lastOkAt).toLocaleTimeString('ru-RU')}` : ''}` : d.text;
    $('#storageNote').textContent = db.kind === 'indexeddb' ? 'Данные хранятся в этом браузере' : 'Хранение отключено!';
    $('#storageFoot').toggleAttribute('data-bad', db.kind !== 'indexeddb');
    const v = yearView(store.state, s.currentYearId);
    const counts = { classes: v.classCount, students: v.total, staff: store.state.staff.filter((x) => !x.archived).length };
    for (const n of $$('#nav .nav-n')) n.textContent = String(counts[n.dataset.n] ?? '');

    const banners = [];
    if (db.kind !== 'indexeddb') banners.push(h('div', { class: 'banner danger', role: 'alert' }, h('div', null, h('strong', null, 'Данные не сохраняются. '), `Хранилище браузера (IndexedDB) недоступно${db.fallbackReason ? ` (${db.fallbackReason})` : ''}. Возможно, включён приватный режим. Всё, что вы введёте, пропадёт после закрытия вкладки — экспортируйте данные в JSON.`)));
    if (versionBanner) banners.push(h('div', { class: 'banner warn' }, h('div', null, 'Сайт обновился в другой вкладке. Перезагрузите страницу.'), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => location.reload() }, 'Перезагрузить')));
    const exp = s.lastExportAt ? new Date(s.lastExportAt).getTime() : 0;
    if (access.admin && store.state.students.length && Date.now() - exp > 14 * DAY && !['settings', 'rounds'].includes(router.current?.name)) { // на обходе напоминание отвлекает от отметок
      banners.push(h('div', { class: 'banner info' }, h('div', null, s.lastExportAt ? 'Резервная копия в файл не скачивалась больше 14 дней.' : 'Вы ещё не сохраняли резервную копию в файл. Данные хранятся только в этом браузере.'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { try { await saveBackupFile(repo); toast('Резервная копия сохранена'); } catch (e) { toastError(e); } } }, 'Скачать копию')));
    }
    $('#banner').replaceChildren(...banners);
  }

  // Изменения, пришедшие от других людей, обновляют экран, но не мешают тому, кто сейчас вводит данные:
  // пока открыто окно или курсор стоит в поле формы, обновление откладывается.
  let refreshTimer = null;
  const typing = () => !!document.querySelector('dialog[open]') || (view.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
  const refreshWhenIdle = () => {
    clearTimeout(refreshTimer);
    if (typing()) refreshTimer = setTimeout(refreshWhenIdle, 1500);
    else router.refresh();
  };
  store.on((detail) => {
    updateChrome();
    if (detail.reason === 'remote') refreshWhenIdle();
    else if (!detail.system) router.refresh();
  });
  if (live) live.subscribe(updateChrome);
  updateChrome();

  // Постоянное хранение запрашиваем по первому действию пользователя.
  document.addEventListener('pointerdown', () => { try { navigator.storage?.persist?.(); } catch { /* ignore */ } }, { once: true });

  // Владельцу: число ожидающих запросов рядом с пунктом «Доступ».
  if (endpoint && access.admin) {
    const link = $('#nav a[data-route=access]');
    const paint = (n) => { const c = link.querySelector('.nav-count'); c.textContent = n ? String(n) : ''; link.title = n ? `Доступ: новых запросов — ${n}` : 'Доступ'; };
    access.onPending = paint;
    const refresh = async () => {
      try { const { requests } = await listRequests(endpoint, store.state.settings.sheetsToken || ''); access.pending = requests.filter((r) => r.status === 'pending').length; paint(access.pending); } catch { /* нет связи */ }
    };
    refresh();
    setInterval(refresh, 60000);
  }

  window.__lyceum = { store, repo, router };
  splash.status('Готовим страницы…');
  await router.start();
  updateChrome();
  splash.hide();
  if (!live) startAutoSync(store, repo); // с общей базой отдельная выгрузка не нужна: сервер сам хранит актуальную версию
}

main().catch((e) => {
  console.error(e);
  document.getElementById('splash')?.remove(); // сообщение об ошибке не должно прятаться под экраном загрузки
  const view = document.getElementById('view');
  if (view) {
    const box = document.createElement('div');
    box.className = 'notice danger';
    box.textContent = `Не удалось запустить приложение: ${e.message}`;
    view.replaceChildren(box);
  }
});
