import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Parser .env minimalis supaya proyek ini tetap nol dependensi. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(resolve(ROOT, '.env'));

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Koneksi TiDB Cloud (kompatibel MySQL 8).
 * Boleh diisi lewat satu URL (`TIDB_URL`/`DATABASE_URL`) atau variabel terpisah.
 */
function buildDbConfig() {
  const url = process.env.TIDB_URL || process.env.DATABASE_URL || '';

  const base = {
    // TiDB Cloud Serverless mewajibkan TLS.
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    charset: 'utf8mb4',
    timezone: 'Z',
    connectionLimit: num(process.env.DB_POOL_SIZE, 5),
    waitForConnections: true,
    enableKeepAlive: true,
    connectTimeout: num(process.env.DB_CONNECT_TIMEOUT_MS, 15000),
  };

  if (url) {
    const u = new URL(url);
    return {
      ...base,
      host: u.hostname,
      port: Number(u.port) || 4000,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'ocs_replenish',
    };
  }

  return {
    ...base,
    host: process.env.TIDB_HOST || '',
    port: num(process.env.TIDB_PORT, 4000),
    user: process.env.TIDB_USER || '',
    password: process.env.TIDB_PASSWORD || '',
    database: process.env.TIDB_DATABASE || 'ocs_replenish',
  };
}

export const config = {
  ocs: {
    baseUrl: (process.env.OCS_BASE_URL || 'https://ocs.iegsystem.id').replace(/\/+$/, ''),
    username: process.env.OCS_USERNAME || 'ADMIN',
    password: process.env.OCS_PASSWORD || 'ADMIN',
    companyDb: process.env.OCS_COMPANY_DB || 'EJI_WMS',
    stockEntity: 'DTO_WmsItemStockLiteV2',
  },
  server: {
    port: num(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
  },
  db: buildDbConfig(),
  historyRetentionDays: num(process.env.HISTORY_RETENTION_DAYS, 30),

  // Melindungi endpoint /api/cron agar hanya bisa dipicu penjadwal Vercel.
  cronSecret: process.env.CRON_SECRET || '',

  // Vercel menyetel VERCEL=1 pada semua deployment-nya.
  isServerless: process.env.VERCEL === '1',

  // Berkas SQLite lama; hanya dipakai skrip migrasi satu kali.
  legacySqlitePath: resolve(ROOT, process.env.DB_PATH || './data/replenish.db'),
};

/** Dipakai skrip agar gagal lebih awal dengan pesan yang jelas. */
export function assertDbConfigured() {
  const { host, user, database } = config.db;
  if (!host || !user || !database) {
    throw new Error(
      'Koneksi TiDB belum diatur. Isi TIDB_URL (atau TIDB_HOST/TIDB_USER/TIDB_PASSWORD/TIDB_DATABASE) di .env ' +
      'maupun di Environment Variables proyek Vercel.',
    );
  }
}

/** Nilai awal tabel app_setting. Semuanya bisa diubah dari halaman Pengaturan. */
export const DEFAULT_SETTINGS = {
  poll_interval_minutes: 5,   // seberapa sering tarik data dari OCS
  default_thin_threshold: 50, // ambang "tipis" untuk material yang belum di-set khusus
  show_bundle: 0,             // tampilkan Category = Bundle
  show_gimmick: 0,            // tampilkan Category = Gimmick
  show_inactive: 0,           // tampilkan item IsActive = false
  show_clearance: 0,          // tampilkan Category = Sku berawalan "CS-" (Clearance Sale)
  replenishable_only: 0,      // hanya item yang stok Gudang Besar-nya > 0
  hide_safe: 1,               // sembunyikan item berstatus Aman
  slide_rows: 12,             // baris per slide saat mode presentasi
  slide_interval_seconds: 15, // durasi tiap slide
  new_item_days: 7,           // item dianggap "baru" jika pertama terlihat dalam N hari
  auto_sync_enabled: 1,       // aktif/nonaktifkan penarikan otomatis
};
