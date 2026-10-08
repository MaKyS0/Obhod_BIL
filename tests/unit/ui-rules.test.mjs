// Правила интерфейса: один набор иконок (без emoji и символов-иконок в коде), системное название в одном месте.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_NAMES } from '../../js/ui/icons.js';
import { LOGO_ORNAMENT, LOGO_BIRD } from '../../js/ui/logo.js';

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

test('логотип: эмблема на экране загрузки (index.html) и в js/ui/logo.js одна и та же', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const splash = html.slice(html.indexOf('<svg class="splash-logo'), html.indexOf('</svg>', html.indexOf('<svg class="splash-logo')));
  const orn = [...splash.matchAll(/class="lg-orn o\d+" d="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(orn, LOGO_ORNAMENT);
  assert.equal(/class="lg-bird" d="([^"]+)"/.exec(splash)[1], LOGO_BIRD);
  assert.equal(LOGO_ORNAMENT.length, 10);
});

test('контраст: приглушённые цвета текста проходят WCAG AA (4,5:1) на своих фонах в светлой и тёмной темах', () => {
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const tokens = (css) => Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
  const base = tokens(fs.readFileSync(path.join(ROOT, 'css/base.css'), 'utf8'));
  const dark = { ...base, ...tokens(fs.readFileSync(path.join(ROOT, 'css/dark.css'), 'utf8')) };
  const pairs = [['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'], ['text-2', 'bg'], ['side-muted', 'side-bg'], ['side-muted', 'side-hover'], ['side-muted', 'side-active'], ['primary', 'surface'], ['warning', 'warning-weak'], ['danger', 'danger-weak'], ['success', 'success-weak']];
  const low = [];
  for (const [name, set] of [['светлая', base], ['тёмная', dark]]) for (const [fg, bg] of pairs) if (ratio(set[fg], set[bg]) < 4.5) low.push(`${name}: --${fg} на --${bg} = ${ratio(set[fg], set[bg]).toFixed(2)}`);
  assert.deepEqual(low, []);
});
