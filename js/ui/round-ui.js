// Общие детали интерфейса обхода: значок статуса, время отметки, текст «кто и когда».
import { h } from './dom.js';
import { badge } from './common.js';
import { ROUND_LABEL } from '../domain/rounds.js';

const KIND = { sleeping: 'ok', sick: 'danger', home: 'warn', absent: 'danger' };
export const placeBadge = (place) => (place ? badge(ROUND_LABEL[place] || place, KIND[place] || '') : h('span', { class: 'muted' }, 'Не отмечен'));

const pad = (n) => String(n).padStart(2, '0');
/** 21:05 — время отметки в часовом поясе устройства; пусто, если времени нет. */
export function hm(iso) {
  const d = new Date(iso);
  return iso && !Number.isNaN(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}
/** «21:05 · Петрова» (фамилия и инициал ответственного не нужны — показываем имя как записал сервер). */
export const whenBy = (iso, by) => [hm(iso), by].filter(Boolean).join(' · ');
