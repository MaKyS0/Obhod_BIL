// Журнал действий для человека: названия событий и расшифровка подробностей. Сервер хранит коды и ID, имена подставляются здесь из общей базы.
import { ROUND_LABEL, ROUND_KINDS } from './rounds.js';
import { fullName } from './people.js';

export const EVENT_LABELS = {
  login: 'Вход',
  'login-failed': 'Неудачная попытка входа',
  'access-request': 'Запрос доступа',
  'access-allow': 'Доступ разрешён',
  'access-deny': 'Запрос отклонён',
  'access-revoke': 'Доступ отозван',
  'access-delete': 'Запись о доступе удалена',
  'access-role': 'Смена роли',
  'round-set': 'Обход: отметки',
  'round-change': 'Обход: смена статуса',
  data: 'Изменение данных',
  promotion: 'Переход на новый учебный год',
  clear: 'Очистка данных',
  settings: 'Настройки',
  seed: 'Загрузка базы',
  export: 'Выгрузка в Excel',
  'push-rejected': 'Изменения отклонены',
};
// Группы для фильтра: важное по смыслу, а не 17 кодов подряд.
export const EVENT_GROUPS = [
  { key: 'rounds', label: 'Обход', events: ['round-set', 'round-change'] },
  { key: 'access', label: 'Доступ и вход', events: ['login', 'login-failed', 'access-request', 'access-allow', 'access-deny', 'access-revoke', 'access-delete', 'access-role'] },
  { key: 'export', label: 'Выгрузки', events: ['export'] },
  { key: 'admin', label: 'Данные и настройки', events: ['data', 'promotion', 'clear', 'settings', 'seed', 'push-rejected'] },
];
export const ROLE_LABEL = { admin: 'Администратор', user: 'Дежурный', '': '' };

const STORE_LABEL = { students: 'ученики', staff: 'персонал', classes: 'классы', enrollments: 'зачисления', assignments: 'назначения', years: 'годы', days: 'календарь', promotions: 'переходы' };
const kindLabel = (k) => (ROUND_KINDS.find((x) => x.key === k) || { label: 'Вечер' }).label;
const shortDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : iso || '');

/** Разбор строки журнала от сервера: [номер, время ISO, событие, кто, роль, код, объект, подробности JSON]. */
export function parseAuditRow(row) {
  let d = {};
  try { d = JSON.parse(row[7] || '{}') || {}; } catch { d = {}; }
  return { row: row[0], at: row[1], event: row[2], actor: row[3], role: row[4], code: row[5], target: row[6], details: d };
}

/** Что произошло — одной строкой. state нужен, чтобы вместо ID показать ФИО ученика. */
export function describeAudit(e, state) {
  const d = e.details || {};
  const student = (id) => { const s = (state.students || []).find((x) => x.id === id); return s ? fullName(s) : 'ученик'; };
  switch (e.event) {
    case 'round-set': {
      const parts = [`отмечено ${d.set || 0}`];
      if (d.changed) parts.push(`изменено ${d.changed}`);
      if (d.cleared) parts.push(`снято ${d.cleared}`);
      if (d.reasons) parts.push(`причин ${d.reasons}`);
      return `${kindLabel(d.kind)} ${shortDate(d.date)}: ${parts.join(', ')}${d.classes ? `; классов: ${d.classes}` : ''}`;
    }
    case 'round-change': return `${student(d.studentId)}: ${ROUND_LABEL[d.from] || d.from} → ${ROUND_LABEL[d.to] || d.to} (${e.target})`;
    case 'data': return Object.entries(d).map(([k, v]) => `${STORE_LABEL[k] || k}: +${v.put || 0}${v.del ? ` −${v.del}` : ''}`).join('; ');
    case 'export': return `${e.target}${d.from ? `, ${shortDate(d.from)}${d.to && d.to !== d.from ? `–${shortDate(d.to)}` : ''}` : ''}, строк: ${d.rows ?? 0}`;
    case 'access-request': return `${e.target}${d.wantRole === 'admin' ? ' (просит роль администратора)' : ''}`;
    case 'access-allow': return `${e.target}: ${ROLE_LABEL[d.role] || 'дежурный'}`;
    case 'access-role': return `${e.target}: теперь ${(ROLE_LABEL[d.role] || '').toLowerCase()}`;
    case 'access-deny': case 'access-revoke': case 'access-delete': return e.target;
    case 'clear': return `очищено: ${e.target}`;
    case 'settings': return `изменено: ${e.target}`;
    case 'seed': return `учеников: ${d.students ?? 0}`;
    case 'push-rejected': return `пакетов отклонено: ${d.batches ?? 0}`;
    default: return e.target || '';
  }
}
