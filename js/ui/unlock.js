// Запрос пароля и расшифровка файла с данными. Возвращает расшифрованный объект или null при отмене.
import { h } from './dom.js';
import { openModal } from './modal.js';
import { field } from './form.js';
import { decryptJson } from '../domain/crypto-box.js';

export function unlockBox(box, note = 'Файл с данными лицея зашифрован. Введите пароль — расшифровка выполняется только в вашем браузере.') {
  return new Promise((resolve) => {
    let data = null;
    const pass = field({ label: 'Пароль', name: 'unlockPass', type: 'password', autocomplete: 'off', attrs: { 'aria-label': 'Пароль для расшифровки' } });
    openModal({
      title: 'Зашифрованные данные',
      body: h('div', null, h('p', { class: 'muted' }, note), pass.el),
      actions: [
        { label: 'Отмена', kind: 'secondary' },
        { label: 'Расшифровать', kind: 'primary', run: async () => {
          data = await decryptJson(box, pass.get());
        } },
      ],
      onClose: () => resolve(data),
    });
  });
}
