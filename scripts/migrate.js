import { ensureSchema, closePool, all } from '../src/db.js';
import { config } from '../src/config.js';

/** Membuat seluruh tabel di TiDB. Aman dijalankan berulang kali. */
console.log(`\n  Menyiapkan skema di ${config.db.host}/${config.db.database} ...\n`);

try {
  await ensureSchema();
  const tables = await all('SHOW TABLES');
  console.log('  Tabel yang tersedia:');
  for (const row of tables) console.log('    - ' + Object.values(row)[0]);
  console.log('\n  Selesai.\n');
} catch (err) {
  console.error('\n  Gagal:', err.message, '\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
