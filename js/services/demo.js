// Загрузка демонстрационных данных (data/demo.json). Все записи помечаются demo: true.
export async function loadDemo(repo) {
  const res = await fetch(new URL('../../data/demo.json', import.meta.url));
  if (!res.ok) throw new Error('Не удалось загрузить data/demo.json');
  return repo.importDemo(await res.json());
}
