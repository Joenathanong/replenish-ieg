import { hostname } from 'node:os';
import {
  all, one, run, withTransaction, getSettings,
  acquireSyncLock, releaseSyncLock, getSyncLockHolder,
} from './db.js';
import { fetchStock, fetchItemSettings } from './ocs.js';
import { config } from './config.js';

/**
 * Identitas proses ini. Muncul di pesan "sedang dikerjakan proses lain",
 * sehingga saat ada dua penulis Anda tahu mana yang sedang memegang kunci.
 */
export const INSTANCE_ID = `${config.isServerless ? 'vercel' : hostname()}:${process.pid}`;

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** Baris per perintah INSERT. Menjaga ukuran paket ke TiDB tetap wajar. */
const BATCH_SIZE = 500;

let running = false;
let lastResult = null;

export function isSyncRunning() {
  return running;
}

export function getLastSyncResult() {
  return lastResult;
}

/** Master setting item di-cache; dipakai untuk memetakan SKU -> ShopCode (brand). */
let shopMap = new Map();
let shopMapFetchedAt = 0;

async function refreshShopMap(force = false) {
  const stale = Date.now() - shopMapFetchedAt > 60 * 60_000; // segarkan tiap 1 jam
  if (!force && !stale && shopMap.size) return shopMap;
  try {
    const rows = await fetchItemSettings();
    const next = new Map();
    for (const r of rows) {
      const key = `${r.SellerSku}|${r.AreaId}`;
      if (!next.has(key) && r.ShopCode) next.set(key, r.ShopCode);
    }
    if (next.size) {
      shopMap = next;
      shopMapFetchedAt = Date.now();
    }
  } catch (err) {
    // Brand hanya pelengkap tampilan; kegagalannya tidak boleh membatalkan sinkronisasi stok.
    console.warn('[sync] gagal memuat WmsItemSettings:', err.message);
  }
  return shopMap;
}

export const UPSERT_SQL = `
  INSERT INTO stock_current (
    sku, area_id, name, sap_code, category, shop_code,
    qty_rack, qty_bulk, qty_on_hand, qty_on_order, available_qty, reserve_qty,
    is_active, is_under_reserve, first_seen_at, updated_at
  ) VALUES ?
  ON DUPLICATE KEY UPDATE
    name             = VALUES(name),
    sap_code         = VALUES(sap_code),
    category         = VALUES(category),
    shop_code        = COALESCE(VALUES(shop_code), stock_current.shop_code),
    prev_qty_rack    = stock_current.qty_rack,
    qty_rack         = VALUES(qty_rack),
    qty_bulk         = VALUES(qty_bulk),
    qty_on_hand      = VALUES(qty_on_hand),
    qty_on_order     = VALUES(qty_on_order),
    available_qty    = VALUES(available_qty),
    reserve_qty      = VALUES(reserve_qty),
    is_active        = VALUES(is_active),
    is_under_reserve = VALUES(is_under_reserve),
    updated_at       = VALUES(updated_at)
`;
/*
 * Urutan pada ON DUPLICATE KEY UPDATE penting: MySQL mengevaluasi penugasan dari
 * kiri ke kanan, jadi `prev_qty_rack = stock_current.qty_rack` harus berada
 * SEBELUM `qty_rack` ditimpa — kalau tidak, delta selalu bernilai nol.
 */

export const HISTORY_SQL = `
  INSERT INTO stock_history (sku, area_id, qty_rack, qty_bulk, qty_on_hand, captured_at)
  VALUES ?
`;

async function insertBatched(conn, sql, rows) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await conn.query(sql, [rows.slice(i, i + BATCH_SIZE)]);
  }
}

/**
 * Tarik satu snapshot penuh dari OCS lalu simpan.
 * Riwayat hanya dicatat saat nilainya berubah, supaya database tetap ramping
 * walaupun polling berjalan tiap beberapa menit.
 */
