import { h } from '../ui/dom.js';
import { pageHead, btn, link, badge, notice } from '../ui/common.js';
import { field, checkbox } from '../ui/form.js';
import { confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { downloadJson, readFileBytes } from '../services/download.js';
import { saveBackupFile } from '../services/backup-file.js';
import { syncNow, checkConnection, describeSync, isEmptyDb } from '../services/sync.js';
import { loadDemo } from '../services/demo.js';
import { decodeBytes } from '../domain/csv.js';
import { validateBackup } from '../domain/backup.js';
import { formatDateTime } from '../domain/dates.js';
import { yearLabel } from '../domain/years.js';
import { nStudents } from '../domain/plural.js';

export const title = 'Настройки';

const REASONS = { manual: 'вручную', 'before-promotion': 'перед переходом на новый год', 'before-undo': 'перед отменой перехода', 'before-import': 'перед импортом', 'before-restore': 'перед восстановлением', 'before-clear': 'перед очисткой/удалением' };

export async function render(ctx) {
  const { state: s, repo, store, view: el } = ctx;
  const st = s.settings;
  el.append(pageHead({ title: 'Настройки', sub: 'Название лицея, синхронизация, резервные копии, восстановление данных' }));

  // ---- Основное ----
  const name = field({ label: 'Название лицея', name: 'name', value: st.lyceumName, required: true });
  const onlyYear = s.years.length <= 1 && !s.promotions.length;
  const year = field({ label: 'Текущий учебный год', name: 'year', value: yearLabel(st.currentYearId), hint: onlyYear ? 'Формат 2026–2027. Можно менять, пока не выполнялся первый переход.' : 'Изменяется только через «Начать новый учебный год».', attrs: { disabled: !onlyYear } });
  el.append(h('div', { class: 'card' }, h('h2', null, 'Основное'), h('div', { class: 'field-row' }, name.el, year.el),
    h('div', { class: 'row' }, btn('Сохранить', async () => {
      try {
        await repo.updateSettings({ lyceumName: name.get() });
        if (onlyYear && year.get().trim() !== yearLabel(st.currentYearId)) await repo.setCurrentYear(year.get());
        toast('Настройки сохранены');
      } catch (e) { toastError(e); }
    }, 'primary'))));

  // ---- Допуск посетителей ----
  el.append(h('div', { class: 'card' }, h('h2', null, 'Допуск посетителей'),
    ctx.access.endpoint
      ? h('p', null, badge('Включён', 'ok'), ' Посетители отправляют запрос, вы решаете в разделе ', h('a', { href: '#/access' }, '«Доступ»'), '.')
      : h('p', null, badge('Выключен', 'warn'), ' Укажите адрес Google Apps Script в файле ', h('code', null, 'js/config.js'), ' (ACCESS_ENDPOINT), чтобы пускать на сайт только по вашему разрешению. ', h('a', { href: 'google-apps-script/index.html', target: '_blank', rel: 'noopener' }, 'Инструкция'))));

  // ---- Новый год ----
  el.append(h('div', { class: 'card' }, h('h2', null, 'Новый учебный год'), h('p', { class: 'muted' }, `Сейчас: ${yearLabel(st.currentYearId)}. Ежегодный перевод с предпросмотром, выпуском 11 классов и возможностью отмены.`), link('Начать новый учебный год', '#/new-year', 'primary')));

  // ---- Google Таблицы ----
  const url = field({ label: 'Адрес Google Apps Script (Web App URL)', name: 'sheetsUrl', value: st.sheetsUrl, placeholder: 'https://script.google.com/macros/s/…/exec', hint: 'Должен оканчиваться на /exec' });
  const token = field({ label: 'Токен доступа', name: 'sheetsToken', type: 'password', value: st.sheetsToken, hint: 'Тот же, что показал скрипт после запуска setup(). Хранится только в этом браузере и не попадает в резервные копии.', autocomplete: 'off' });
  const auto = checkbox({ label: 'Автоматическая синхронизация', checked: st.autoSync, hint: 'При открытии сайта, при возвращении на вкладку и раз в час — если есть несинхронизированные изменения или прошло больше суток.' });
  const withBackup = checkbox({ label: 'Хранить полную копию данных в Google Таблице (скрытый лист «_Резерв»)', checked: st.includeBackupInSync, hint: 'Позволяет восстановить базу, если очистить данные браузера.' });
  const statusBox = h('div', { class: 'notice info', 'aria-live': 'polite' }, describeSync(st).text);
  const saveSheets = async () => repo.updateSettings({ sheetsUrl: url.get(), sheetsToken: token.get(), autoSync: auto.get(), includeBackupInSync: withBackup.get() });
  el.append(h('div', { class: 'card', id: 'sheets' }, h('h2', null, 'Google Таблицы'),
    h('p', { class: 'muted' }, 'Сайт отправляет данные в вашу Google Таблицу через Google Apps Script (бесплатно, без сервера). ', h('a', { href: 'google-apps-script/index.html', target: '_blank', rel: 'noopener' }, 'Пошаговая инструкция и код скрипта')),
    url.el, token.el, auto.el, withBackup.el, statusBox,
    h('div', { class: 'row' },
      btn('Сохранить', async () => { try { await saveSheets(); toast('Настройки синхронизации сохранены'); } catch (e) { toastError(e); } }, 'primary'),
      btn('Проверить соединение', async () => {
        try { await saveSheets(); } catch (e) { return toastError(e); }
        statusBox.textContent = 'Проверяем…';
        const r = await checkConnection(store);
        statusBox.textContent = r.ok ? `Соединение установлено${r.info?.lastSyncAt ? `. Последняя запись на сервере: ${formatDateTime(r.info.lastSyncAt)}` : ''}` : r.error;
        toast(r.ok ? 'Соединение работает' : r.error, r.ok ? 'success' : 'error');
      }),
      btn('Выгрузить в Google Таблицы', async () => {
        try { await saveSheets(); } catch (e) { return toastError(e); }
        let allowEmpty = false;
        if (isEmptyDb(store.state)) {
          allowEmpty = await confirmAction({ title: 'Выгрузить пустую базу?', message: 'В этом браузере нет ни учеников, ни персонала. Выгрузка ПЕРЕЗАПИШЕТ листы в Google Таблице пустыми данными.', details: ['Данные в таблице будут стёрты.', 'Чтобы этого не случилось, сначала загрузите данные в «Импорт и экспорт».'], confirmLabel: 'Всё равно выгрузить' });
          if (!allowEmpty) return;
        }
        statusBox.textContent = 'Отправка данных…';
        const r = await syncNow(store, repo, { reason: 'manual', allowEmpty });
        statusBox.textContent = describeSync(store.state.settings).text;
        toast(r.ok ? (r.confirmed ? 'Данные выгружены в Google Таблицы' : 'Данные отправлены (подтверждение недоступно)') : r.error, r.ok ? 'success' : 'error');
      }, '', { id: 'syncNowBtn' }))));

  // ---- Резервные копии ----
  const backups = await store.db.listBackups();
  const list = h('ul', { class: 'backup-list' });
  for (const b of backups) {
    list.append(h('li', null,
      h('div', { class: 'grow' }, h('strong', null, formatDateTime(b.createdAt)), h('div', { class: 'muted' }, `${REASONS[b.reason] || b.reason} · учеников: ${b.counts?.students ?? '?'}, сотрудников: ${b.counts?.staff ?? '?'}`)),
      btn('Скачать', async () => { const full = await store.db.getBackup(b.id); downloadJson(`lyceum-backup-${b.createdAt.slice(0, 10)}-${b.id}.json`, full.data); }, 'sm'),
      btn('Восстановить', async () => {
        const ok = await confirmAction({ title: 'Восстановить из копии', message: `Все текущие данные будут заменены копией от ${formatDateTime(b.createdAt)}.`, details: ['Текущее состояние будет сохранено в новой резервной копии.'], confirmLabel: 'Восстановить', typeToConfirm: 'ВОССТАНОВИТЬ' });
        if (!ok) return;
        try { await repo.restoreFromSnapshot(b.id); toast('Данные восстановлены'); location.hash = '#/'; } catch (e) { toastError(e); }
      }, 'sm'),
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
    } catch (e) { toastError(e); } finally { restoreFile.value = ''; }
  } });
  el.append(h('div', { class: 'card' }, h('h2', null, 'Резервные копии'),
    h('p', { class: 'muted' }, `Копии в браузере (последние 10) создаются автоматически перед опасными операциями. Последняя копия в браузере: ${st.lastBackupAt ? formatDateTime(st.lastBackupAt) : 'не создавалась'}; последний файл: ${st.lastExportAt ? formatDateTime(st.lastExportAt) : 'не скачивался'}. Регулярно скачивайте файл копии и храните его вне браузера.`),
    h('div', { class: 'row', style: 'margin-bottom:8px' },
      btn('Создать копию в браузере', async () => { try { await store.createBackup('manual'); toast('Копия создана'); ctx.refresh(); } catch (e) { toastError(e); } }),
      btn('Скачать резервную копию (JSON)', async () => { await saveBackupFile(repo); toast('Файл сохранён'); }, 'primary')),
    h('div', { class: 'field' }, h('label', { for: 'restoreFile' }, 'Восстановить из файла (JSON)'), restoreFile),
    backups.length ? list : h('p', { class: 'muted' }, 'Копий в браузере пока нет.')));

  // ---- Хранилище ----
  const storageInfo = h('p', null, 'Проверяем…');
  el.append(h('div', { class: 'card' }, h('h2', null, 'Хранилище данных'), storageInfo, notice('info', 'Данные хранятся в IndexedDB этого браузера на этом устройстве. Другой браузер или компьютер видит пустую базу — переносите данные через резервную копию или Google Таблицы. Очистка данных сайта в браузере удалит базу.')));
  (async () => {
    const parts = [store.db.kind === 'indexeddb' ? badge('IndexedDB', 'ok') : badge('Только память (данные не сохраняются!)', 'danger')];
    try {
      if (navigator.storage?.persisted) parts.push(' ', (await navigator.storage.persisted()) ? badge('Постоянное хранение включено', 'ok') : badge('Постоянное хранение не запрошено', 'warn'));
      if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); parts.push(` Занято: ${((e.usage || 0) / 1048576).toFixed(1)} МБ`); }
    } catch { /* ignore */ }
    storageInfo.replaceChildren(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
    if (navigator.storage?.persist) storageInfo.append(' ', btn('Запросить постоянное хранение', async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Браузер сохранит данные постоянно' : 'Браузер не дал разрешения. Добавьте сайт на главный экран или делайте резервные копии.', ok ? 'success' : 'error'); ctx.refresh(); }, 'sm'));
  })();

  // ---- Демо и очистка ----
  el.append(h('div', { class: 'card' }, h('h2', null, 'Демонстрационные данные'), h('p', { class: 'muted' }, 'Вымышленные ученики и сотрудники с пометкой DEMO — только для проверки работы сайта. Реальные данные не затрагиваются.'),
    h('div', { class: 'row' },
      btn('Загрузить DEMO-данные', async () => { try { const r = await loadDemo(repo); toast(`Загружено: ${nStudents(r.students)}, сотрудников: ${r.staff}`); } catch (e) { toastError(e); } }, '', { id: 'loadDemoBtn' }),
      btn('Удалить DEMO-данные', async () => {
        if (!repo.hasDemo()) return toast('DEMO-данных нет', 'error');
        if (!(await confirmAction({ title: 'Удалить DEMO-данные', message: 'Будут удалены все записи с пометкой DEMO. Перед этим создаётся резервная копия.', confirmLabel: 'Удалить DEMO' }))) return;
        try { await repo.deleteDemo(); toast('DEMO-данные удалены'); } catch (e) { toastError(e); }
      }, 'danger-outline'))));

  el.append(h('div', { class: 'card danger-zone' }, h('h2', null, 'Опасная зона'),
    h('p', null, 'Полная очистка удалит всех учеников, персонал, все учебные годы и историю. Настройки подключения к Google сохранятся. Перед очисткой создаётся резервная копия в браузере.'),
    btn('Очистить все данные…', async () => {
      const ok = await confirmAction({ title: 'Очистить все данные', message: 'Будут удалены ВСЕ данные: ученики, персонал, классы, история и архив.', details: [`Сейчас в базе: ${nStudents(ctx.state.students.length)}, сотрудников — ${ctx.state.staff.length}, учебных годов — ${ctx.state.years.length}.`, 'Резервная копия будет создана автоматически — её можно восстановить в этом разделе.'], confirmLabel: 'Очистить всё', typeToConfirm: 'ОЧИСТИТЬ' });
      if (!ok) return;
      try { await repo.clearAll(); toast('Данные очищены. Копия сохранена в разделе «Резервные копии»'); location.hash = '#/'; } catch (e) { toastError(e); }
    }, 'danger', { id: 'clearAllBtn' })));
}
