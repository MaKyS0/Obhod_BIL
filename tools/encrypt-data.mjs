// Шифрует JSON-файл с данными лицея для публикации в репозитории.
//   LYCEUM_PASS='ваш-пароль' node tools/encrypt-data.mjs вход.json выход.enc.json
//   LYCEUM_PASS='ваш-пароль' node tools/encrypt-data.mjs --check выход.enc.json   (проверка: расшифровать и показать счётчики)
// Пароль берётся только из переменной окружения и нигде не сохраняется.
import fs from 'node:fs';
import { encryptJson, decryptJson } from '../js/domain/crypto-box.js';

const pass = process.env.LYCEUM_PASS;
const args = process.argv.slice(2);
if (!pass) {
  console.error('Укажите пароль в переменной окружения LYCEUM_PASS');
  process.exit(2);
}
if (args[0] === '--check') {
  const data = await decryptJson(JSON.parse(fs.readFileSync(args[1], 'utf8')), pass);
  console.log(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v])));
} else {
  const [input, output] = args;
  if (!input || !output) {
    console.error('Использование: node encrypt-data.mjs вход.json выход.enc.json');
    process.exit(2);
  }
  const box = await encryptJson(JSON.parse(fs.readFileSync(input, 'utf8')), pass);
  fs.writeFileSync(output, JSON.stringify(box));
  console.log(`Готово: ${output} (${fs.statSync(output).size} байт)`);
}
