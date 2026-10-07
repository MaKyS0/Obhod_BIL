// Небольшие помощники для анимации. Всё отключается, если включено «уменьшить движение» или html.no-anim (автотесты).
export const animationsOn = () => !document.documentElement.classList.contains('no-anim') && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

/** Блоки страницы появляются по очереди: задаём каждому номер для задержки. */
export function enterPage(view) {
  if (!animationsOn()) return;
  [...view.children].slice(0, 12).forEach((c, i) => c.style.setProperty('--i', String(i)));
  view.classList.remove('page-enter');
  void view.offsetWidth; // перезапуск анимации
  view.classList.add('page-enter');
}

/** Числа на главной «набираются» от нуля. Итоговый текст всегда точный. */
export function countUp(root, selector = '.stat .value', ms = 700) {
  if (!animationsOn()) return;
  for (const el of root.querySelectorAll(selector)) {
    const to = Number(el.textContent.replace(/\s/g, ''));
    if (!Number.isFinite(to) || to < 2 || to > 1e7) continue;
    const text = el.textContent;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = k >= 1 ? text : String(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
      else el.textContent = text;
    };
    el.textContent = '0';
    requestAnimationFrame(step);
  }
}
