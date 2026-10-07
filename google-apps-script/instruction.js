// Загружает Code.gs на страницу инструкции и добавляет кнопку «Скопировать».
const pre = document.getElementById('code');
const btn = document.getElementById('copyCode');
fetch('Code.gs')
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((t) => { pre.textContent = t; })
  .catch((e) => { pre.textContent = `Не удалось загрузить Code.gs (${e.message}). Откройте файл Code.gs в репозитории.`; });
btn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(pre.textContent);
    btn.textContent = 'Скопировано ✓';
  } catch {
    const r = document.createRange();
    r.selectNodeContents(pre);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    btn.textContent = 'Выделено — нажмите Ctrl+C';
  }
  setTimeout(() => (btn.textContent = 'Скопировать код'), 3000);
});
