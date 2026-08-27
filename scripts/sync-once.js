import { runSync } from '../src/sync.js';
import { ensureSchema, closePool } from '../src/db.js';

/** Menarik satu snapshot dari OCS ke TiDB, lalu keluar. */
try {
  await ensureSchema();
  const r = await runSync({ trigger: 'cli' });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} finally {
  await closePool();
}
