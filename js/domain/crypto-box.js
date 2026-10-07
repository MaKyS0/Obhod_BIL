// Шифрование наборов данных: AES-256-GCM, ключ из пароля через PBKDF2-SHA256 (600 000 итераций).
// Работает и в браузере, и в Node 20+ (WebCrypto). Файл с зашифрованными данными безопасно хранить в репозитории
// только при достаточно длинном случайном пароле; сам пароль в репозиторий не кладётся.
export const BOX_FORMAT = 'lyceum-encrypted';
const ITERATIONS = 600000;
const AAD = new TextEncoder().encode('lyceum-encrypted-v1');

const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function isEncryptedBox(obj) {
  return !!obj && typeof obj === 'object' && obj.format === BOX_FORMAT && typeof obj.ct === 'string';
}

export async function encryptJson(data, passphrase, { iterations = ITERATIONS } = {}) {
  if (!passphrase || String(passphrase).length < 8) throw new Error('Пароль слишком короткий');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(data))));
  return { format: BOX_FORMAT, v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptJson(box, passphrase) {
  if (!isEncryptedBox(box) || box.v !== 1) throw new Error('Это не зашифрованный файл данных лицея');
  // Параметры берутся из файла: подсунутый файл не должен подвесить браузер огромным числом итераций.
  if (!Number.isInteger(box.iter) || box.iter < 1000 || box.iter > 5000000) throw new Error('Файл содержит недопустимые параметры шифрования');
  if (typeof box.salt !== 'string' || typeof box.iv !== 'string' || typeof box.ct !== 'string' || box.ct.length > 40_000_000) throw new Error('Файл повреждён');
  try {
    const key = await deriveKey(passphrase, unb64(box.salt), box.iter);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: AAD }, key, unb64(box.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Неверный пароль или файл повреждён');
  }
}
