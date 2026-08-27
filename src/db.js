import mysql from 'mysql2/promise';
import { config, DEFAULT_SETTINGS, assertDbConfigured } from './config.js';

/**
 * Lapisan database untuk TiDB Cloud (kompatibel MySQL 8).
 *
 * Pool disimpan di lingkup modul supaya invocation Vercel yang "hangat"
 * memakai ulang koneksi yang sama, bukan membuka koneksi baru tiap request.
 */
let pool = null;

export function getPool() {
  if (!pool) {
    assertDbConfigured();
    pool = mysql.createPool(config.db);
  }
  return pool;
}

/** SELECT -> array baris. */
export async function all(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

/** SELECT -> satu baris atau null. */
export async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows.length ? rows[0] : null;
}

/** INSERT/UPDATE/DELETE -> ResultSetHeader. */
export async function run(sql, params = []) {
  const [result] = await getPool().query(sql, params);
  return result;
}

/** Jalankan beberapa perintah dalam satu transaksi. */
export async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* koneksi mungkin sudah putus */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// -------------------- skema --------------------

/*
 * Catatan desain:
 *
 * - Kolom waktu disimpan sebagai string ISO-8601 UTC (VARCHAR(30)), sama persis
 *   seperti versi SQLite. Urutan leksikografis ISO-8601 sama dengan urutan
 *   kronologis, jadi perbandingan `<` dan `MIN()` tetap benar tanpa risiko
 *   salah tafsir zona waktu antara server lokal, Vercel, dan TiDB.
 * - `key` dan `value` adalah kata kunci MySQL, sehingga kolom pengaturan
 *   dinamai `setting_key` / `setting_value`.
 * - Kolom kunci (`sku`, `area_id`) memakai COLLATE utf8mb4_bin, BUKAN collation
 *   bawaan `_ci`. OCS memuat SKU yang hanya berbeda huruf besar/kecil — misalnya
 *   `BDL-NCO-00000000052_old_` dan `..._OLD_`. Dengan collation case-insensitive
 *   keduanya dianggap satu kunci primer dan salah satunya hilang tanpa pesan galat.
 *   Perbandingan biner menyamakan perilakunya dengan sumber data di OCS.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS stock_current (
     sku              VARCHAR(120)  COLLATE utf8mb4_bin NOT NULL,
     area_id          VARCHAR(60)   COLLATE utf8mb4_bin NOT NULL,
     name             VARCHAR(512)  NULL,
     sap_code         VARCHAR(60)   NULL,
     category         VARCHAR(40)   NULL,
     shop_code        VARCHAR(60)   NULL,
     qty_rack         INT           NOT NULL DEFAULT 0,
     qty_bulk         INT           NOT NULL DEFAULT 0,
     qty_on_hand      INT           NOT NULL DEFAULT 0,
     qty_on_order     INT           NOT NULL DEFAULT 0,
     available_qty    INT           NOT NULL DEFAULT 0,
     reserve_qty      INT           NOT NULL DEFAULT 0,
     is_active        TINYINT       NOT NULL DEFAULT 0,
     is_under_reserve TINYINT       NOT NULL DEFAULT 0,
     prev_qty_rack    INT           NULL,
     first_seen_at    VARCHAR(30)   NOT NULL,
     updated_at       VARCHAR(30)   NOT NULL,
     PRIMARY KEY (sku, area_id),
     KEY idx_current_rack (qty_rack),
     KEY idx_current_category (category, is_active)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS stock_history (
     id          BIGINT        NOT NULL AUTO_INCREMENT,
     sku         VARCHAR(120)  COLLATE utf8mb4_bin NOT NULL,
     area_id     VARCHAR(60)   COLLATE utf8mb4_bin NOT NULL,
     qty_rack    INT           NOT NULL,
     qty_bulk    INT           NOT NULL,
     qty_on_hand INT           NOT NULL,
     captured_at VARCHAR(30)   NOT NULL,
     PRIMARY KEY (id),
     KEY idx_history_sku (sku, area_id, captured_at),
     KEY idx_history_time (captured_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS item_threshold (
     sku            VARCHAR(120) COLLATE utf8mb4_bin NOT NULL,
     area_id        VARCHAR(60)  COLLATE utf8mb4_bin NOT NULL,
     thin_threshold INT          NOT NULL,
     note           VARCHAR(200) NULL,
     updated_at     VARCHAR(30)  NOT NULL,
     PRIMARY KEY (sku, area_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS app_setting (
     setting_key   VARCHAR(64)  NOT NULL,
     setting_value VARCHAR(255) NOT NULL,
     updated_at    VARCHAR(30)  NOT NULL,
     PRIMARY KEY (setting_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /*
   * Kunci antar-proses. Wajib ada begitu penulisnya lebih dari satu — misalnya
   * worker di Windows plus tombol "Sinkron" di web. Tanpa ini dua sinkronisasi
   * yang bertumpang tindih bisa saling menghapus: masing-masing menulis seluruh
   * baris dengan cap waktunya sendiri, lalu membuang baris bercap waktu lain.
   */
  `CREATE TABLE IF NOT EXISTS sync_lock (
     id          INT          NOT NULL,
     owner       VARCHAR(160) NULL,
     acquired_at VARCHAR(30)  NULL,
     expires_at  VARCHAR(30)  NULL,
     PRIMARY KEY (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS sync_log (
     id          BIGINT       NOT NULL AUTO_INCREMENT,
     started_at  VARCHAR(30)  NOT NULL,
     finished_at VARCHAR(30)  NULL,
     status      VARCHAR(16)  NOT NULL,
     row_count   INT          NULL,
     new_count   INT          NULL,
     duration_ms INT          NULL,
     message     VARCHAR(500) NULL,
     PRIMARY KEY (id),
     KEY idx_synclog_started (started_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

export async function ensureSchema() {
  for (const stmt of SCHEMA_STATEMENTS) await run(stmt);
  await seedSettings();
}

// -------------------- kunci sinkronisasi --------------------

const LOCK_ID = 1;

/** Cukup lama untuk menampung sinkronisasi paling lambat, cukup pendek agar
 *  proses yang mati mendadak tidak memblokir sistem berjam-jam. */
export const LOCK_TTL_MS = 5 * 60_000;

/**
 * Mengambil kunci secara atomik. UPDATE bersyarat hanya akan mengenai satu baris
 * bila kunci sedang bebas atau sudah kedaluwarsa, sehingga dua proses yang
 * mencoba bersamaan tidak mungkin sama-sama berhasil.
 */
export async function acquireSyncLock(owner, ttlMs = LOCK_TTL_MS) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + ttlMs).toISOString();

  await run('INSERT IGNORE INTO sync_lock (id, owner, acquired_at, expires_at) VALUES (?, NULL, NULL, NULL)', [LOCK_ID]);

  const res = await run(
    `UPDATE sync_lock SET owner = ?, acquired_at = ?, expires_at = ?
      WHERE id = ? AND (expires_at IS NULL OR expires_at < ?)`,
    [owner, now, expires, LOCK_ID, now],
  );
  return res.affectedRows === 1;
}

/** Melepas kunci, tetapi hanya bila memang masih milik pemanggil. */
export async function releaseSyncLock(owner) {
  await run(
    'UPDATE sync_lock SET owner = NULL, acquired_at = NULL, expires_at = NULL WHERE id = ? AND owner = ?',
    [LOCK_ID, owner],
  );
}

export async function getSyncLockHolder() {
  const row = await one('SELECT owner, acquired_at, expires_at FROM sync_lock WHERE id = ?', [LOCK_ID]);
  if (!row?.owner) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null; // sudah basi
  return row;
}

// -------------------- app_setting --------------------

export async function seedSettings() {
  const now = new Date().toISOString();
  const rows = Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, String(v), now]);
  // INSERT IGNORE: nilai yang sudah pernah diubah pengguna tidak ditimpa,
  // sedangkan pengaturan baru hasil pembaruan aplikasi tetap terisi.
  await run('INSERT IGNORE INTO app_setting (setting_key, setting_value, updated_at) VALUES ?', [rows]);
}

export async function getSettings() {
  const rows = await all('SELECT setting_key, setting_value FROM app_setting');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    const raw = r.setting_value;
    const n = Number(raw);
    out[r.setting_key] = Number.isFinite(n) && String(raw).trim() !== '' ? n : raw;
  }
  return out;
}

export async function setSetting(key, value) {
  await run(
    `INSERT INTO app_setting (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
    [key, String(value), new Date().toISOString()],
  );
}

// -------------------- ambang per item --------------------

export async function getThresholdMap() {
  const map = new Map();
  for (const r of await all('SELECT sku, area_id, thin_threshold FROM item_threshold')) {
    map.set(`${r.sku}|${r.area_id}`, r.thin_threshold);
  }
  return map;
}

export async function setThreshold(sku, areaId, value, note = null) {
  await run(
    `INSERT INTO item_threshold (sku, area_id, thin_threshold, note, updated_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       thin_threshold = VALUES(thin_threshold),
       note           = VALUES(note),
       updated_at     = VALUES(updated_at)`,
    [sku, areaId, value, note, new Date().toISOString()],
  );
}

export async function clearThreshold(sku, areaId) {
  await run('DELETE FROM item_threshold WHERE sku = ? AND area_id = ?', [sku, areaId]);
}
