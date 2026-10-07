// Переключение темы: «Как в системе» / «Светлая» / «Тёмная». Применение до отрисовки — js/theme-init.js.
export const THEMES = [
  { key: 'auto', label: 'Как в системе', icon: '◐' },
  { key: 'light', label: 'Светлая', icon: '☀' },
  { key: 'dark', label: 'Тёмная', icon: '☾' },
];
const KEY = 'lyceum-theme';
const root = document.documentElement;
const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set();

export function getPref() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.key === v) ? v : 'auto';
  } catch {
    return root.dataset.themePref || 'auto';
  }
}

export const isDark = () => root.dataset.theme === 'dark';

function apply(pref, animate) {
  const dark = pref === 'dark' || (pref === 'auto' && !!mq && mq.matches);
  if (animate && !root.classList.contains('no-anim')) {
    root.classList.add('theme-fade'); // плавная смена цветов на время переключения
    setTimeout(() => root.classList.remove('theme-fade'), 450);
  }
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themePref = pref;
  root.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0c121a' : '#1f4e79');
  listeners.forEach((fn) => fn({ pref, dark }));
}

export function setPref(pref) {
  if (!THEMES.some((t) => t.key === pref)) return;
  try {
    localStorage.setItem(KEY, pref);
  } catch { /* без хранилища тема действует до закрытия страницы */ }
  apply(pref, true);
}

export const cyclePref = () => setPref(THEMES[(THEMES.findIndex((t) => t.key === getPref()) + 1) % THEMES.length].key);

/** Подписка на смену темы (перерисовать графики и т. п.). */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// «Как в системе»: следим за переключением темы в самой системе, а также за выбором в другой вкладке.
if (mq) mq.addEventListener?.('change', () => getPref() === 'auto' && apply('auto', true));
window.addEventListener('storage', (e) => e.key === KEY && apply(getPref(), true));
