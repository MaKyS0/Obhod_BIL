// Общие элементы страниц.
import { h } from './dom.js';
import { fullName } from '../domain/people.js';
import { yearLabel } from '../domain/years.js';
import { icon } from './icons.js';

export function pageHead({ title, sub, actions = [], crumbs = null }) {
  return h(
    'div',
    { class: 'pagehead' },
    h('div', null, crumbs ? h('div', { class: 'crumbs' }, crumbs) : null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  );
}

// Кнопки. kind: '' (вторичная) | primary | danger | danger-outline | ghost, плюс sm / lg. extra.icon — имя иконки слева;
// пустая подпись + icon = кнопка-иконка (обязательно передайте 'aria-label').
const btnClass = (kind, iconOnly) => `btn${kind ? ' ' + kind.split(' ').map((k) => `btn-${k}`).join(' ') : ''}${iconOnly ? ' btn-icon' : ''}`;
function btnContent(label, ic) {
  return [ic ? icon(ic, 16) : null, label ? (ic ? h('span', null, label) : label) : null];
}
export const btn = (label, onclick, kind = '', extra = {}) => {
  const { icon: ic, ...attrs } = extra;
  // С иконкой подпись может скрываться на узких экранах (CSS), поэтому имя кнопки дублируем в aria-label и подсказку.
  const names = ic && label ? { 'aria-label': label, title: label } : {};
  return h('button', { type: 'button', class: btnClass(kind, !label && !!ic), onclick, ...names, ...attrs }, btnContent(label, ic));
};
export const link = (label, href, kind = '', extra = {}) => {
  const { icon: ic, ...attrs } = extra;
  const names = ic && label ? { 'aria-label': label, title: label } : {};
  return h('a', { class: btnClass(kind, !label && !!ic), href, ...names, ...attrs }, btnContent(label, ic));
};

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

export function emptyState(title, text, actions = [], ic = 'info') {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon(ic, 20)), h('h3', null, title), text ? h('p', null, text) : null, actions.length ? h('div', { class: 'actions' }, actions) : null);
}

const NOTICE_ICON = { info: 'info', warn: 'alert', danger: 'alert', ok: 'check' };
export function notice(kind, ...children) {
  return h('div', { class: `notice ${kind}` }, icon(NOTICE_ICON[kind] || 'info', 16), h('div', { class: 'notice-body' }, children));
}

export function studentStatusBadge(student, enr) {
  if (student.status === 'graduated') return badge('Выпускник', 'info');
  if (student.status === 'left') return badge('Выбыл', 'warn');
  if (enr && enr.status === 'pending-graduation') return badge('Ожидает выпуска', 'warn');
  if (enr && !enr.classId) return badge('Без класса', 'warn');
  return badge('Учится', 'ok');
}
