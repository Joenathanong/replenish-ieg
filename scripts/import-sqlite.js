import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureSchema, run, one, closePool } from '../src/db.js';
import { config } from '../src/config.js';

/**
 * Memindahkan isi database SQLite lokal (versi sebelumnya) ke TiDB.
 *
 * Semua tabel ikut dipindah, bukan hanya pengaturan. Alasannya `first_seen_at`
 * pada stock_current dan `started_at` tertua pada sync_log menentukan item mana
 * yang dianggap "material baru" — kalau hanya pengaturan yang dipindah, seluruh
 * katalog akan tampak baru setelah sinkronisasi pertama di TiDB.
 *
 * Aman dijalankan berulang: baris yang sudah ada tidak diduplikasi.
 */

const src = config.legacySqlitePath;

if (!existsSync(src)) {
  console.error(`\n  Berkas SQLite tidak ditemukan: ${src}`);
  console.error('  Lewati langkah ini bila Anda memang mulai dari database kosong.\n');
  process.exit(1);
}

const BATCH = 500;

async function copy(label, rows, sql) {
  if (!rows.length) {
    console.log(`  ${label.padEnd(16)} 0 baris (dilewati)`);
    return 0;
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(sql, [rows.slice(i, i + BATCH)]);
  }
  console.log(`  ${label.padEnd(16)} ${rows.length} baris`);
  return rows.length;
}

const sqlite = new DatabaseSync(src, { readOnly: true });

console.log(`\n  Sumber : ${src}`);
console.log(`  Tujuan : ${config.db.host}/${config.db.database}\n`);

try {
  await ensureSchema();

  await copy(
    'app_setting',
    sqlite.prepare('SELECT key, value, updated_at FROM app_setting').all()
      .map((r) => [r.key, String(r.value), r.updated_at]),
    `INSERT INTO app_setting (setting_key, setting_value, updated_at) VALUES ?
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
  );

  await copy(
    'item_threshold',
    sqlite.prepare('SELECT sku, area_id, thin_threshold, note, updated_at FROM item_threshold').all()
      .map((r) => [r.sku, r.area_id, r.thin_threshold, r.note, r.updated_at]),
    `INSERT INTO item_threshold (sku, area_id, thin_threshold, note, updated_at) VALUES ?
     ON DUPLICATE KEY UPDATE
       thin_threshold = VALUES(thin_threshold),
       note           = VALUES(note),
       updated_at     = VALUES(updated_at)`,
  );

  await copy(
    'stock_current',
    sqlite.prepare(`
      SELECT sku, area_id, name, sap_code, category, shop_code,
             qty_rack, qty_bulk, qty_on_hand, qty_on_order, available_qty, reserve_qty,
             is_active, is_under_reserve, prev_qty_rack, first_seen_at, updated_at
        FROM stock_current
    `).all().map((r) => [
      r.sku, r.area_id, r.name, r.sap_code, r.category, r.shop_code,
      r.qty_rack, r.qty_bulk, r.qty_on_hand, r.qty_on_order, r.available_qty, r.reserve_qty,
      r.is_active, r.is_under_reserve, r.prev_qty_rack, r.first_seen_at, r.updated_at,
    ]),
    `INSERT INTO stock_current (
       sku, area_id, name, sap_code, category, shop_code,
       qty_rack, qty_bulk, qty_on_hand, qty_on_order, available_qty, reserve_qty,
       is_active, is_under_reserve, prev_qty_rack, first_seen_at, updated_at
     ) VALUES ?
     ON DUPLICATE KEY UPDATE first_seen_at = LEAST(stock_current.first_seen_at, VALUES(first_seen_at))`,
  );

  // stock_history dan sync_log berkunci auto-increment, jadi tidak punya kunci
  // alami untuk mencegah duplikasi. Keduanya hanya diimpor saat tabel tujuan
  // masih kosong, supaya menjalankan skrip ini dua kali tidak menggandakan riwayat.
  const historyCount = (await one('SELECT COUNT(*) AS c FROM stock_history')).c;
  if (historyCount > 0) {
    console.log(`  stock_history    dilewati (sudah berisi ${historyCount} baris)`);
  } else {
    await copy(
      'stock_history',
      sqlite.prepare('SELECT sku, area_id, qty_rack, qty_bulk, qty_on_hand, captured_at FROM stock_history').all()
        .map((r) => [r.sku, r.area_id, r.qty_rack, r.qty_bulk, r.qty_on_hand, r.captured_at]),
      `INSERT INTO stock_history (sku, area_id, qty_rack, qty_bulk, qty_on_hand, captured_at) VALUES ?`,
    );
  }

  const logCount = (await one('SELECT COUNT(*) AS c FROM sync_log')).c;
  if (logCount > 0) {
    console.log(`  sync_log         dilewati (sudah berisi ${logCount} baris)`);
  } else {
    await copy(
      'sync_log',
      sqlite.prepare('SELECT started_at, finished_at, status, row_count, new_count, duration_ms, message FROM sync_log').all()
        .map((r) => [r.started_at, r.finished_at, r.status, r.row_count, r.new_count, r.duration_ms, r.message]),
      `INSERT INTO sync_log (started_at, finished_at, status, row_count, new_count, duration_ms, message) VALUES ?`,
    );
  }

  const baseline = await one('SELECT MIN(started_at) AS t FROM sync_log');
  console.log(`\n  Baseline "material baru" : ${baseline?.t || '(belum ada)'}`);
  console.log('  Selesai.\n');
} catch (err) {
  console.error('\n  Gagal:', err.message, '\n');
  process.exitCode = 1;
} finally {
  sqlite.close();
  await closePool();
}
