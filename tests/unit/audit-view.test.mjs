import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditRow, describeAudit, EVENT_LABELS, EVENT_GROUPS } from '../../js/domain/audit-view.js';

const state = { students: [{ id: 's1', lastName: 'Иванов', firstName: 'Иван', middleName: '' }] };
const row = (event, details, target = '', actor = 'Завуч', role = 'admin') => [7, '2026-10-08T14:00:00.000Z', event, actor, role, 'abc', target, JSON.stringify(details)];

test('журнал: расшифровка событий человеческим языком, ФИО подставляется из базы', () => {
  const t = (r) => describeAudit(parseAuditRow(r), state);
  assert.equal(t(row('round-set', { date: '2026-10-08', kind: 'evening', set: 12, changed: 1, cleared: 0, classes: 3 })), 'Вечер 08.10: отмечено 12, изменено 1; классов: 3');
  assert.equal(t(row('round-change', { studentId: 's1', from: 'sleeping', to: 'sick' }, '2026-10-08 morning')), 'Иванов Иван: Ночует → Болеет (2026-10-08 morning)');
  assert.equal(t(row('data', { students: { put: 3, del: 1 }, days: { put: 1, del: 0 } })), 'ученики: +3 −1; календарь: +1');
  assert.equal(t(row('export', { from: '2026-10-01', to: '2026-10-08', rows: 240 }, 'round-report')), 'round-report, 01.10–08.10, строк: 240');
  assert.equal(t(row('access-allow', { role: 'admin' }, 'Мария')), 'Мария: Администратор');
  assert.equal(t(row('round-change', { studentId: 'нет', from: 'home', to: 'absent' }, 'x')), 'ученик: С дома → Отсутствует (x)');
  assert.equal(parseAuditRow([1, 'x', 'login', 'a', 'user', 'c', '', 'не json']).details.constructor, Object, 'битые подробности не ломают разбор');
});

test('журнал: у каждого события есть название, группы фильтра покрывают все события', () => {
  const inGroups = new Set(EVENT_GROUPS.flatMap((g) => g.events));
  for (const e of Object.keys(EVENT_LABELS)) assert.ok(inGroups.has(e), `событие ${e} есть в группах фильтра`);
  for (const e of inGroups) assert.ok(EVENT_LABELS[e], `у события ${e} есть название`);
});
