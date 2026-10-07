// Допуск посетителей через Google Apps Script: запрос → решение владельца → вход.
// На сервер уходит только SHA-256 от случайного секрета устройства; сам секрет хранится в этом браузере.
const KEY = 'lyceum-device-secret';
let memorySecret = null;

export function deviceSecret() {
  try {
    let s = localStorage.getItem(KEY);
    if (!s) {
      s = randomSecret();
      localStorage.setItem(KEY, s);
    }
    return s;
  } catch {
    return (memorySecret ||= randomSecret());
  }
}

function randomSecret() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const ERRORS = {
  'name-required': 'Укажите имя и фамилию (не короче 3 символов)',
  'rate-limit': 'Сейчас слишком много запросов. Попробуйте позже.',
  auth: 'Неверный токен владельца',
  'not-configured': 'Скрипт ещё не настроен: запустите «Учёт лицея → Настройка» в таблице',
  'not-found': 'Запрос не найден (возможно, уже удалён)',
};

async function post(endpoint, payload) {
  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ type: 'access', ...payload }), redirect: 'follow' });
  } catch {
    throw new Error('Нет связи с сервером допуска. Проверьте интернет и повторите.');
  }
  let json;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new Error('Сервер допуска вернул неожиданный ответ. Проверьте адрес и доступ «Все» в развёртывании скрипта.');
  }
  if (!json.ok) {
    const e = new Error(ERRORS[json.error] || `Ошибка сервера: ${json.error}`);
    e.code = json.error;
    throw e;
  }
  return json;
}

export async function requestAccess(endpoint, name, note) {
  return post(endpoint, { action: 'request', deviceHash: await sha256Hex(deviceSecret()), name, note });
}
export const accessStatus = (endpoint) => post(endpoint, { action: 'status', device: deviceSecret() });
export const verifyOwner = (endpoint, token) => post(endpoint, { action: 'whoami', token });
export const listRequests = (endpoint, token) => post(endpoint, { action: 'list', token });
export const decideRequest = (endpoint, token, id, decision) => post(endpoint, { action: 'decide', token, id, decision });
