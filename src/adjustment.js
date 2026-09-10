import { all, one, run } from './db.js';
import { fetchAdjustments, fetchAdjustmentDetails } from './ocs.js';

/**
 * Sinkronisasi riwayat penyesuaian stok dari OCS ke TiDB.
 *
 * Jauh lebih ringan daripada riwayat replenish: headernya bisa ditarik
 * inkremental berdasarkan Id, dan detailnya bisa diminta beberapa transaksi
 * sekaligus — sehingga seluruh riwayat selesai dalam hitungan detik dan tidak
 * memerlukan antrean bertahap.
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

/** Cap waktu OCS memakai mikrodetik dan offset zona waktu; diseragamkan ke UTC. */
const toIso = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : String(v).slice(0, 30);
};

const BATCH = 500;

/** Jumlah Id per permintaan detail. 250 terbukti dilayani dalam ~1,5 detik. */
const DETAIL_CHUNK = 250;

/** Tenggang mundur agar baris yang tersimpan terlambat tetap terjaring. */
const ID_LAG = 50;

async function insertBatched(sql, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(sql, [rows.slice(i, i + BATCH)]);
  }
}

const HEAD_SQL = `
  INSERT INTO adjustment_head
    (id, transaction_id, area_id, shop_code, user_code, adj_type, created_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    transaction_id = VALUES(transaction_id),
    area_id        = VALUES(area_id),
    shop_code      = VALUES(shop_code),
    user_code      = VALUES(user_code),
    adj_type       = VALUES(adj_type),
    created_at     = VALUES(created_at)
`;
/* detail_synced_at sengaja tidak ikut ditimpa agar detail yang sudah ada
   tidak ditarik ulang tanpa alasan. */

const LINE_SQL = `
  INSERT INTO adjustment_line (head_id, row_no, seller_sku, qty, remarks)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    seller_sku = VALUES(seller_sku),
    qty        = VALUES(qty),
    remarks    = VALUES(remarks)
`;

export async function syncAdjustmentHeads() {
  const row = await one('SELECT MAX(id) AS maxId FROM adjustment_head');
  const sinceId = Math.max(0, (Number(row?.maxId) || 0) - ID_LAG);

  const rows = await fetchAdjustments(sinceId);
  if (!rows.length) return { fetched: 0, stored: 0, sinceId };

  const values = rows
    .filter((r) => r.Id !== null && r.Id !== undefined)
    .map((r) => [
      int(r.Id),
      str(r.TransactionId, 60),
      str(r.AreaId, 60),
      str(r.ShopCode, 60),
      str(r.UserCode, 60),
      str(r.Type, 16),
      toIso(r.CreatedAt),
    ]);

  await insertBatched(HEAD_SQL, values);
  return { fetched: rows.length, stored: values.length, sinceId };
}

export async function countPendingAdjustmentDetails() {
  const row = await one('SELECT COUNT(*) AS c FROM adjustment_head WHERE detail_synced_at IS NULL');
  return Number(row?.c) || 0;
}

/**
 * Menarik baris detail untuk transaksi yang belum punya.
 * `limit` menahan agar satu pemanggilan di lingkungan serverless tetap muat
 * dalam anggaran waktunya; di worker nilainya dibuat besar sehingga sekali
 * jalan biasanya sudah tuntas.
 */
export async function syncAdjustmentDetails({ limit = 2000 } = {}) {
  const pending = await all(
    `SELECT id FROM adjustment_head
      WHERE detail_synced_at IS NULL
      ORDER BY id DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
  );
  if (!pending.length) return { processed: 0, lines: 0, remaining: 0 };

  const now = new Date().toISOString();
  const ids = pending.map((p) => Number(p.id));
  let lines = 0;
  let processed = 0;

  for (let i = 0; i < ids.length; i += DETAIL_CHUNK) {
    const chunk = ids.slice(i, i + DETAIL_CHUNK);
    const hasil = await fetchAdjustmentDetails(chunk);

    const lineValues = [];
    const selesai = [];

    for (const entry of hasil) {
      const headId = int(entry?.Id);
      if (!headId) continue;
      selesai.push(headId);

      (entry.Details || []).forEach((d, index) => {
        lineValues.push([
          headId,
          index + 1,
          str(d?.SellerSku, 120),
          int(d?.Qty),
          str(d?.Remarks, 500),
        ]);
      });
    }

    if (lineValues.length) await insertBatched(LINE_SQL, lineValues);
    lines += lineValues.length;

    /*
     * Transaksi yang diminta tetapi tidak dikembalikan sumbernya ikut ditandai
     * selesai. Kalau tidak, ia akan diminta lagi pada setiap putaran tanpa
     * pernah menghasilkan apa pun.
     */
    const ditandai = chunk;
    processed += ditandai.length;

    for (let j = 0; j < ditandai.length; j += BATCH) {
      const part = ditandai.slice(j, j + BATCH);
      await run(
        `UPDATE adjustment_head
            SET detail_synced_at = ?,
                line_count = (SELECT COUNT(*) FROM adjustment_line WHERE head_id = adjustment_head.id)
          WHERE id IN (${part.map(() => '?').join(',')})`,
        [now, ...part],
      );
    }
  }

  return { processed, lines, remaining: await countPendingAdjustmentDetails() };
}

/** Satu putaran penuh riwayat adjustment. */
export async function syncAdjustment({ detailLimit = 2000 } = {}) {
  const t0 = Date.now();
  const heads = await syncAdjustmentHeads();
  const details = await syncAdjustmentDetails({ limit: detailLimit });
  return { heads, details, durationMs: Date.now() - t0 };
}
