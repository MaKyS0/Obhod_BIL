// Общие элементы страниц.
import { h } from './dom.js';
import { fullName } from '../domain/people.js';
import { yearLabel } from '../domain/years.js';

export function pageHead({ title, sub, actions = [], crumbs = null }) {
  return h(
    'div',
    { class: 'pagehead' },
    h('div', null, crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

export const btn = (label, onclick, kind = '', extra = {}) => h('button', { type: 'button', class: `btn ${kind ? `btn-${kind}` : ''}`.trim(), onclick, ...extra }, label);
export const link = (label, href, kind = '') => h('a', { class: `btn ${kind ? `btn-${kind}` : ''}`.trim(), href }, label);

export function classLink(cls, text) {
  return cls ? h('a', { href: `#/class/${encodeURIComponent(cls.id)}` }, text || cls.name) : h('span', { class: 'muted' }, '—');
}

export const personName = (p) => (p ? fullName(p) : h('span', { class: 'muted' }, 'не назначен'));
export const yl = yearLabel;

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}`.trim() }, text);
}

export function demoBadge(rec) {
  return rec && rec.demo ? badge('DEMO', 'demo') : null;
}

export function emptyState(title, text, actions = []) {
  return h('div', { class: 'empty' }, h('h3', null, title), text ? h('p', null, text) : null, actions.length ? h('div', { class: 'actions' }, actions) : null);
}

export function notice(kind, ...children) {
  return h('div', { class: `notice ${kind}` }, children);
}

export function studentStatusBadge(student, enr) {
  if (student.status === 'graduated') return badge('Выпускник', 'info');
  if (student.status === 'left') return badge('Выбыл', 'warn');
  if (enr && enr.status === 'pending-graduation') return badge('Ожидает выпуска', 'warn');
  if (enr && !enr.classId) return badge('Без класса', 'warn');
  return badge('Учится', 'ok');
}
