// Настройки развёртывания.
//
// ACCESS_ENDPOINT — адрес вашего Google Apps Script (Web App, оканчивается на /exec).
// Пока он пуст, сайт работает без допуска посетителей. Если указать адрес, каждый посетитель сначала отправит
// запрос владельцу и сможет войти только после его решения (страница «Доступ»).
//
// Адрес Web App — не секрет (как адрес любого API): без токена владельца по нему можно только отправить запрос
// и узнать решение о самом себе.
export const ACCESS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwYdv3D7zNvUISY19BL76-mFLhamjI6Dc6hmRcvRxGdvSDjnAedXNJqKmeHQJni_4hR/exec';

// Тесты и отладка могут подставить адрес через window.__LYCEUM_ACCESS_ENDPOINT__.
export function accessEndpoint() {
  const o = globalThis.__LYCEUM_ACCESS_ENDPOINT__;
  return typeof o === 'string' ? o : ACCESS_ENDPOINT;
}
