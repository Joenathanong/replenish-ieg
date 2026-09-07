import { all, one, run } from './db.js';
import {
  fetchReplenishLog,
  fetchReplenishDocs,
  fetchReplenishDocDetail,
} from './ocs.js';

/**
 * Sinkronisasi riwayat transaksi replenish dari OCS ke TiDB.
 *
 * Dua sumber yang saling melengkapi:
 *
 *   replenish_bin_log  — SKU masuk ke bin mana, berapa, kapan, oleh siapa.
 *                        Satu query, inkremental berdasarkan Id.
 *
 *   replenish_doc      — dokumen Inventory Transfer ke SAP beserta statusnya.
 *   replenish_doc_line   Baris detailnya hanya bisa diambil satu per satu,
 *                        jadi ditarik bertahap lewat antrean.
 */

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return max && s.length > max ? s.slice(0, max) : s;
};

/**
 * Normalkan cap waktu dari OCS ke ISO-8601 UTC.
 *
 * OCS mengirim bentuk seperti "2026-09-06T20:23:56.616673+07:00" — 32 karakter
 * karena memakai mikrodetik dan offset zona waktu. Menyimpannya apa adanya ke
 * kolom VARCHAR(30) memangkas offsetnya menjadi "+07:" sehingga tanggalnya
 * tidak bisa diurai sama sekali. Diseragamkan ke UTC 24 karakter, sama seperti
 * tabel stok, agar perbandingan dan pengurutan tetap benar.
 */
const toIso = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : String(v).slice(0, 30);
};

/** Baris per perintah INSERT, menjaga ukuran paket ke TiDB tetap wajar. */
const BATCH = 500;

/**
 * Tenggang mundur saat penarikan inkremental.
 *
 * Baris ber-Id kecil bisa selesai tersimpan setelah baris ber-Id besar bila ada
 * transaksi yang bersamaan. Mengambil sedikit ke belakang membuat baris seperti
 * itu tetap terjaring; penulisannya upsert sehingga tumpang tindih tidak
 * menimbulkan duplikat.
 */
const ID_LAG = 200;
const TIME_LAG_MS = 6 * 60 * 60_000; // 6 jam

/** Berapa dokumen yang detailnya ditarik dalam satu putaran sinkronisasi. */
const DETAIL_BATCH_DEFAULT = 150;

/** Panggilan serentak ke OCS saat mengambil detail. */
const DETAIL_CONCURRENCY = 6;

async function insertBatched(sql, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(sql, [rows.slice(i, i + BATCH)]);
  }
}

// -------------------- A. log per bin --------------------

const BIN_LOG_SQL = `
  INSERT INTO replenish_bin_log
    (id, seller_sku, bin_code, move_type, qty, created_at, created_by)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    seller_sku = VALUES(seller_sku),
    bin_code   = VALUES(bin_code),
    move_type  = VALUES(move_type),
    qty        = VALUES(qty),
    created_at = VALUES(created_at),
    created_by = VALUES(created_by)
`;

export async function syncBinLog() {
  const row = await one('SELECT MAX(id) AS maxId FROM replenish_bin_log');
  const sinceId = Math.max(0, (Number(row?.maxId) || 0) - ID_LAG);

  const rows = await fetchReplenishLog(sinceId);
  if (!rows.length) return { fetched: 0, stored: 0, sinceId };

  const values = rows
    .filter((r) => r.Id !== null && r.Id !== undefined && r.SellerSku)
    .map((r) => [
      int(r.Id),
      str(r.SellerSku, 120),
      str(r.BinCode, 60),
      str(r.Type, 16),
      int(r.Qty),
      toIso(r.CreatedAt),
      str(r.CreatedBy, 60),
    ]);

  await insertBatched(BIN_LOG_SQL, values);
  return { fetched: rows.length, stored: values.length, sinceId };
}

// -------------------- B. dokumen transfer --------------------

const DOC_SQL = `
  INSERT INTO replenish_doc
    (id, apdraft_id, from_whs, to_whs, tgl_dok, tgl_post, remark, status,
     doc_num, error_message, created_by, created_at, posted_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    apdraft_id    = VALUES(apdraft_id),
    from_whs      = VALUES(from_whs),
    to_whs        = VALUES(to_whs),
    tgl_dok       = VALUES(tgl_dok),
    tgl_post      = VALUES(tgl_post),
    remark        = VALUES(remark),
    status        = VALUES(status),
    doc_num       = VALUES(doc_num),
    error_message = VALUES(error_message),
    created_by    = VALUES(created_by),
    created_at    = VALUES(created_at),
    posted_at     = VALUES(posted_at)
`;
/*
 * detail_synced_at sengaja TIDAK ikut diperbarui di sini: dokumen yang detailnya
 * sudah pernah ditarik tidak boleh kembali masuk antrean hanya karena statusnya
 * berubah dari Pending menjadi Success.
 */