export async function runSync({ trigger = 'scheduler' } = {}) {
  // Penjaga di dalam proses ini sendiri.
  if (running) return { skipped: true, reason: 'Sinkronisasi lain sedang berjalan di proses ini' };

  // Penjaga antar proses/mesin. Wajib pada susunan hybrid, karena worker di
  // Windows dan tombol "Sinkron" di web menulis ke database yang sama.
  if (!(await acquireSyncLock(INSTANCE_ID))) {
    const holder = await getSyncLockHolder();
    return {
      skipped: true,
      reason: `Sinkronisasi sedang dikerjakan proses lain${holder?.owner ? ` (${holder.owner})` : ''}`,
      lockedBy: holder?.owner ?? null,
      lockedAt: holder?.acquired_at ?? null,
    };
  }

  running = true;
  const startedAtIso = new Date().toISOString();
  const t0 = Date.now();

  const logInsert = await run('INSERT INTO sync_log (started_at, status) VALUES (?, ?)', [
    startedAtIso,
    'running',
  ]);
  const logId = logInsert.insertId;

  try {
    const [rows] = await Promise.all([fetchStock(), refreshShopMap()]);

    const existing = new Map();
    for (const r of await all('SELECT sku, area_id, qty_rack, qty_bulk, qty_on_hand FROM stock_current')) {
      existing.set(`${r.sku}|${r.area_id}`, r);
    }

    const now = new Date().toISOString();
    const upsertRows = [];
    const historyRows = [];
    let newCount = 0;

    for (const r of rows) {
      const sku = String(r.Sku ?? '');
      const areaId = String(r.AreaId ?? '');
      if (!sku) continue;

      const key = `${sku}|${areaId}`;
      const qtyRack = int(r.QtyGudangKecil);
      const qtyBulk = int(r.QtyGudangBesar);
      const qtyOnHand = int(r.QtyOnHand);
      const prev = existing.get(key);

      upsertRows.push([
        sku,
        areaId,
        r.Name ?? '',
        r.SapCode ?? '',
        r.Category ?? '',
        shopMap.get(key) ?? null,
        qtyRack,
        qtyBulk,
        qtyOnHand,
        int(r.QtyOnOrder),
        int(r.AvailableQty),
        int(r.ReserveQty),
        r.IsActive ? 1 : 0,
        r.IsUnderReserve ? 1 : 0,
        now, // first_seen_at (hanya terpakai saat baris benar-benar baru)
        now, // updated_at
      ]);

      const changed =
        !prev ||
        prev.qty_rack !== qtyRack ||
        prev.qty_bulk !== qtyBulk ||
        prev.qty_on_hand !== qtyOnHand;

      if (!prev) newCount++;
      if (changed) historyRows.push([sku, areaId, qtyRack, qtyBulk, qtyOnHand, now]);
    }

    const removed = await withTransaction(async (conn) => {
      await insertBatched(conn, UPSERT_SQL, upsertRows);
      if (historyRows.length) await insertBatched(conn, HISTORY_SQL, historyRows);

      // Snapshot bersifat otoritatif. Semua baris yang ada di sumber baru saja
      // ditulis dengan updated_at = now, jadi sisanya sudah tidak ada lagi di OCS.
      const [res] = await conn.query('DELETE FROM stock_current WHERE updated_at <> ?', [now]);
      return res.affectedRows || 0;
    });

    /*
     * Pengaman integritas. Jumlah baris tersimpan harus persis sama dengan yang
     * dikirim OCS. Kalau meleset, ada baris yang lenyap tanpa memicu galat —
     * misalnya karena dua kunci primer bertabrakan akibat aturan perbandingan
     * teks di database. Kasus seperti itu pernah terjadi (SKU yang hanya berbeda
     * huruf besar/kecil), dan tanpa pemeriksaan ini kehilangannya tidak terlihat.
     */
    const stored = (await one('SELECT COUNT(*) AS c FROM stock_current')).c;
    const mismatch = stored !== upsertRows.length;
    if (mismatch) {
      console.warn(
        `[sync] PERINGATAN: OCS mengirim ${upsertRows.length} baris tetapi ${stored} tersimpan ` +
        `(selisih ${upsertRows.length - stored}).`,
      );
    }

    lastResult = {
      ok: true,
      trigger,
      rows: rows.length,
      newItems: newCount,
      changedItems: historyRows.length,
      removedItems: removed,
      storedRows: stored,
      ...(mismatch ? { warning: `${upsertRows.length - stored} baris tidak tersimpan` } : {}),
      durationMs: Date.now() - t0,
      finishedAt: new Date().toISOString(),
    };

    await pruneHistory();

    await run(
      `UPDATE sync_log SET finished_at = ?, status = ?, row_count = ?, new_count = ?,
              duration_ms = ?, message = ? WHERE id = ?`,
      [
        lastResult.finishedAt,
        'success',
        lastResult.rows,
        lastResult.newItems,
        lastResult.durationMs,
        `${historyRows.length} item berubah, ${removed} item dihapus` +
          (mismatch ? ` — PERINGATAN: ${upsertRows.length - stored} baris tidak tersimpan` : ''),
        logId,
      ],
    );
    return lastResult;
  } catch (err) {
    lastResult = {
      ok: false,
      trigger,
      error: err.message,
      durationMs: Date.now() - t0,
      finishedAt: new Date().toISOString(),
    };
    try {
      await run(
        `UPDATE sync_log SET finished_at = ?, status = ?, duration_ms = ?, message = ? WHERE id = ?`,
        [lastResult.finishedAt, 'error', lastResult.durationMs, String(err.message).slice(0, 500), logId],
      );
    } catch { /* database mungkin ikut bermasalah */ }
    console.error('[sync] gagal:', err.message);
    return lastResult;
  } finally {
    running = false;
    try { await releaseSyncLock(INSTANCE_ID); } catch { /* kunci akan kedaluwarsa sendiri */ }
  }
}

