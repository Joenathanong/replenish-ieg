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

/**
 * Gangguan koneksi yang layak dicoba ulang.
 *
 * TiDB Serverless menutup koneksi yang menganggur, dan jaringan sesekali putus.
 * Tanpa penanganan ini satu ECONNRESET menjatuhkan seluruh proses — worker yang
 * berjalan sepanjang hari pasti menemuinya cepat atau lambat.
 */
const TRANSIENT_DB_ERRORS = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_QUERY_INTERRUPTED',
]);

const isTransient = (err) =>
  TRANSIENT_DB_ERRORS.has(err?.code) ||
  /ECONNRESET|EPIPE|connection lost|closed state|Pool is closed/i.test(err?.message || '');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Menjalankan satu perintah dengan percobaan ulang bila koneksinya terputus.
 *
 * Hanya dipakai untuk perintah tunggal lewat pool. Semua penulisan di aplikasi
 * ini berbentuk upsert atau penghapusan berdasarkan kunci, jadi mengulanginya
 * tidak mengubah hasil. Transaksi sengaja tidak ikut — mengulang sebagian
 * transaksi tidak aman, dan pemanggilnya yang harus memutuskan.
 */
async function execute(sql, params, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await getPool().query(sql, params);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) throw err;

      // Koneksi yang rusak dibuang bersama pool-nya; pool baru dibuat saat
      // percobaan berikutnya memanggil getPool().
      if (err.code === 'PROTOCOL_CONNECTION_LOST' || /Pool is closed/i.test(err.message || '')) {
        try { await closePool(); } catch { /* abaikan */ }
      }

      const wait = 400 * 2 ** (attempt - 1);
      console.warn(`[db] ${err.code || err.message}; coba lagi ${attempt + 1}/${attempts} dalam ${wait} ms`);
      await pause(wait);
    }
  }
  throw lastErr;
}

/** SELECT -> array baris. */
export async function all(sql, params = []) {
  const [rows] = await execute(sql, params);
  return rows;
}

/** SELECT -> satu baris atau null. */
export async function one(sql, params = []) {
  const rows = await all(sql, params);
  return rows.length ? rows[0] : null;
}