export async function syncDocs() {
  const row = await one('SELECT MAX(created_at) AS maxAt FROM replenish_doc');
  let sinceIso = null;
  if (row?.maxAt) {
    const t = Date.parse(row.maxAt);
    if (Number.isFinite(t)) sinceIso = new Date(t - TIME_LAG_MS).toISOString();
  }

  const docs = await fetchReplenishDocs(sinceIso);
  if (!docs.length) return { fetched: 0, stored: 0, sinceIso };

  const values = docs
    .filter((d) => d.Id)
    .map((d) => [
      str(d.Id, 36),
      d.ApdraftId === null || d.ApdraftId === undefined ? null : int(d.ApdraftId),
      str(d.FromWhs, 30),
      str(d.ToWhs, 30),
      str(d.TglDok, 10),
      str(d.TglPost, 10),
      str(d.Remark, 255),
      str(d.Status, 20),
      str(d.DocNum, 40),
      str(d.ErrorMessage, 4000),
      str(d.CreatedBy, 60),
      toIso(d.CreatedAt),
      toIso(d.PostedAt),
    ]);

  await insertBatched(DOC_SQL, values);
  return { fetched: docs.length, stored: values.length, sinceIso };
}

// -------------------- B2. baris detail dokumen --------------------

const LINE_SQL = `
  INSERT INTO replenish_doc_line
    (id, head_id, row_id, seller_sku, kode_barang, jumlah, satuan)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    head_id     = VALUES(head_id),
    row_id      = VALUES(row_id),
    seller_sku  = VALUES(seller_sku),
    kode_barang = VALUES(kode_barang),
    jumlah      = VALUES(jumlah),
    satuan      = VALUES(satuan)
`;

/** Menjalankan tugas dengan batas jumlah yang berjalan bersamaan. */
async function mapLimited(items, limit, worker) {
  const results = [];
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

export async function countPendingDetails() {
  const row = await one('SELECT COUNT(*) AS c FROM replenish_doc WHERE detail_synced_at IS NULL');
  return Number(row?.c) || 0;
}

/**
 * Menarik baris detail untuk dokumen yang belum punya.
 *
 * Dibatasi jumlahnya per pemanggilan supaya satu putaran sinkronisasi tidak
 * berjalan berjam-jam saat pertama kali dijalankan. Sisanya terkejar pada
 * putaran berikutnya, atau sekaligus lewat `npm run backfill-replenish`.
 */
export async function syncDocDetails({ limit = DETAIL_BATCH_DEFAULT, onProgress = null } = {}) {
  const pending = await all(
    `SELECT id FROM replenish_doc
      WHERE detail_synced_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
  );
  if (!pending.length) return { processed: 0, lines: 0, failed: 0, remaining: 0 };

  const now = new Date().toISOString();
  let lines = 0;
  let failed = 0;
  let done = 0;

  const collected = await mapLimited(pending, DETAIL_CONCURRENCY, async (doc) => {
    try {
      const { lines: detail } = await fetchReplenishDocDetail(doc.id);
      done++;
      if (onProgress) onProgress(done, pending.length);
      return { id: doc.id, detail };
    } catch (err) {
      failed++;
      done++;
      if (onProgress) onProgress(done, pending.length);
      // Dokumen yang gagal dibiarkan tanpa detail_synced_at supaya dicoba lagi nanti.
      console.warn(`[replenish] detail ${doc.id} gagal: ${err.message}`);
      return null;
    }
  });

  const lineValues = [];
  const doneIds = [];

  for (const item of collected) {
    if (!item) continue;
    doneIds.push(item.id);
    for (const l of item.detail) {
      if (!l?.Id) continue;
      lineValues.push([
        str(l.Id, 36),
        str(l.HeadId || item.id, 36),
        l.RowId === null || l.RowId === undefined ? null : int(l.RowId),
        str(l.SellerSku, 120),
        str(l.KodeBarang, 60),
        int(l.Jumlah),
        str(l.Satuan, 20),
      ]);
    }
    lines += item.detail.length;
  }

  if (lineValues.length) await insertBatched(LINE_SQL, lineValues);

  // Tandai selesai walau dokumennya tidak punya baris sama sekali, supaya tidak
  // ditarik ulang tanpa henti.
  for (let i = 0; i < doneIds.length; i += BATCH) {
    const chunk = doneIds.slice(i, i + BATCH);
    await run(
      `UPDATE replenish_doc
          SET detail_synced_at = ?,
              line_count = (SELECT COUNT(*) FROM replenish_doc_line WHERE head_id = replenish_doc.id)
        WHERE id IN (${chunk.map(() => '?').join(',')})`,
      [now, ...chunk],
    );
  }

  return {
    processed: doneIds.length,
    lines,
    failed,
    remaining: await countPendingDetails(),
  };
}

/** Satu putaran penuh: log per bin, dokumen, lalu sebagian detail. */
export async function syncReplenish({ detailLimit = DETAIL_BATCH_DEFAULT } = {}) {
  const t0 = Date.now();
  const binLog = await syncBinLog();
  const docs = await syncDocs();
  const details = await syncDocDetails({ limit: detailLimit });
  return { binLog, docs, details, durationMs: Date.now() - t0 };
}