async function pruneHistory() {
  const cutoff = new Date(Date.now() - config.historyRetentionDays * 86400_000).toISOString();
  await run('DELETE FROM stock_history WHERE captured_at < ?', [cutoff]);
  await run('DELETE FROM sync_log WHERE started_at < ?', [cutoff]);
}

// -------------------- gerbang jadwal (dipakai cron serverless) --------------------

/**
 * Di Vercel, jadwal cron ditetapkan saat deploy dan tidak bisa diubah saat berjalan.
 * Karena itu cron dipasang pada frekuensi terhalus, lalu fungsi ini yang memutuskan
 * apakah sudah waktunya menarik data — sehingga interval tetap bisa diatur dari
 * halaman Pengaturan tanpa perlu deploy ulang.
 */
export async function shouldSyncNow() {
  const settings = await getSettings();

  if (!settings.auto_sync_enabled) {
    return { due: false, reason: 'Sinkronisasi otomatis dimatikan dari halaman Pengaturan' };
  }

  const row = await one(
    `SELECT started_at FROM sync_log WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`,
  );
  if (!row) return { due: true, reason: 'Belum pernah ada sinkronisasi berhasil' };

  const intervalMs = Math.max(1, Number(settings.poll_interval_minutes) || 5) * 60_000;
  const elapsed = Date.now() - Date.parse(row.started_at);

  // Toleransi 20 detik supaya cron yang datang sedikit lebih cepat tidak terlewat
  // satu putaran penuh.
  if (elapsed + 20_000 >= intervalMs) return { due: true, elapsedMs: elapsed, intervalMs };

  return {
    due: false,
    reason: `Belum waktunya (${Math.round(elapsed / 1000)} detik dari ${Math.round(intervalMs / 1000)} detik)`,
    elapsedMs: elapsed,
    intervalMs,
  };
}

/**
 * Perkiraan waktu sinkronisasi berikutnya berdasarkan catatan di database.
 *
 * Dipakai saat tidak ada penjadwal di dalam proses ini — misalnya function
 * Vercel yang hanya membaca, sementara yang menarik data adalah worker di mesin lain.
 */
export async function estimateNextRunAt() {
  const settings = await getSettings();
  if (!settings.auto_sync_enabled) return null;

  const row = await one(
    `SELECT started_at FROM sync_log WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`,
  );
  if (!row) return null;

  const intervalMs = Math.max(1, Number(settings.poll_interval_minutes) || 5) * 60_000;
  return new Date(Date.parse(row.started_at) + intervalMs).toISOString();
}

/**
 * Apakah datanya sudah basi.
 *
 * Penting pada susunan hybrid: yang menarik data adalah worker di PC gudang,
 * sedangkan dashboard tayang di Vercel. Kalau PC itu mati atau service-nya
 * berhenti, halaman tetap tampil normal dengan angka yang membeku diam-diam.
 * Ambangnya 3x interval supaya satu-dua kegagalan sementara tidak langsung
 * memunculkan peringatan.
 */
export async function getStaleness() {
  const settings = await getSettings();
  const row = await one(
    `SELECT started_at FROM sync_log WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`,
  );
  if (!row) return { stale: true, ageMs: null, reason: 'Belum pernah ada sinkronisasi berhasil' };

  const intervalMs = Math.max(1, Number(settings.poll_interval_minutes) || 5) * 60_000;
  const ageMs = Date.now() - Date.parse(row.started_at);
  const limitMs = intervalMs * 3;

  return {
    stale: settings.auto_sync_enabled ? ageMs > limitMs : false,
    ageMs,
    limitMs,
    lastSuccessAt: row.started_at,
  };
}

// -------------------- penjadwal proses panjang (mode lokal / VPS) --------------------

let timer = null;
let nextRunAt = null;

export function getNextRunAt() {
  return nextRunAt;
}

async function schedule() {
  clearTimeout(timer);
  const settings = await getSettings();
  if (!settings.auto_sync_enabled) {
    nextRunAt = null;
    return;
  }
  const minutes = Math.max(1, Number(settings.poll_interval_minutes) || 5);
  const delay = minutes * 60_000;
  nextRunAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(async () => {
    await runSync({ trigger: 'scheduler' });
    await schedule();
  }, delay);
}

/** Terapkan ulang jadwal setelah interval diubah dari halaman Pengaturan. */
export async function restartScheduler() {
  await schedule();
}

export async function startScheduler({ syncOnBoot = true } = {}) {
  if (syncOnBoot) await runSync({ trigger: 'startup' });
  await schedule();
}
