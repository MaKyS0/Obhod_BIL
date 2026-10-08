// Настройки: одна страница с разделами (Общие · Доступ · Данные · Учебный процесс · Система) и навигацией слева.
import { filePicker } from '../ui/file-picker.js';
import { h } from '../ui/dom.js';
import { pageHead, btn, link, badge, notice } from '../ui/common.js';
import { icon } from '../ui/icons.js';
import { field, checkbox } from '../ui/form.js';
import { confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { downloadJson, readFileBytes } from '../services/download.js';
import { saveBackupFile } from '../services/backup-file.js';
import { syncNow, checkConnection, describeSync, isEmptyDb } from '../services/sync.js';
import { loadDemo } from '../services/demo.js';
import { listRequests } from '../services/access.js';
import { decodeBytes } from '../domain/csv.js';
import { validateBackup } from '../domain/backup.js';
import { recentChanges } from '../domain/activity.js';
import { formatDateTime } from '../domain/dates.js';
import { yearLabel } from '../domain/years.js';
import { nStudents } from '../domain/plural.js';
import { THEMES, getPref, setPref } from '../ui/theme.js';

export const title = 'Настройки';

const REASONS = { manual: 'вручную', 'before-promotion': 'перед переходом на новый год', 'before-undo': 'перед отменой перехода', 'before-import': 'перед импортом', 'before-restore': 'перед восстановлением', 'before-clear': 'перед очисткой/удалением', 'before-live': 'перед подключением к общей базе' };

const SECTIONS = [
  ['general', 'Общие', 'sliders'],
  ['access', 'Доступ', 'shield'],
  ['data', 'Данные', 'database'],
  ['process', 'Учебный процесс', 'calendar-next'],
  ['system', 'Система', 'code'],
];

// Строка настройки: слева название и пояснение, справа элементы управления.
const row = (label, hint, ...controls) => h('div', { class: 'setting-row' }, h('div', { class: 'sr-label' }, h('strong', null, label), hint ? h('span', null, hint) : null), h('div', { class: 'sr-control' }, controls));
const group = (id, label, note, ...rows) => h('section', { class: 'setting-group', id: `s-${id}`, 'data-section': id, 'aria-labelledby': `s-${id}-h` }, h('h2', { id: `s-${id}-h` }, label), note ? h('p', { class: 'section-note' }, note) : null, rows);

export async function render(ctx) {
  const { state: s, repo, store, view: el, query, access } = ctx;
  const st = s.settings;
  el.append(pageHead({ title: 'Настройки', sub: 'Параметры системы «Костанай БИЛ»: данные, доступ, синхронизация, резервные копии' }));

  const groups = [];

  // ================= Общие =================
  const name = field({ label: 'Название лицея', name: 'name', value: st.lyceumName, required: true });
  const onlyYear = s.years.length <= 1 && !s.promotions.length;
  const year = field({ label: 'Текущий учебный год', name: 'year', value: yearLabel(st.currentYearId), hint: onlyYear ? 'Формат 2026–2027. Можно менять, пока не выполнялся первый переход.' : 'Изменяется только через «Новый учебный год».', attrs: { disabled: !onlyYear } });
  name.el.classList.add('one');
  year.el.classList.add('one');
  const picker = h('div', { class: 'theme-picker', role: 'group', 'aria-label': 'Тема оформления' });
  const paintPicker = () => picker.replaceChildren(...THEMES.map((t) => h('button', { type: 'button', class: 'theme-opt', 'aria-pressed': getPref() === t.key ? 'true' : 'false', 'data-theme-opt': t.key, onclick: () => { setPref(t.key); paintPicker(); } }, icon(t.icon, 15), t.label)));
  paintPicker();
  groups.push(group('general', 'Общие', null,
    row('Название лицея', 'Показывается в шапке меню, отчётах и при печати.', name.el),
    row('Учебный год', 'Текущий год работы системы.', year.el,
      h('div', { class: 'row' }, btn('Сохранить', async () => {
        try {
          await repo.updateSettings({ lyceumName: name.get() });
          if (onlyYear && year.get().trim() !== yearLabel(st.currentYearId)) await repo.setCurrentYear(year.get());
          toast('Настройки сохранены');
        } catch (e) { toastError(e); }
      }, 'primary'))),
    row('Оформление', 'Хранится в этом браузере. «Как в системе» следует настройке устройства.', picker)));

  // ================= Доступ =================
  const devices = h('div', { class: 'muted' }, access.endpoint ? (access.owner ? 'Загрузка…' : 'Список видит только владелец.') : 'Допуск выключен.');
  if (access.endpoint && access.owner) {
    listRequests(access.endpoint, st.sheetsToken).then(({ requests }) => {
      const allowed = requests.filter((r) => r.status === 'allowed');
      devices.className = '';
      devices.replaceChildren(allowed.length
        ? h('ul', { class: 'backup-list' }, allowed.map((r) => h('li', null, h('div', { class: 'grow' }, h('strong', null, r.name), h('div', { class: 'muted' }, `допущен ${formatDateTime(r.decided)} · последний вход ${formatDateTime(r.lastSeen)}`)))))
        : h('p', { class: 'muted' }, 'Допущенных устройств пока нет.'));
    }).catch(() => { devices.className = 'muted'; devices.textContent = 'Нет связи с сервером допуска.'; });
  }
  groups.push(group('access', 'Доступ', 'Сайт открыт только тем, кого вы допустили. Решение принимается на странице «Доступ».',
    row('Допуск посетителей', 'Посетитель отправляет запрос, владелец разрешает или отклоняет.',
      access.endpoint
        ? h('p', null, badge('Включён', 'ok'), ' Запросы — в разделе ', h('a', { href: '#/access' }, '«Доступ»'), '.')
        : h('p', null, badge('Выключен', 'warn'), ' Укажите адрес Google Apps Script в файле ', h('code', null, 'js/config.js'), ' (ACCESS_ENDPOINT). ', h('a', { href: 'google-apps-script/index.html', target: '_blank', rel: 'noopener' }, 'Инструкция')),
      access.endpoint ? h('p', { class: 'muted' }, 'Допущенные устройства работают с общей базой: правка одного видна остальным за несколько секунд. Перед массовым удалением сервер сохраняет предыдущую версию (меню таблицы «Учёт лицея → Откатить последнее массовое изменение»).') : null),
    row('Разрешённые устройства', 'Кому сейчас разрешён вход.', devices, access.endpoint && access.owner ? h('div', { class: 'row' }, link('Управлять доступом', '#/access', 'sm')) : null)));

  // ================= Данные =================
  const url = field({ label: 'Адрес Google Apps Script (Web App URL)', name: 'sheetsUrl', value: st.sheetsUrl, placeholder: 'https://script.google.com/macros/s/…/exec', hint: 'Должен оканчиваться на /exec' });
  const token = field({ label: 'Токен доступа', name: 'sheetsToken', type: 'password', value: st.sheetsToken, hint: 'Тот же, что показал скрипт после запуска setup(). Хранится только в этом браузере и не попадает в резервные копии.', autocomplete: 'off' });
  const auto = checkbox({ label: 'Автоматическая синхронизация', checked: st.autoSync, hint: 'При открытии сайта, при возвращении на вкладку и раз в час — если есть несинхронизированные изменения или прошло больше суток.' });
  const withBackup = checkbox({ label: 'Хранить полную копию данных в Google Таблице (скрытый лист «_Резерв»)', checked: st.includeBackupInSync, hint: 'Позволяет восстановить базу, если очистить данные браузера.' });
  const sync = describeSync(st);
  const statusBox = h('div', { class: 'status-line', 'data-kind': sync.kind, 'aria-live': 'polite' }, h('span', { class: 'dot' }), h('span', { class: 'status-text' }, sync.text));
  const setStatus = (text, kind) => { statusBox.dataset.kind = kind || describeSync(store.state.settings).kind; statusBox.querySelector('.status-text').textContent = text; };
  const saveSheets = async () => repo.updateSettings({ sheetsUrl: url.get(), sheetsToken: token.get(), autoSync: auto.get(), includeBackupInSync: withBackup.get() });

  const backups = await store.db.listBackups();
  const list = h('ul', { class: 'backup-list' });
  for (const b of backups) {
    list.append(h('li', null,
      h('div', { class: 'grow' }, h('strong', null, formatDateTime(b.createdAt)), h('div', { class: 'muted' }, `${REASONS[b.reason] || b.reason} · учеников: ${b.counts?.students ?? '?'}, сотрудников: ${b.counts?.staff ?? '?'}`)),
      btn('Скачать', async () => { const full = await store.db.getBackup(b.id); downloadJson(`lyceum-backup-${b.createdAt.slice(0, 10)}-${b.id}.json`, full.data); }, 'sm', { icon: 'download' }),
      btn('Восстановить', async () => {
        const ok = await confirmAction({ title: 'Восстановить из копии', message: `Все текущие данные будут заменены копией от ${formatDateTime(b.createdAt)}.`, details: ['Текущее состояние будет сохранено в новой резервной копии.'], confirmLabel: 'Восстановить', typeToConfirm: 'ВОССТАНОВИТЬ' });
        if (!ok) return;
        try { await repo.restoreFromSnapshot(b.id); toast('Данные восстановлены'); location.hash = '#/'; } catch (e) { toastError(e); }
      }, 'sm', { icon: 'undo' }),
      btn('Удалить', async () => { await store.db.deleteBackup(b.id); ctx.refresh(); }, 'danger-outline sm')));
  }
  const restoreFile = h('input', { type: 'file', accept: '.json,application/json', id: 'restoreFile', 'aria-label': 'Файл резервной копии', onchange: async () => {
    const f = restoreFile.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(decodeBytes(await readFileBytes(f)));
      const v = validateBackup(data);
      if (!v.ok) throw new Error(`Файл не подходит: ${v.errors.slice(0, 3).join('; ')}`);
      const ok = await confirmAction({ title: 'Восстановление из файла', message: 'Все текущие данные будут заменены данными из файла.', details: [`В файле: учеников — ${data.students.length}, сотрудников — ${data.staff.length}, учебных годов — ${data.years.length}.`, 'Текущее состояние будет сохранено в автоматической резервной копии.'], confirmLabel: 'Заменить данные', typeToConfirm: 'ЗАМЕНИТЬ' });
      if (ok) { await repo.restoreBackup(data); toast('Данные восстановлены'); location.hash = '#/'; }
    } catch (e) { toastError(e); } finally { restoreFile.value = ''; restorePicker.sync(); }
  } });
  const restorePicker = filePicker(restoreFile);

  const storageInfo = h('p', null, 'Проверяем…');
  (async () => {
    const parts = [store.db.kind === 'indexeddb' ? badge('IndexedDB', 'ok') : badge('Только память (данные не сохраняются!)', 'danger')];
    try {
      if (navigator.storage?.persisted) parts.push(' ', (await navigator.storage.persisted()) ? badge('Постоянное хранение включено', 'ok') : badge('Постоянное хранение не запрошено', 'warn'));
      if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); parts.push(` Занято: ${((e.usage || 0) / 1048576).toFixed(1)} МБ`); }
    } catch { /* ignore */ }
    storageInfo.replaceChildren(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
    if (navigator.storage?.persist) storageInfo.append(' ', btn('Запросить постоянное хранение', async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Браузер сохранит данные постоянно' : 'Браузер не дал разрешения. Добавьте сайт на главный экран или делайте резервные копии.', ok ? 'success' : 'error'); ctx.refresh(); }, 'sm'));
  })();

  groups.push(group('data', 'Данные', 'Где хранятся данные лицея, как они попадают в Google Таблицу и как их восстановить.',
    h('div', { id: 'sheets' },
    row('Google Таблицы', 'Скрипт Google Apps Script принимает данные и хранит общую базу. Бесплатно, без своего сервера.',
      url.el, token.el,
      h('div', { class: 'row' }, h('a', { href: 'google-apps-script/index.html', target: '_blank', rel: 'noopener' }, 'Пошаговая инструкция и код скрипта'))),
    row('Синхронизация', 'Режим выгрузки и состояние последней отправки.', auto.el, withBackup.el, statusBox,
      h('div', { class: 'row' },
        btn('Сохранить', async () => { try { await saveSheets(); toast('Настройки синхронизации сохранены'); } catch (e) { toastError(e); } }, 'primary'),
        btn('Проверить соединение', async () => {
          try { await saveSheets(); } catch (e) { return toastError(e); }
          setStatus('Проверяем…', 'warn');
          const r = await checkConnection(store);
          setStatus(r.ok ? `Соединение установлено${r.info?.lastSyncAt ? `. Последняя запись на сервере: ${formatDateTime(r.info.lastSyncAt)}` : ''}` : r.error, r.ok ? 'ok' : 'error');
          toast(r.ok ? 'Соединение работает' : r.error, r.ok ? 'success' : 'error');
        }, '', { icon: 'cloud' }),
        btn('Выгрузить в Google Таблицы', async () => {
          try { await saveSheets(); } catch (e) { return toastError(e); }
          let allowEmpty = false;
          if (isEmptyDb(store.state)) {
            allowEmpty = await confirmAction({ title: 'Выгрузить пустую базу?', message: 'В этом браузере нет ни учеников, ни персонала. Выгрузка ПЕРЕЗАПИШЕТ листы в Google Таблице пустыми данными.', details: ['Данные в таблице будут стёрты.', 'Чтобы этого не случилось, сначала загрузите данные в «Импорт и экспорт».'], confirmLabel: 'Всё равно выгрузить' });
            if (!allowEmpty) return;
          }
          setStatus('Отправка данных…', 'warn');
          const r = await syncNow(store, repo, { reason: 'manual', allowEmpty });
          setStatus(describeSync(store.state.settings).text);
          toast(r.ok ? (r.confirmed ? 'Данные выгружены в Google Таблицы' : 'Данные отправлены (подтверждение недоступно)') : r.error, r.ok ? 'success' : 'error');
        }, '', { id: 'syncNowBtn', icon: 'upload' })))),
    row('Резервные копии', `Копии в браузере (последние 10) создаются автоматически перед опасными операциями. Последняя в браузере: ${st.lastBackupAt ? formatDateTime(st.lastBackupAt) : 'не создавалась'}; последний файл: ${st.lastExportAt ? formatDateTime(st.lastExportAt) : 'не скачивался'}. Регулярно скачивайте файл копии и храните его вне браузера.`,
      h('div', { class: 'row', style: 'margin:0 0 10px' },
        btn('Создать копию в браузере', async () => { try { await store.createBackup('manual'); toast('Копия создана'); ctx.refresh(); } catch (e) { toastError(e); } }, '', { icon: 'database' }),
        btn('Скачать резервную копию (JSON)', async () => { await saveBackupFile(repo); toast('Файл сохранён'); }, 'primary', { icon: 'download' })),
      h('div', { class: 'field owner-only' }, h('label', { for: 'restoreFile' }, 'Восстановить из файла (JSON)'), restorePicker.el),
      backups.length ? list : h('p', { class: 'muted' }, 'Копий в браузере пока нет.')),
    row('Хранилище', 'Где лежат данные на этом устройстве.', storageInfo,
      notice('info', 'Данные хранятся в IndexedDB этого браузера. Очистка данных сайта в браузере удалит локальную копию; с общей базой данные вернутся с сервера, иначе — из резервной копии.'))));

  // ================= Учебный процесс =================
  groups.push(group('process', 'Учебный процесс', null,
    row('Переход в новый учебный год', `Сейчас: ${yearLabel(st.currentYearId)}. Ежегодный перевод с предпросмотром, выпуском 11 классов и возможностью отмены.`, h('div', { class: 'row' }, link('Начать новый учебный год', '#/new-year', 'primary', { icon: 'calendar-next' }))),
    row('Классы и параллели', 'Список классов текущего года, назначение руководителей и воспитателей.', h('div', { class: 'row' }, link('Классы', '#/classes', 'sm'), link('Персонал', '#/staff', 'sm')))));

  // ================= Система =================
  const changes = recentChanges(s, 8);
  groups.push(group('system', 'Система', null,
    row('Импорт и экспорт', 'Загрузка списков из CSV / JSON, выгрузка данных, шифрованный файл лицея.', h('div', { class: 'row' }, link('Открыть импорт и экспорт', '#/import', '', { icon: 'swap' }))),
    row('История изменений', 'Последние операции с данными. История прошлых учебных лет — в разделе «История».',
      changes.length
        ? h('ul', { class: 'activity' }, changes.map((c) => h('li', null, h('span', { class: 'what' }, h('span', { class: 'kind' }, c.title), c.detail ? [': ', c.detail] : null), h('span', { class: 'when' }, formatDateTime(c.at)))))
        : h('p', { class: 'muted' }, 'Изменений пока нет.'),
      h('div', { class: 'row' }, link('История учебных лет', '#/history', 'sm'))),
    row('Демонстрационные данные', 'Вымышленные ученики и сотрудники с пометкой DEMO — только для проверки работы сайта. Реальные данные не затрагиваются.',
      h('div', { class: 'row' },
        btn('Загрузить DEMO-данные', async () => { try { const r = await loadDemo(repo); toast(`Загружено: ${nStudents(r.students)}, сотрудников: ${r.staff}`); } catch (e) { toastError(e); } }, '', { id: 'loadDemoBtn' }),
        btn('Удалить DEMO-данные', async () => {
          if (!repo.hasDemo()) return toast('DEMO-данных нет', 'error');
          if (!(await confirmAction({ title: 'Удалить DEMO-данные', message: 'Будут удалены все записи с пометкой DEMO. Перед этим создаётся резервная копия.', confirmLabel: 'Удалить DEMO' }))) return;
          try { await repo.deleteDemo(); toast('DEMO-данные удалены'); } catch (e) { toastError(e); }
        }, 'danger-outline'))),
    h('div', { class: 'card danger-zone owner-only', style: 'margin:18px 0 0' }, h('h2', null, 'Опасная зона'),
      h('p', null, 'Полная очистка удалит всех учеников, персонал, все учебные годы и историю. Настройки подключения к Google сохранятся. Перед очисткой создаётся резервная копия в браузере.'),
      btn('Очистить все данные…', async () => {
        const ok = await confirmAction({ title: 'Очистить все данные', message: 'Будут удалены ВСЕ данные: ученики, персонал, классы, история и архив.', details: [`Сейчас в базе: ${nStudents(ctx.state.students.length)}, сотрудников — ${ctx.state.staff.length}, учебных годов — ${ctx.state.years.length}.`, 'Резервная копия будет создана автоматически — её можно восстановить в этом разделе.'], confirmLabel: 'Очистить всё', typeToConfirm: 'ОЧИСТИТЬ' });
        if (!ok) return;
        try { await repo.clearAll(); toast('Данные очищены. Копия сохранена в разделе «Резервные копии»'); location.hash = '#/'; } catch (e) { toastError(e); }
      }, 'danger', { id: 'clearAllBtn' }))));

  // ================= Каркас: навигация по разделам =================
  const navBtns = SECTIONS.map(([id, label, ic]) => h('button', { type: 'button', 'data-nav': id, onclick: () => go(id) }, icon(ic, 15), label));
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Разделы настроек' }, navBtns);
  const body = h('div', { class: 'settings-body' }, groups);
  el.append(h('div', { class: 'settings' }, nav, body));

  const mark = (id) => navBtns.forEach((b) => (b.dataset.nav === id ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  function go(id) {
    const target = body.querySelector(`[data-section="${id}"]`);
    mark(id);
    if (target) target.scrollIntoView({ behavior: document.documentElement.classList.contains('no-anim') ? 'auto' : 'smooth', block: 'start' });
  }
  mark('general');
  let observer = null;
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) mark(top.target.dataset.section);
    }, { rootMargin: '-15% 0px -70% 0px' });
    body.querySelectorAll('[data-section]').forEach((g) => observer.observe(g));
  }
  if (query.section && SECTIONS.some(([id]) => id === query.section)) requestAnimationFrame(() => go(query.section));
  return () => observer && observer.disconnect();
}
