import { h } from '../ui/dom.js';
import { pageHead, btn, badge, notice } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { listRequests, decideRequest } from '../services/access.js';
import { formatDateTime } from '../domain/dates.js';

export const title = 'Доступ';

const STATUS = { pending: ['Ожидает', 'warn'], allowed: ['Допущен', 'ok'], denied: ['Отклонён', 'danger'], revoked: ['Отозван', 'danger'] };

export async function render(ctx) {
  const { view: el, access } = ctx;
  el.append(pageHead({ title: 'Доступ', sub: 'Запросы посетителей: вы решаете, кого впустить' }));
  if (!access.endpoint) {
    el.append(notice('info', 'Допуск посетителей выключен: в файле ', h('code', null, 'js/config.js'), ' не указан адрес Google Apps Script (ACCESS_ENDPOINT). Инструкция — ', h('a', { href: 'google-apps-script/index.html', target: '_blank', rel: 'noopener' }, 'подключение скрипта'), '.'));
    return;
  }
  if (!access.owner) {
    el.append(notice('danger', 'Эта страница доступна только владельцу. Войдите по токену владельца.'));
    return;
  }
  const token = ctx.state.settings.sheetsToken;
  const holder = h('div', { 'aria-live': 'polite' }, h('p', { class: 'loading' }, 'Загрузка…'));
  el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'Запросы на доступ'), btn('Обновить', () => load(), 'sm', { id: 'accessRefresh' })), holder));
  el.append(notice('info', h('strong', null, 'Как это работает. '), 'Посетитель вводит имя и сообщение, вы получаете письмо и решаете здесь. Допущенный видит сайт; отозванный теряет вход, а сохранённые у него данные стираются при следующем открытии сайта. ',
    h('strong', null, 'Важно: '), 'допуск не заменяет шифрование. Файл с данными защищён паролем, который вы сообщаете людям сами; кому вы его сообщили и кто уже загрузил данные, уже имеет их копию.'));

  async function decide(r, decision, label) {
    const danger = decision === 'deny' || decision === 'revoke' || decision === 'delete';
    if (danger && !(await confirmAction({ title: label, message: `${label}: ${r.name}?`, details: decision === 'revoke' ? ['На следующем открытии сайта у этого человека будут стёрты данные, сохранённые в его браузере.'] : [], confirmLabel: label, kind: decision === 'delete' ? 'danger' : 'primary' }))) return;
    try {
      await decideRequest(access.endpoint, token, r.id, decision);
      toast('Готово');
      await load();
    } catch (e) { toastError(e); }
  }

  async function load() {
    try {
      const { requests } = await listRequests(access.endpoint, token);
      access.pending = requests.filter((r) => r.status === 'pending').length;
      access.onPending?.(access.pending);
      holder.replaceChildren(dataTable({
        caption: 'Запросы на доступ',
        rows: requests.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.created.localeCompare(a.created)),
        empty: 'Запросов пока нет. Когда кто-то откроет сайт и отправит запрос, он появится здесь и придёт вам на почту.',
        columns: [
          { key: 'name', label: 'Имя', render: (r) => h('strong', null, r.name) },
          { key: 'note', label: 'Сообщение', render: (r) => r.note || '—' },
          { key: 'created', label: 'Запрос', render: (r) => formatDateTime(r.created) },
          { key: 'status', label: 'Статус', render: (r) => badge(STATUS[r.status]?.[0] || r.status, STATUS[r.status]?.[1] || '') },
          { key: 'act', label: 'Действия', actions: true, render: (r) => h('span', null,
            r.status !== 'allowed' ? btn('Разрешить', () => decide(r, 'allow', 'Разрешить'), 'primary sm', { 'data-act': 'allow' }) : null,
            r.status === 'pending' ? btn('Отклонить', () => decide(r, 'deny', 'Отклонить'), 'danger-outline sm', { 'data-act': 'deny' }) : null,
            r.status === 'allowed' ? btn('Отозвать', () => decide(r, 'revoke', 'Отозвать доступ'), 'danger-outline sm', { 'data-act': 'revoke' }) : null,
            btn('Удалить запись', () => decide(r, 'delete', 'Удалить запись'), 'ghost sm', { 'data-act': 'delete' })) },
        ],
      }));
    } catch (e) {
      holder.replaceChildren(notice('danger', e.message));
    }
  }
  await load();
  const timer = setInterval(load, 15000);
  return () => clearInterval(timer);
}
