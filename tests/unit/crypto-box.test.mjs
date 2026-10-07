import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptJson, decryptJson, isEncryptedBox } from '../../js/domain/crypto-box.js';

test('шифрование: туда и обратно, неверный пароль, порча данных, разные соли', async () => {
  const data = { students: [{ fio: 'Образцов Образец', class: '7A', birthDate: '2013-04-05' }] };
  const box = await encryptJson(data, 'пароль-для-теста-123', { iterations: 1000 });
  assert.ok(isEncryptedBox(box));
  assert.ok(!JSON.stringify(box).includes('Образцов'), 'открытого текста в файле нет');
  assert.deepEqual(await decryptJson(box, 'пароль-для-теста-123'), data);
  await assert.rejects(() => decryptJson(box, 'другой-пароль-123'), /Неверный пароль/);
  const broken = { ...box, ct: box.ct.slice(0, -4) + 'AAAA' };
  await assert.rejects(() => decryptJson(broken, 'пароль-для-теста-123'), /Неверный пароль или файл повреждён/);
  const box2 = await encryptJson(data, 'пароль-для-теста-123', { iterations: 1000 });
  assert.notEqual(box.ct, box2.ct);
  assert.notEqual(box.salt, box2.salt);
  await assert.rejects(() => encryptJson(data, 'коротк'), /короткий/);
  await assert.rejects(() => decryptJson({ format: 'x' }, 'p'), /не зашифрованный/);
});
