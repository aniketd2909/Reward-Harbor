import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// Local demo journal. Use a transactional database before running multiple server processes.
export function createStore(file) {
  const data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { orders: {}, attempts: {} };
  return {
    data,
    save() {
      if (!file) return;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}
