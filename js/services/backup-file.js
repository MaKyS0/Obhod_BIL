// Сохранение полной резервной копии в файл и запоминание даты последней выгрузки.
import { downloadJson } from './download.js';
import { todayISO, nowISO } from '../domain/dates.js';

export async function saveBackupFile(repo) {
  downloadJson(`lyceum-backup-${todayISO()}.json`, repo.exportJson());
  await repo.updateSettings({ lastExportAt: nowISO() });
}