/** INSERT/UPDATE/DELETE -> ResultSetHeader. */
export async function run(sql, params = []) {
  const [result] = await execute(sql, params);
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

  /*
   * Riwayat replenish per bin (DTO_HistoryReplenish di OCS).
   * Hanya bertambah, Id-nya berurutan, sehingga disinkronkan secara inkremental.
   */
  `CREATE TABLE IF NOT EXISTS replenish_bin_log (
     id         BIGINT       NOT NULL,
     seller_sku VARCHAR(120) COLLATE utf8mb4_bin NOT NULL,
     bin_code   VARCHAR(60)  NULL,
     move_type  VARCHAR(16)  NULL,
     qty        INT          NOT NULL DEFAULT 0,
     created_at VARCHAR(30)  NOT NULL,
     created_by VARCHAR(60)  NULL,
     PRIMARY KEY (id),
     KEY idx_binlog_sku (seller_sku, created_at),
     KEY idx_binlog_time (created_at),
     KEY idx_binlog_bin (bin_code)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /*
   * Dokumen Inventory Transfer ke SAP (DTO_HistoryReplenishITHead).
   * `detail_synced_at` kosong berarti baris detailnya belum ditarik — dipakai
   * antrean penarikan bertahap, karena detail hanya bisa diambil satu per satu.
   */
  `CREATE TABLE IF NOT EXISTS replenish_doc (
     id               CHAR(36)     NOT NULL,
     apdraft_id       INT          NULL,
     from_whs         VARCHAR(30)  NULL,
     to_whs           VARCHAR(30)  NULL,
     tgl_dok          VARCHAR(10)  NULL,
     tgl_post         VARCHAR(10)  NULL,
     remark           VARCHAR(255) NULL,
     status           VARCHAR(20)  NULL,
     doc_num          VARCHAR(40)  NULL,
     error_message    TEXT         NULL,
     created_by       VARCHAR(60)  NULL,
     created_at       VARCHAR(30)  NOT NULL,
     posted_at        VARCHAR(30)  NULL,
     detail_synced_at VARCHAR(30)  NULL,
     line_count       INT          NULL,
     PRIMARY KEY (id),
     KEY idx_doc_time (created_at),
     KEY idx_doc_num (doc_num),
     KEY idx_doc_status (status),
     KEY idx_doc_pending (detail_synced_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /* Baris detail dokumen; inilah yang membuat dokumen bisa dicari per SKU. */
  `CREATE TABLE IF NOT EXISTS replenish_doc_line (
     id          CHAR(36)     NOT NULL,
     head_id     CHAR(36)     NOT NULL,
     row_id      INT          NULL,
     seller_sku  VARCHAR(120) COLLATE utf8mb4_bin NULL,
     kode_barang VARCHAR(60)  NULL,
     jumlah      INT          NOT NULL DEFAULT 0,
     satuan      VARCHAR(20)  NULL,
     PRIMARY KEY (id),
     KEY idx_line_head (head_id),
     KEY idx_line_sku (seller_sku)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /*
   * Riwayat penyesuaian stok (DTO_HistoryStockAdjustment).
   * Detailnya bisa diambil beberapa transaksi sekaligus, jadi tidak perlu
   * antrean bertahap seperti dokumen replenish.
   */
  `CREATE TABLE IF NOT EXISTS adjustment_head (
     id               BIGINT       NOT NULL,
     transaction_id   VARCHAR(60)  NULL,
     area_id          VARCHAR(60)  NULL,
     shop_code        VARCHAR(60)  NULL,
     user_code        VARCHAR(60)  NULL,
     adj_type         VARCHAR(16)  NULL,
     created_at       VARCHAR(30)  NOT NULL,
     detail_synced_at VARCHAR(30)  NULL,
     line_count       INT          NULL,
     PRIMARY KEY (id),
     KEY idx_adj_time (created_at),
     KEY idx_adj_type (adj_type),
     KEY idx_adj_trx (transaction_id),
     KEY idx_adj_user (user_code),
     KEY idx_adj_shop (shop_code),
     KEY idx_adj_pending (detail_synced_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /*
   * Baris detail penyesuaian. Sumbernya tidak memberi Id per baris, sehingga
   * kuncinya gabungan header dan nomor urut. Nomor urut dipakai — bukan SKU —
   * supaya tetap benar seandainya satu transaksi memuat SKU yang sama dua kali.
   */
  `CREATE TABLE IF NOT EXISTS adjustment_line (
     head_id    BIGINT       NOT NULL,
     row_no     INT          NOT NULL,
     seller_sku VARCHAR(120) COLLATE utf8mb4_bin NULL,
     qty        INT          NOT NULL DEFAULT 0,
     remarks    VARCHAR(500) NULL,
     PRIMARY KEY (head_id, row_no),
     KEY idx_adjline_sku (seller_sku)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /*
   * Penjualan harian dari halaman Report OCS.
   *
   * Data mentahnya berjumlah 19,6 juta baris order, jadi yang disimpan adalah
   * agregat harian dari endpoint report — bukan barisan order satu per satu.
   *
   * Semua tabel di bawah berkunci tanggal. Isi satu hari bisa berubah karena
   * order berpindah status, sehingga penarikan ulang menghapus dulu baris hari
   * itu lalu menulis ulang. Dengan begitu menarik rentang yang sama berkali-kali
   * tidak pernah menggandakan angka.
   */
  `CREATE TABLE IF NOT EXISTS sales_order_shop_daily (
     sales_date  DATE         NOT NULL,
     shop_name   VARCHAR(60)  NOT NULL,
     area        VARCHAR(60)  NOT NULL,
     total_order INT          NOT NULL DEFAULT 0,
     soi         INT          NOT NULL DEFAULT 0,
     moi         INT          NOT NULL DEFAULT 0,
     PRIMARY KEY (sales_date, shop_name, area),
     KEY idx_sos_date (sales_date)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /*
   * Jumlah order per status disimpan sebagai baris, bukan 13 kolom tetap.
   * OCS mengelompokkan 32 status mentah menjadi 13 kelompok; bentuk baris
   * membuat penambahan kelompok baru tidak menuntut perubahan skema, dan
   * penyaringan per status menjadi klausa WHERE biasa.
   */
  `CREATE TABLE IF NOT EXISTS sales_order_status_daily (
     sales_date       DATE        NOT NULL,
     shop_name        VARCHAR(60) NOT NULL,
     area             VARCHAR(60) NOT NULL,
     commerce_platform VARCHAR(40) NOT NULL,
     status           VARCHAR(40) NOT NULL,
     order_count      INT         NOT NULL DEFAULT 0,
     PRIMARY KEY (sales_date, shop_name, area, commerce_platform, status),
     KEY idx_sod_date (sales_date),
     KEY idx_sod_status (status, sales_date),
     KEY idx_sod_platform (commerce_platform, sales_date)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS sales_sku_daily (
     sales_date        DATE         NOT NULL,
     seller_sku        VARCHAR(120) COLLATE utf8mb4_bin NOT NULL,
     area              VARCHAR(60)  NOT NULL,
     commerce_platform VARCHAR(40)  NOT NULL,
     qty               INT          NOT NULL DEFAULT 0,
     PRIMARY KEY (sales_date, seller_sku, area, commerce_platform),
     KEY idx_ssd_date (sales_date),
     KEY idx_ssd_sku (seller_sku, sales_date),
     KEY idx_ssd_platform (commerce_platform, sales_date)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  /* Catatan cakupan: hari mana saja yang sudah pernah ditarik, dan kapan. */
  `CREATE TABLE IF NOT EXISTS sales_sync_day (
     sales_date  DATE        NOT NULL,
     order_rows  INT         NOT NULL DEFAULT 0,
     sku_rows    INT         NOT NULL DEFAULT 0,
     pulled_at   VARCHAR(30) NOT NULL,
     PRIMARY KEY (sales_date)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS sync_log (
     id          BIGINT       NOT NULL AUTO_INCREMENT,
     started_at  VARCHAR(30)  NOT NULL,
     finished_at VARCHAR(30)  NULL,
     status      VARCHAR(16)  NOT NULL,
     trigger_source VARCHAR(20) NULL,
     row_count   INT          NULL,
     new_count   INT          NULL,
     duration_ms INT          NULL,
     message     VARCHAR(500) NULL,
     PRIMARY KEY (id),
     KEY idx_synclog_started (started_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

/**
 * Tambahkan kolom bila belum ada.
 *
 * `CREATE TABLE IF NOT EXISTS` tidak menyentuh tabel yang sudah terlanjur dibuat,
 * sehingga penambahan kolom pada versi berikutnya perlu ditangani terpisah.
 */
async function ensureColumn(table, column, definition) {
  const row = await one(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (!row.c) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export async function ensureSchema() {
  for (const stmt of SCHEMA_STATEMENTS) await run(stmt);
  await ensureColumn('sync_log', 'trigger_source', 'VARCHAR(20) NULL');

  /*
   * Sidik jari isi satu hari, dan berapa kali berturut-turut ia tidak berubah.
   * Dipakai untuk berhenti menarik ulang hari yang angkanya sudah mengendap.
   */
  await ensureColumn('sales_sync_day', 'fingerprint', 'VARCHAR(80) NULL');
  await ensureColumn('sales_sync_day', 'stable_count', 'INT NOT NULL DEFAULT 0');

  /*
   * Versi aturan penarikan yang dipakai saat hari itu diambil.
   *
   * Saat aturan berubah dengan cara yang membuat data lama salah — seperti
   * perbaikan batas hari dari UTC ke zona OCS — hari lama tidak bisa dibedakan
   * dari yang baru tanpa menebak-nebak lewat cap waktu. Dengan kolom ini
   * aplikasi bisa menyebut sendiri hari mana yang perlu ditarik ulang.
   */
  await ensureColumn('sales_sync_day', 'pull_version', 'INT NOT NULL DEFAULT 0');

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
