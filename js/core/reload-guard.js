// Защита от бесконечных перезагрузок: сайт сам перезагружает страницу, когда меняется доступ или роль.
// Если такое случилось 3 раза за минуту, значит что-то не так (например, устаревший скрипт Google) — останавливаемся и объясняем.
const KEY = 'lyceum-reloads';
const LIMIT = 3;
const WINDOW_MS = 60000;

/** Можно ли перезагрузить ещё раз? Запоминает попытку в storage (sessionStorage). Чистая логика — для тестов. */
export function allowReload(storage, now = Date.now()) {
  let log = [];
  try { log = JSON.parse(storage.getItem(KEY) || '[]').filter((t) => typeof t === 'number' && now - t < WINDOW_MS); } catch { log = []; }
  if (log.length >= LIMIT) return false;
  log.push(now);
  try { storage.setItem(KEY, JSON.stringify(log)); } catch { /* хранилище недоступно — защиты нет, но и ошибки тоже */ }
  return true;
}

export function resetReloads(storage) { try { storage.removeItem(KEY); } catch { /* ignore */ } }

/** Перезагрузка страницы с защитой от петли. reason — для сообщения. */
export function safeReload(reason = '') {
  let storage = null;
  try { storage = window.sessionStorage; } catch { /* нет хранилища */ }
  if (!storage || allowReload(storage)) { location.reload(); return true; }
  document.getElementById('splash')?.remove();
  const view = document.getElementById('view') || document.body;
  const box = document.createElement('div');
  box.className = 'notice danger';
  box.id = 'reloadLoop';
  const text = document.createElement('p');
  text.textContent = `Сайт несколько раз подряд обновился сам${reason ? ` (причина: ${reason})` : ''}, поэтому автоматическое обновление остановлено. Чаще всего так бывает, когда скрипт Google ещё не обновлён или доступ изменили во время работы.`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = 'Попробовать ещё раз';
  btn.addEventListener('click', () => { resetReloads(storage); location.reload(); });
  box.append(text, btn);
  view.replaceChildren(box);
  document.body.classList.remove('gated');
  return false;
}
