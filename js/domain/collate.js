// Сортировка по правилам русского языка.
export const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
export const cmp = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));
