import test from 'node:test';
import assert from 'node:assert/strict';
import { allowReload } from '../../js/core/reload-guard.js';

const fake = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test('перезагрузки: три за минуту разрешены, четвёртая — нет; через минуту счёт обнуляется', () => {
  const st = fake();
  assert.deepEqual([1, 2, 3].map((i) => allowReload(st, 1000 + i)), [true, true, true]);
  assert.equal(allowReload(st, 2000), false);
  assert.equal(allowReload(st, 1000 + 61000), true);
});
test('перезагрузки: испорченное хранилище не мешает', () => {
  const st = fake();
  st.setItem('lyceum-reloads', 'не json');
  assert.equal(allowReload(st, 5), true);
});
