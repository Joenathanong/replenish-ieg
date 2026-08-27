import { ensureSchema, getSettings, closePool } from './db.js';
import { runSync, INSTANCE_ID } from './sync.js';
import { config } from './config.js';

/**
 * Worker penarik data — dijalankan sebagai Windows Service.
 *
 * Tugasnya hanya satu: menarik data dari OCS ke TiDB sesuai interval yang
 * tersimpan di database. Tidak menyalakan web server, karena tampilan
 * dashboard-nya disajikan oleh Vercel dari database yang sama.
 *
 * Interval dibaca ulang setiap putaran, jadi mengubahnya dari halaman
 * Pengaturan langsung berlaku tanpa perlu me-restart service.
 */

let stopping = false;
let timer = null;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(...args) {
  console.log(`[${stamp()}]`, ...args);
}

/** Jeda sebelum mencoba lagi setelah gagal, memanjang bertahap sampai 5 menit. */
let consecutiveFailures = 0;
function backoffMs() {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(consecutiveFailures - 1, 5));
}

async function tick() {
  if (stopping) return;

  let delay;
  try {
    const result = await runSync({ trigger: 'worker' });

    if (result.skipped) {
      log('dilewati —', result.reason);
      consecutiveFailures = 0;
    } else if (result.ok) {
      consecutiveFailures = 0;
      log(
        `berhasil — ${result.rows} baris, ${result.changedItems} berubah, ` +
        `${result.newItems} baru, ${result.removedItems} dihapus (${result.durationMs} ms)`,
      );
    } else {
      consecutiveFailures++;
      log(`GAGAL (ke-${consecutiveFailures}) —`, result.error);
    }

    if (consecutiveFailures > 0) {
      delay = backoffMs();
      log(`mencoba lagi dalam ${Math.round(delay / 1000)} detik`);
    } else {
      const settings = await getSettings();
      if (!settings.auto_sync_enabled) {
        // Dimatikan dari halaman Pengaturan. Tetap periksa berkala supaya
        // menyalakannya kembali tidak perlu me-restart service.
        delay = 60_000;
        log('sinkronisasi otomatis dimatikan; memeriksa lagi dalam 60 detik');
      } else {
        delay = Math.max(1, Number(settings.poll_interval_minutes) || 5) * 60_000;
        log(`berikutnya dalam ${Math.round(delay / 60_000)} menit`);
      }
    }
  } catch (err) {
    // Termasuk database tak terjangkau. Jangan sampai worker mati.
    consecutiveFailures++;
    delay = backoffMs();
    log(`GALAT (ke-${consecutiveFailures}) — ${err.message}; mencoba lagi dalam ${Math.round(delay / 1000)} detik`);
  }

  if (!stopping) timer = setTimeout(tick, delay);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`menerima ${signal}, menutup...`);
  clearTimeout(timer);
  try { await closePool(); } catch { /* abaikan */ }
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => shutdown(sig));
}

// Kegagalan tak tertangani tidak boleh mematikan service diam-diam.
process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.message || err));
process.on('uncaughtException', (err) => log('uncaughtException:', err?.message || err));

console.log('');
console.log('  OCS Replenish Worker');
console.log(`  Instance : ${INSTANCE_ID}`);
console.log(`  Sumber   : ${config.ocs.baseUrl} (${config.ocs.companyDb})`);
console.log(`  Database : ${config.db.host}/${config.db.database}`);
console.log(`  Basis    : Qty Rack / QtyGudangKecil`);
console.log('');

try {
  await ensureSchema();
  const settings = await getSettings();
  log(`siap. Interval ${settings.poll_interval_minutes} menit, ambang default ${settings.default_thin_threshold}.`);
  await tick();
} catch (err) {
  console.error(`\n  Gagal memulai worker: ${err.message}\n`);
  await closePool();
  process.exit(1);
}
