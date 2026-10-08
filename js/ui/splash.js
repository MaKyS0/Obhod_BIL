// Экран загрузки: логотип «БИЛ» рисуется штрихами, под ним — название и состояние запуска. Разметка лежит в index.html (видна до запуска скриптов).
// Показывается не короче MIN_MS, чтобы анимация успела сыграть; нажатие или клавиша пропускают её. Без анимации (автотесты, «уменьшить движение») скрыт CSS.
import { animationsOn } from './anim.js';

// Полная анимация — при первом открытии в этой вкладке; при перезагрузках в той же вкладке экран короткий (человек уже его видел).
const seen = () => { try { const s = sessionStorage.getItem('lyceum-splash') === '1'; sessionStorage.setItem('lyceum-splash', '1'); return s; } catch { return false; } };
const MIN_MS = (again) => (typeof globalThis.__LYCEUM_SPLASH_MS__ === 'number' ? globalThis.__LYCEUM_SPLASH_MS__ : again ? 700 : 1900);

export function createSplash() {
  const el = document.getElementById('splash');
  if (!el) return { status() {}, hide() {} };
  const t0 = performance.now();
  const again = seen();
  let skip = false;
  let hiding = false;
  const onSkip = () => { skip = true; };
  el.addEventListener('pointerdown', onSkip);
  document.addEventListener('keydown', onSkip, { once: true });
  return {
    /** Текущий этап запуска («Читаем данные…»). */
    status(text) {
      const s = el.querySelector('#splashStatus');
      if (s) s.textContent = text;
    },
    /** Убирает экран, когда приложение готово и анимация доиграла. Повторные вызовы безопасны. */
    hide() {
      if (hiding) return;
      hiding = true;
      const wait = skip || !animationsOn() ? 0 : Math.max(0, MIN_MS(again) - (performance.now() - t0));
      setTimeout(() => {
        if (!animationsOn()) { el.remove(); return; }
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 600);
      }, wait);
    },
  };
}
