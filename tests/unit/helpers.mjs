import { createMemoryDb } from '../../js/core/memory-db.js';
import { createStore } from '../../js/core/store.js';
import { createRepo } from '../../js/services/repo.js';
import { defaultSettings } from '../../js/domain/state.js';
import { yearView } from '../../js/domain/stats.js';

export async function makeEnv(yearId = '2026-2027') {
  const db = createMemoryDb();
  const store = createStore(db);
  await store.load();
  await store.commit({ settings: { ...defaultSettings(), currentYearId: yearId }, put: {}, del: {} }, { system: true });
  const repo = createRepo(store);
  await repo.initialize();
  return { db, store, repo, S: () => store.state };
}

// По perClass учеников и по одному классному руководителю и воспитателю на каждый класс.
export async function seed(env, perClass = 2) {
  const { repo, S } = env;
  const view = yearView(S(), S().settings.currentYearId);
  let n = 0;
  for (const c of view.classes) {
    for (let i = 1; i <= perClass; i++) {
      n++;
      await repo.addStudent({ lastName: `Демо${n}`, firstName: 'Ученик', middleName: c.name, birthDate: '2012-05-0' + ((i % 9) + 1), classId: c.id });
    }
    const t = await repo.addStaff({ role: 'teacher', lastName: `КР${c.name}`, firstName: 'Демо', middleName: 'Тестовна', classId: c.id });
    const w = await repo.addStaff({ role: 'tutor', lastName: `Воспитатель${c.name}`, firstName: 'Демо', middleName: 'Тестовна', classId: c.id });
    void t;
    void w;
  }
}
