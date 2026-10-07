// Единый набор иконок интерфейса: линейные, 24×24, штрих 1.75. Рисуются как SVG, цвет берут из текста (currentColor).
// Других иконок и emoji на сайте нет: новую иконку добавляйте сюда.
const NS = 'http://www.w3.org/2000/svg';

// Каждая иконка — список фигур: строка = <path d>, массив ['c', cx, cy, r] = круг, ['r', x, y, w, h, rx] = прямоугольник.
const SHAPES = {
  home: ['M4 11.2 12 4l8 7.2', 'M6 10v9.5h4.5V14h3v5.5H18V10'],
  moon: ['M19.5 14.6A7.6 7.6 0 0 1 9.4 4.5a7.6 7.6 0 1 0 10.1 10.1Z'],
  layers: ['M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z', 'M3.5 12 12 16.5 20.5 12', 'M3.5 16 12 20.5 20.5 16'],
  users: [['c', 9, 8.5, 3.2], 'M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5', ['c', 17, 9.5, 2.5], 'M17.5 14c2.4.2 4 2 4 4.5'],
  badge: [['r', 4, 3.5, 16, 17, 2.5], ['c', 12, 10, 2.4], 'M7.8 17c.5-2 2.3-3 4.2-3s3.7 1 4.2 3'],
  calendar: [['r', 3.5, 5, 17, 15, 2.5], 'M3.5 10h17', 'M8 3v4', 'M16 3v4', 'M8 14.5h3', 'M13 14.5h3'],
  'calendar-next': [['r', 3.5, 5, 17, 15, 2.5], 'M3.5 10h17', 'M8 3v4', 'M16 3v4', 'M9 15h6', 'M13 12.5 15.5 15 13 17.5'],
  history: ['M3.8 12a8.2 8.2 0 1 0 2.5-5.9', 'M3.8 4.5v4.2h4.2', 'M12 7.8V12l3 1.8'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M21 20H3'],
  archive: [['r', 3.5, 4, 17, 4.5, 1.2], 'M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5', 'M9.5 12.5h5'],
  swap: ['M5 8h13', 'M15 4.5 18.5 8 15 11.5', 'M19 16H6', 'M9 12.5 5.5 16 9 19.5'],
  shield: ['M12 3.2 19.5 6v5.6c0 4.4-3 7.7-7.5 9.2-4.5-1.5-7.5-4.8-7.5-9.2V6L12 3.2Z', 'm8.8 12 2.3 2.3 4.2-4.6'],
  sliders: ['M4 7h9', 'M17 7h3', ['c', 15, 7, 2], 'M4 17h3', 'M11 17h9', ['c', 9, 17, 2], 'M4 12h16'],
  search: [['c', 10.5, 10.5, 6], 'm15 15 5 5'],
  plus: ['M12 5v14', 'M5 12h14'],
  edit: ['M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z', 'm13.5 8.5 3 3'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12', 'M10 11v6', 'M14 11v6'],
  move: ['M4 8h13', 'm14 5 3 3-3 3', 'M20 16H7', 'm10 13-3 3 3 3'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  'chevron-down': ['m6 9.5 6 6 6-6'],
  'chevron-up': ['m6 14.5 6-6 6 6'],
  'chevron-left': ['m14.5 6-6 6 6 6'],
  'chevron-right': ['m9.5 6 6 6-6 6'],
  alert: ['M12 4 21 19.5H3L12 4Z', 'M12 10v4.5', 'M12 17.2v.1'],
  info: [['c', 12, 12, 8.5], 'M12 11v5.5', 'M12 7.8v.1'],
  refresh: ['M19.5 9A8 8 0 0 0 5 7.5', 'M5 3.8v3.9h3.9', 'M4.5 15A8 8 0 0 0 19 16.5', 'M19 20.2v-3.9h-3.9'],
  download: ['M12 4v11', 'm7.5 11 4.5 4.5 4.5-4.5', 'M5 19.5h14'],
  upload: ['M12 15.5V4.5', 'm7.5 9 4.5-4.5L16.5 9', 'M5 19.5h14'],
  cloud: ['M7 18.5a4.2 4.2 0 0 1-.6-8.4A5.6 5.6 0 0 1 17 8.9a4.8 4.8 0 0 1 .5 9.6H7Z'],
  'cloud-off': ['M7 18.5a4.2 4.2 0 0 1-.6-8.4c.2-.7.5-1.3.9-1.9', 'M10.5 5.6A5.6 5.6 0 0 1 17 8.9a4.8 4.8 0 0 1 2.3 8.4', 'M7 18.5h9.5', 'M4 4l16 16'],
  sun: [['c', 12, 12, 3.8], 'M12 3v2', 'M12 19v2', 'M3 12h2', 'M19 12h2', 'm5.6 5.6 1.4 1.4', 'm17 17 1.4 1.4', 'm18.4 5.6-1.4 1.4', 'M7 17l-1.4 1.4'],
  monitor: [['r', 3.5, 4.5, 17, 11.5, 2], 'M9 20h6', 'M12 16v4'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  filter: ['M4 5.5h16l-6 7.2V19l-4 1.5v-7.8L4 5.5Z'],
  more: [['c', 5.5, 12, 1.2], ['c', 12, 12, 1.2], ['c', 18.5, 12, 1.2]],
  external: ['M14 4h6v6', 'M20 4 11 13', 'M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
  'user-plus': [['c', 9.5, 8.5, 3.2], 'M3.5 19.5c0-3.3 2.6-5.5 6-5.5 1.4 0 2.6.3 3.6 1', 'M18 10v6', 'M15 13h6'],
  key: [['c', 8, 14.5, 3.5], 'M10.5 12 19 3.5', 'M15.5 7l2.5 2.5', 'M13.5 9 15 10.5'],
  lock: [['r', 5, 10.5, 14, 9.5, 2], 'M8 10.5V8a4 4 0 0 1 8 0v2.5'],
  clock: [['c', 12, 12, 8.5], 'M12 7.5V12l3 2'],
  file: ['M6.5 3.5h7L19 9v10.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-14.5A1.5 1.5 0 0 1 6.5 3.5Z', 'M13.5 3.5V9H19', 'M8.5 13h7', 'M8.5 16.5h7'],
  database: [['e', 12, 6, 7.5, 2.8], 'M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6', 'M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8'],
  printer: ['M7 9V4h10v5', ['r', 4, 9, 16, 8, 2], 'M7 14h10v6H7z'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z', ['c', 12, 12, 2.8]],
  undo: ['M9 7 4.5 11.5 9 16', 'M5 11.5h8.5a5.5 5.5 0 0 1 0 11'],
  code: ['m8.5 8-4 4 4 4', 'm15.5 8 4 4-4 4'],
  sort: ['M8 4v16', 'm4.5 7.5 3.5-3.5 3.5 3.5', 'M16 20V4', 'm12.5 16.5 3.5 3.5 3.5-3.5'],
  'sort-up': ['M12 19V5', 'm6.5 10.5 5.5-5.5 5.5 5.5'],
  'sort-down': ['M12 5v14', 'm6.5 13.5 5.5 5.5 5.5-5.5'],
  graduation: ['M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5Z', 'M6.5 11.8V16c0 1.5 2.5 3 5.5 3s5.5-1.5 5.5-3v-4.2', 'M21.5 9.5V15'],
};

/** Иконка как элемент <svg>. size — в пикселях (по умолчанию 18). Скрыта от скринридеров: смысл всегда дублирует текст/aria-label. */
export function icon(name, size = 18) {
  const shapes = SHAPES[name];
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `ico ico-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const s of shapes || []) {
    let el;
    if (typeof s === 'string') {
      el = document.createElementNS(NS, 'path');
      el.setAttribute('d', s);
    } else if (s[0] === 'c') {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', s[1]);
      el.setAttribute('cy', s[2]);
      el.setAttribute('r', s[3]);
    } else if (s[0] === 'e') {
      el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', s[1]);
      el.setAttribute('cy', s[2]);
      el.setAttribute('rx', s[3]);
      el.setAttribute('ry', s[4]);
    } else {
      el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', s[1]);
      el.setAttribute('y', s[2]);
      el.setAttribute('width', s[3]);
      el.setAttribute('height', s[4]);
      el.setAttribute('rx', s[5] || 0);
    }
    svg.appendChild(el);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(SHAPES);
