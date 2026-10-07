// Экран допуска: посетитель отправляет запрос владельцу и ждёт решения. Владелец входит по токену.
import { h } from './dom.js';
import { field } from './form.js';
import { toastError } from './toast.js';
import { logoMark } from './logo.js';
import { requestAccess, accessStatus, verifyOwner } from '../services/access.js';

const pollMs = () => (typeof globalThis.__LYCEUM_POLL_MS__ === 'number' ? globalThis.__LYCEUM_POLL_MS__ : 8000);

/** Возвращает Promise<{ role: 'owner' | 'visitor' }> — разрешается, когда вход разрешён. */
export function runGate({ endpoint, store, repo, db, view, onShown }) {
  document.body.classList.add('gated');
  return new Promise((resolve) => {
    let timer = null;
    const finish = (role) => {
      clearTimeout(timer);
      document.body.classList.remove('gated');
      resolve({ role });
    };
    const show = (...nodes) => { onShown?.(); return view.replaceChildren(h('div', { class: 'gate' }, h('div', { class: 'card gate-card' }, h('div', { class: 'gate-brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, logoMark(30)), h('div', { class: 'brand-text' }, h('strong', null, 'Костанай БИЛ'), h('small', null, 'Информационная система лицея'))), nodes))); };

    async function enterAsOwner(token) {
      const r = await verifyOwner(endpoint, token);
      if (!r.ok) throw new Error('Неверный токен владельца');
      const s = store.state.settings;
      await repo.updateSettings({ sheetsToken: token, ...(s.sheetsUrl ? {} : { sheetsUrl: endpoint }) });
      finish('owner');
    }

    function ownerLink() {
      const box = h('div', { class: 'gate-owner' });
      const open = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'ownerLoginBtn', onclick: () => {
        const tok = field({ label: 'Токен владельца', name: 'ownerToken', type: 'password', autocomplete: 'off' });
        box.replaceChildren(h('form', { onsubmit: async (e) => {
          e.preventDefault();
          try { await enterAsOwner(tok.get().trim()); } catch (err) { tok.error(err.message); }
        } }, tok.el, h('button', { type: 'submit', class: 'btn btn-primary btn-sm', id: 'ownerLoginSubmit' }, 'Войти как владелец')));
        tok.input.focus();
      } }, 'Вход для владельца');
      box.append(open);
      return box;
    }

    function showRequestForm(err = '') {
      const name = field({ label: 'Имя и фамилия', name: 'visitorName', required: true, attrs: { maxlength: 80 } });
      const note = field({ label: 'Кто вы и зачем нужен доступ', name: 'visitorNote', type: 'textarea', attrs: { maxlength: 300 }, hint: 'Например: классный руководитель 9А. Необязательно.', rows: 3 });
      show(
        h('h1', null, 'Вход по разрешению'),
        h('p', null, 'Сайт содержит данные учеников. Чтобы войти, отправьте запрос владельцу — он сам решит, пускать ли вас.'),
        err ? h('div', { class: 'notice danger' }, err) : null,
        h('form', { onsubmit: async (e) => {
          e.preventDefault();
          name.error('');
          const submit = e.target.querySelector('button[type=submit]');
          submit.disabled = true;
          try {
            const r = await requestAccess(endpoint, name.get(), note.get());
            route(r.status);
          } catch (e2) {
            if (e2.code === 'name-required') name.error(e2.message);
            else toastError(e2);
          } finally { submit.disabled = false; }
        } }, name.el, note.el, h('button', { type: 'submit', class: 'btn btn-primary', id: 'requestAccessBtn' }, 'Отправить запрос')),
        h('p', { class: 'muted' }, 'Владелец увидит только имя и сообщение, которые вы здесь введёте.'),
        ownerLink(),
      );
    }

    function showPending() {
      show(
        h('h1', null, 'Запрос отправлен'),
        h('p', null, 'Владелец получил ваш запрос и скоро решит. Эту страницу можно не закрывать — она сама проверит ответ.'),
        h('p', { class: 'muted', id: 'gateStatus', 'aria-live': 'polite' }, 'Статус: ожидает решения'),
        h('button', { type: 'button', class: 'btn', id: 'checkNowBtn', onclick: () => poll(true) }, 'Проверить сейчас'),
        ownerLink(),
      );
      clearTimeout(timer);
      timer = setTimeout(() => poll(false), pollMs());
    }

    async function showClosed(status) {
      clearTimeout(timer);
      try { await db.wipe?.(); } catch { /* ignore */ }
      show(
        h('h1', null, status === 'revoked' ? 'Доступ отозван' : 'В доступе отказано'),
        h('p', null, status === 'revoked' ? 'Владелец закрыл вам доступ. Данные, сохранённые в этом браузере, удалены.' : 'Владелец не разрешил вход.'),
        h('p', { class: 'muted' }, 'Если это ошибка, свяжитесь с владельцем напрямую.'),
        ownerLink(),
      );
    }

    function route(status) {
      if (status === 'allowed') return finish('visitor');
      if (status === 'pending') return showPending();
      if (status === 'denied' || status === 'revoked') return showClosed(status);
      return showRequestForm();
    }

    async function poll(manual) {
      try {
        route((await accessStatus(endpoint)).status);
      } catch (e) {
        if (manual) toastError(e);
        const el = document.getElementById('gateStatus');
        if (el) el.textContent = `Нет ответа: ${e.message}`;
        clearTimeout(timer);
        timer = setTimeout(() => poll(false), pollMs() * 2);
      }
    }

    function showOffline(message) {
      show(
        h('h1', null, 'Нет связи с сервером допуска'),
        h('p', null, message),
        h('button', { type: 'button', class: 'btn btn-primary', id: 'retryBtn', onclick: () => start() }, 'Повторить'),
        ownerLink(),
      );
    }

    async function start() {
      show(h('p', { class: 'loading' }, 'Проверка доступа…'));
      const token = store.state.settings.sheetsToken;
      try {
        if (token) {
          try {
            await enterAsOwner(token);
            return;
          } catch (e) {
            if (e.code !== 'auth') throw e; // сохранённый токен не подошёл — дальше обычный путь посетителя
          }
        }
        route((await accessStatus(endpoint)).status);
      } catch (e) {
        showOffline(e.message);
      }
    }
    start();
  });
}

/** Периодическая проверка во время работы: если доступ отозван — перезагрузка (покажет экран «Доступ отозван»). */
export function watchAccess(endpoint, intervalMs = 300000) {
  const id = setInterval(async () => {
    try {
      const { status } = await accessStatus(endpoint);
      if (status === 'denied' || status === 'revoked' || status === 'none') location.reload();
    } catch { /* нет связи — проверим позже */ }
  }, intervalMs);
  return () => clearInterval(id);
}
