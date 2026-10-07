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
import * as dashboard from './pages/dashboard.js';
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
import { accessEndpoint } from './config.js';
import { runGate, watchAccess } from './ui/gate.js';
import { listRequests } from './services/access.js';

const ROUTES = [
  ['dashboard', '/', dashboard],
  ['rounds', '/rounds', rounds],
  ['classes', '/classes', classes],
  ['classes', '/class/:id', classDetail],
  ['students', '/students', students],
  ['staff', '/staff', staff],
  ['new-year', '/new-year', newYear],
  ['history', '/history', history],
  ['history', '/history/:yearId', history],
  ['reports', '/reports', reports],
  ['archive', '/archive', archive],
  ['import', '/import', importExport],
  ['settings', '/settings', settings],
  ['search', '/search', search],
  ['access', '/access', accessPage],
].map(([name, path, mod]) => ({ name, path, render: mod.render, title: mod.title }));

const DAY = 24 * 3600 * 1000;

async function main() {
  // Защита от кликджекинга: страница не работает внутри чужого <iframe> (заголовок frame-ancestors на GitHub Pages задать нельзя).
  if (window.top !== window.self) {
    document.body.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Сайт нельзя открывать внутри другой страницы. Откройте его напрямую.' }));
    return;
  }
  const view = $('#view');
  let versionBanner = false;
  const db = await openDb({ onVersionChange: () => { versionBanner = true; updateChrome(); } });
  const store = createStore(db);
  await store.load();
  const repo = createRepo(store);
  await repo.initialize();
  store.listenOtherTabs();

  // Допуск посетителей: если в js/config.js указан адрес скрипта, без решения владельца сайт не открывается.
  const endpoint = accessEndpoint();
  const access = { endpoint, owner: !endpoint, pending: 0, onPending: null };
  let live = null;
  if (endpoint) {
    const { role } = await runGate({ endpoint, store, repo, db, view });
    access.owner = role === 'owner';
    if (access.owner) document.body.dataset.owner = '1';
    else watchAccess(endpoint);
    view.replaceChildren();
    // Общая база: все допущенные устройства работают с одними данными (см. services/live.js).
    live = createLive({
      store,
      endpoint,
      onForbidden: () => location.reload(), // доступ закрыт — экран допуска сотрёт локальные данные
      onConflict: () => toast('Часть ваших изменений не применена: те же данные (например, учебный год) успел изменить другой пользователь. Экран обновлён.', 'error'),
    });
    const firstJoin = store.state.settings.liveRev == null;
    if (firstJoin) view.replaceChildren(h('p', { class: 'loading' }, 'Загрузка общих данных…'));
    await live.start({ wait: firstJoin });
    view.replaceChildren();
  }

  if (access.owner) document.body.dataset.owner = '1'; // без допуска (локальный режим) пользователь — сам себе владелец

  const router = createRouter({
    view,
    routes: ROUTES,
    makeContext: ({ view: v, params, query, route }) => ({ view: v, params, query, route, store, repo, router, access, get state() { return store.state; }, refresh: () => router.refresh() }),
    onChange: (route) => {
      $$('#nav a').forEach((a) => (a.dataset.route === route.name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
      const r = ROUTES.find((x) => x.name === route.name);
      document.title = `${(r && r.title) || 'Учёт лицея'} — ${store.state.settings.lyceumName}`;
      closeNav();
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
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !document.querySelector('dialog[open]')) { e.preventDefault(); searchInput.focus(); }
  });

  const syncBtn = $('#syncStatus');
  syncBtn.addEventListener('click', async () => {
    const st = store.state.settings;
    if (!st.sheetsUrl) { location.hash = '#/settings'; return; }
    syncBtn.disabled = true;
    if (live) await live.tick(); // отправить своё и забрать чужое прямо сейчас
    const r = live && !access.owner ? { ok: live.status.state === 'online', error: live.status.error } : await syncNow(store, repo, { reason: 'manual' }); // владелец ещё и обновляет читаемые листы таблицы; пустую базу сразу не отправляет — защита таблицы
    syncBtn.disabled = false;
    toast(r.ok ? (live ? 'Общая база актуальна' : 'Данные отправлены в Google Таблицы') : r.error, r.ok ? 'success' : 'error');
  });

  function updateChrome() {
    const s = store.state.settings;
    $('#brandName').textContent = s.lyceumName;
    $('#yearBadge').replaceChildren('Учебный год ', h('strong', null, yearLabel(s.currentYearId)));
    const d = live ? describeLive(live.status) : describeSync(s);
    syncBtn.dataset.kind = d.kind;
    syncBtn.textContent = live ? d.text : d.kind === 'off' ? 'Google: не подключено' : d.kind === 'ok' ? 'Google: синхронизировано' : d.kind === 'error' ? 'Google: ошибка' : 'Google: ждёт отправки';
    syncBtn.title = live ? `${d.text}${live.status.lastOkAt ? `. Последнее обновление: ${new Date(live.status.lastOkAt).toLocaleTimeString('ru-RU')}` : ''}` : d.text;
    $('#storageNote').textContent = db.kind === 'indexeddb' ? 'Данные хранятся в этом браузере' : 'Хранение отключено!';

    const banners = [];
    if (db.kind !== 'indexeddb') banners.push(h('div', { class: 'banner danger', role: 'alert' }, h('div', null, h('strong', null, 'Данные не сохраняются. '), `Хранилище браузера (IndexedDB) недоступно${db.fallbackReason ? ` (${db.fallbackReason})` : ''}. Возможно, включён приватный режим. Всё, что вы введёте, пропадёт после закрытия вкладки — экспортируйте данные в JSON.`)));
    if (versionBanner) banners.push(h('div', { class: 'banner warn' }, h('div', null, 'Сайт обновился в другой вкладке. Перезагрузите страницу.'), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => location.reload() }, 'Перезагрузить')));
    const exp = s.lastExportAt ? new Date(s.lastExportAt).getTime() : 0;
    if (store.state.students.length && Date.now() - exp > 14 * DAY && router.current?.name !== 'settings') {
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
  if (endpoint && access.owner) {
    const link = $('#nav a[data-route=access]');
    const paint = (n) => { link.textContent = n ? `Доступ (${n})` : 'Доступ'; };
    access.onPending = paint;
    const refresh = async () => {
      try { const { requests } = await listRequests(endpoint, store.state.settings.sheetsToken); access.pending = requests.filter((r) => r.status === 'pending').length; paint(access.pending); } catch { /* нет связи */ }
    };
    refresh();
    setInterval(refresh, 60000);
  }

  window.__lyceum = { store, repo, router };
  await router.start();
  updateChrome();
  if (!live) startAutoSync(store, repo); // с общей базой отдельная выгрузка не нужна: сервер сам хранит актуальную версию
}

main().catch((e) => {
  console.error(e);
  const view = document.getElementById('view');
  if (view) {
    const box = document.createElement('div');
    box.className = 'notice danger';
    box.textContent = `Не удалось запустить приложение: ${e.message}`;
    view.replaceChildren(box);
  }
});
