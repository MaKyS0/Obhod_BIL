import { h } from '../ui/dom.js';
import { pageHead, btn, badge, notice } from '../ui/common.js';
import { dataTable } from '../ui/table.js';
import { confirmAction } from '../ui/modal.js';
import { toast, toastError } from '../ui/toast.js';
import { listRequests, decideRequest } from '../services/access.js';
import { formatDateTime } from '../domain/dates.js';

export const title = 'Запросы доступа';

const ROLE = { admin: 'Администратор', user: 'Дежурный' };
const STATUS = { pending: ['Ожидает', 'warn'], allowed: ['Допущен', 'ok'], denied: ['Отклонён', 'danger'], revoked: ['Отозван', 'danger'] };

export async function render(ctx) {
  const { view: el, access } = ctx;
  el.append(pageHead({ title: 'Запросы доступа', sub: 'Кто просит доступ, в какой роли: вы решаете, кого впустить' }));
  if (!access.endpoint) {
    el.append(notice('info', 'Допуск посетителей выключен: в файле ', h('code', null, 'js/config.js'), ' не указан адрес Google Apps Script (ACCESS_ENDPOINT). Инструкция — ', h('a', { href: 'google-apps-script/index.html', target: '_blank', rel: 'noopener' }, 'подключение скрипта'), '.'));
    return;
  }
  if (!access.admin) {
    el.append(notice('danger', 'Эта страница доступна только администратору.'));
    return;
  }
  const token = ctx.state.settings.sheetsToken;
  const holder = h('div', { 'aria-live': 'polite' }, h('p', { class: 'loading' }, 'Загрузка…'));
  el.append(h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', null, 'Запросы на доступ'), btn('Обновить', () => load(), 'sm', { id: 'accessRefresh', icon: 'refresh' })), holder));
  el.append(notice('info', h('strong', null, 'Как это работает. '), 'Человек вводит имя, почту и сообщение, вы получаете письмо и решаете здесь. «Дежурный» проводит обход, «администратор» видит итоги, журнал и выгрузки (роль администратора выдаёт только владелец по токену). Допущенный видит сайт; отозванный теряет вход, а сохранённые у него данные стираются при следующем открытии сайта. ',
    h('strong', null, 'Важно: '), 'допуск не заменяет шифрование. Файл с данными защищён паролем, который вы сообщаете людям сами; кому вы его сообщили и кто уже загрузил данные, уже имеет их копию.'));

  async function decide(r, decision, label, role = 'user') {
    const danger = decision === 'deny' || decision === 'revoke' || decision === 'delete';
    if (danger && !(await confirmAction({ title: label, message: `${label}: ${r.name}?`, details: decision === 'revoke' ? ['На следующем открытии сайта у этого человека будут стёрты данные, сохранённые в его браузере.'] : [], confirmLabel: label, kind: decision === 'delete' ? 'danger' : 'primary' }))) return;
    try {
      await decideRequest(access.endpoint, token, r.id, decision, role);
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
          { key: 'name', label: 'Имя', render: (r) => h('span', null, h('strong', null, r.name), r.email ? h('div', { class: 'meta' }, r.email) : null) },
          { key: 'note', label: 'Сообщение', render: (r) => r.note || '—' },
          { key: 'role', label: 'Роль', render: (r) => (r.status === 'allowed' ? ROLE[r.role] || '—' : h('span', { class: 'muted' }, `просит: ${(ROLE[r.wantRole] || '').toLowerCase()}`)) },
          { key: 'created', label: 'Запрос', render: (r) => formatDateTime(r.created) },
          { key: 'lastSeen', label: 'Был(а)', render: (r) => (r.status === 'allowed' && r.lastSeen ? formatDateTime(r.lastSeen) : '—') },
          { key: 'status', label: 'Статус', render: (r) => badge(STATUS[r.status]?.[0] || r.status, STATUS[r.status]?.[1] || '') },
          { key: 'act', label: 'Действия', actions: true, render: (r) => h('span', null,
            r.status !== 'allowed' ? btn(r.wantRole === 'admin' && !access.isOwner ? 'Принять как дежурного' : 'Принять', () => decide(r, 'allow', 'Принять', 'user'), 'primary sm', { 'data-act': 'allow', icon: 'check' }) : null,
            r.status !== 'allowed' && access.isOwner ? btn('Принять как администратора', () => decide(r, 'allow', 'Принять как администратора', 'admin'), 'sm', { 'data-act': 'allow-admin', icon: 'shield' }) : null,
            r.status === 'allowed' && access.isOwner ? btn(r.role === 'admin' ? 'Сделать дежурным' : 'Сделать администратором', () => decide(r, 'role', 'Сменить роль', r.role === 'admin' ? 'user' : 'admin'), 'sm', { 'data-act': 'role' }) : null,
            r.status === 'pending' ? btn('Отклонить', () => decide(r, 'deny', 'Отклонить'), 'danger-outline sm', { 'data-act': 'deny' }) : null,
            r.status === 'allowed' && (access.isOwner || r.role !== 'admin') ? btn('Отозвать', () => decide(r, 'revoke', 'Отозвать доступ'), 'danger-outline sm', { 'data-act': 'revoke' }) : null,
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
