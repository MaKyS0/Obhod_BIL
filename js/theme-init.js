// Тема оформления применяется до первой отрисовки (классический скрипт в <head>), чтобы страница не мигала светлым.
// Выбор хранится в localStorage: 'auto' (как в системе) | 'light' | 'dark'.
(function () {
  var pref = 'auto';
  try { pref = localStorage.getItem('lyceum-theme') || 'auto'; } catch (e) { /* хранилище недоступно — «как в системе» */ }
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themePref = pref;
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Автотесты (WebDriver) работают без анимации; экран загрузки скрывается сразу. Включить — window.__LYCEUM_ANIMATE__ = true.
  if (navigator.webdriver && window.__LYCEUM_ANIMATE__ !== true) root.classList.add('no-anim');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0c121a' : '#1f4e79');
})();
