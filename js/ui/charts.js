// Графики на Chart.js (локальная копия в vendor/). Без библиотеки показывается обычная таблица.
import { h } from './dom.js';

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/**
 * Возвращает { el, destroy }. config: { labels, data, label, horizontal, title }
 */
export function barChart({ labels, data, label = 'Учеников', horizontal = false, title = '', tall = false }) {
  const box = h('div', { class: `chart-box${tall ? ' tall' : ''}` });
  if (!window.Chart) {
    box.className = '';
    box.appendChild(h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, title || 'Показатель'), h('th', { class: 'num' }, label))), h('tbody', null, labels.map((l, i) => h('tr', null, h('td', null, l), h('td', { class: 'num' }, data[i]))))));
    return { el: box, destroy() {} };
  }
  const canvas = h('canvas', { role: 'img', 'aria-label': `${title}: ${labels.map((l, i) => `${l} — ${data[i]}`).join(', ')}` });
  box.appendChild(canvas);
  const primary = css('--chart-bar', css('--primary', '#1f4e79'));
  const grid = css('--chart-grid', '#e6e9ee');
  const text = css('--chart-text', '#5a6473');
  const chart = new window.Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: primary, borderRadius: 2, maxBarThickness: horizontal ? 18 : 48 }] },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${label}: ${c.parsed[horizontal ? 'x' : 'y']}` } } },
      scales: {
        [horizontal ? 'x' : 'y']: { beginAtZero: true, ticks: { precision: 0, color: text }, grid: { color: grid } },
        [horizontal ? 'y' : 'x']: { grid: { display: false }, ticks: { color: text } },
      },
    },
  });
  return { el: box, destroy: () => chart.destroy() };
}
