import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, seed } from './helpers.mjs';
import { syncNow, isEmptyDb } from '../../js/services/sync.js';

test('синхронизация: пустая база не отправляется (защита таблицы), непустая — отправляется', async () => {
  const env = await makeEnv();
  await env.repo.updateSettings({ sheetsUrl: 'https://script.google.com/macros/s/TEST/exec', sheetsToken: 'tok' });
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { text: async () => JSON.stringify({ ok: true, written: {} }) }; };
  assert.equal(isEmptyDb(env.S()), true);
  const r = await syncNow(env.store, env.repo);
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
  assert.equal(calls.length, 0, 'запрос не уходил');
  const forced = await syncNow(env.store, env.repo, { allowEmpty: true });
  assert.equal(forced.ok, true, 'явное разрешение отправляет и пустую базу');
  assert.equal(calls.length, 1);
  await seed(env, 1);
  const ok = await syncNow(env.store, env.repo);
  assert.equal(ok.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sheets['Ученики'].rows.length, 15);
});
