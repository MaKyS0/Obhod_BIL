// Правила интерфейса: один набор иконок (без emoji и символов-иконок в коде), системное название в одном месте.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_NAMES } from '../../js/ui/icons.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => path.join(dir, f));

test('интерфейс: в коде нет emoji и символов-иконок (стрелки, значки, геометрия) — только svg-иконки из js/ui/icons.js', () => {
  // Текстовые стрелки «7A → 8A» в тексте допустимы; символы-иконки (значки, геометрия, emoji) — нет.
  const bad = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FF0B}]/u;
  const hits = [];
  for (const f of [...files('js'), ...files('css'), 'index.html'].filter((x) => !x.endsWith('icons.js'))) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return; // комментарии не в счёт
      const m = line.match(bad);
      if (m) hits.push(`${f}:${i + 1} «${m[0]}»`);
    });
  }
  assert.deepEqual(hits, []);
});

test('интерфейс: все иконки, на которые ссылается код, существуют в наборе', () => {
  const used = new Set();
  for (const f of files('js')) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/icon\(\s*'([a-z-]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/icon: '([a-z-]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/'(home|moon|layers|users|badge|calendar-next|history|chart|archive|swap|shield)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((n) => !ICON_NAMES.includes(n));
  assert.deepEqual(missing, [], `нет в наборе: ${missing}`);
  assert.ok(ICON_NAMES.length >= 40);
});

test('интерфейс: цвета в компонентах берутся из токенов (нет «голых» hex вне base.css/dark.css/animations.css, кроме белого и оттенков кнопок)', () => {
  const allowed = new Set(['#fff', '#ffffff']);
  const hits = [];
  for (const f of ['css/components.css', 'css/layout.css', 'css/pages.css']) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,6}\b/g)) if (!allowed.has(m[0].toLowerCase()) && !/var\(--/.test(line.slice(0, m.index))) hits.push(`${f}:${i + 1} ${m[0]}`);
    });
  }
  // допустимо ограниченное число служебных оттенков (тосты, предупреждающий акцент, плейсхолдер); новые «случайные» цвета ловит тест
  assert.ok(hits.length <= 14, `слишком много «голых» цветов (${hits.length}): ${hits.join(', ')}`);
});

test('интерфейс: нет «ленивых» цветных полосок с одного края блока (border-left/top толще 1px) и градиентов/стекла', () => {
  const hits = [];
  for (const f of files('css')) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*\/\*/.test(line)) return;
      if (/border-(left|right|top)(-width)?:\s*[2-9]px(?!\s*solid\s*transparent)/.test(line) && !/border-(left|right|top):\s*[2-9]px solid transparent/.test(line)) hits.push(`${f}:${i + 1} полоска с края`);
      if (/gradient\(|backdrop-filter/.test(line)) hits.push(`${f}:${i + 1} градиент/стекло`);
    });
  }
  assert.deepEqual(hits, []);
});
