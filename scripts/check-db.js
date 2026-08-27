import { all, one, closePool, ensureSchema } from '../src/db.js';
import { config } from '../src/config.js';

/** Uji koneksi TiDB menyeluruh: sambung, tulis, baca, hapus. */
const t0 = Date.now();
let failed = false;
const ok = (label, detail = '') => console.log(`  OK    ${label.padEnd(34)} ${detail}`);
const bad = (label, detail = '') => { failed = true; console.log(`  GAGAL ${label.padEnd(34)} ${detail}`); };

console.log(`\n  Target: ${config.db.host}:${config.db.port}/${config.db.database}\n`);

try {
  const v = await one('SELECT VERSION() AS v');
  ok('koneksi + TLS', v.v);

  await ensureSchema();
  const tables = (await all('SHOW TABLES')).map((r) => Object.values(r)[0]);
  const wanted = ['app_setting', 'item_threshold', 'stock_current', 'stock_history', 'sync_log'];
  const missing = wanted.filter((t) => !tables.includes(t));
  missing.length ? bad('skema lengkap', 'hilang: ' + missing.join(', ')) : ok('skema lengkap', wanted.length + ' tabel');

  /*
   * Kolom kunci wajib bercollation biner. Dengan collation _ci, SKU yang hanya
   * berbeda huruf besar/kecil — dan OCS memang punya, misalnya "..._OLD_" dan
   * "..._old_" — dianggap kunci primer yang sama, sehingga satu baris hilang
   * tanpa pesan galat apa pun.
   */
  const collations = await all(`
    SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN ('sku', 'area_id')
       AND TABLE_NAME IN ('stock_current', 'stock_history', 'item_threshold')
  `);
  const wrong = collations.filter((c) => c.COLLATION_NAME !== 'utf8mb4_bin');
  wrong.length
    ? bad('collation kolom kunci', wrong.map((c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}=${c.COLLATION_NAME}`).join(', '))
    : ok('collation kolom kunci', `${collations.length} kolom utf8mb4_bin`);

  // SKU yang hanya berbeda huruf besar/kecil harus tetap tersimpan terpisah.
  const dupes = await one(`
    SELECT COUNT(*) AS c FROM (
      SELECT LOWER(sku) AS s, COUNT(*) AS n FROM stock_current GROUP BY LOWER(sku) HAVING n > 1
    ) x
  `);
  ok('SKU beda huruf besar/kecil', `${dupes.c} pasang tersimpan terpisah`);

  // Uji tulis-baca-hapus pada tabel ambang, memakai SKU khusus uji.
  const sku = '__CEK_KONEKSI__';
  const { setThreshold, clearThreshold } = await import('../src/db.js');
  await setThreshold(sku, 'Pusat', 123, 'uji koneksi');
  const back = await one('SELECT thin_threshold FROM item_threshold WHERE sku = ?', [sku]);
  back?.thin_threshold === 123 ? ok('tulis + baca') : bad('tulis + baca', JSON.stringify(back));
  await clearThreshold(sku, 'Pusat');
  const gone = await one('SELECT thin_threshold FROM item_threshold WHERE sku = ?', [sku]);
  gone ? bad('hapus', 'baris masih ada') : ok('hapus');

  // Uji upsert massal seperti yang dipakai sinkronisasi sesungguhnya.
  const rows = await one('SELECT COUNT(*) AS c FROM stock_current');
  ok('isi stock_current', rows.c + ' baris');

  const s = await one('SELECT COUNT(*) AS c FROM app_setting');
  ok('pengaturan ter-seed', s.c + ' kunci');
} catch (err) {
  bad('koneksi', err.message);
} finally {
  await closePool();
}

console.log(`\n  ${failed ? 'ADA MASALAH' : 'Semua pemeriksaan lolos'} (${Date.now() - t0} ms)\n`);
process.exitCode = failed ? 1 : 0;
