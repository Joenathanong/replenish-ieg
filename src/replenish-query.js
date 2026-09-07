import { all, one } from './db.js';

/**
 * Pembacaan data untuk menu Transaksi Replenish.
 *
 * Dua sudut pandang atas kejadian yang sama:
 *   - replenish_bin_log  : barang masuk ke rak mana
 *   - replenish_doc(+line): dokumen transfer ke SAP dan statusnya
 */

/** LIMIT tidak menerima placeholder di MySQL, jadi angkanya divalidasi lalu disisipkan. */
function safeLimit(value, fallback, max = 2000) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Ringkasan untuk kartu KPI di halaman Transaksi Replenish. */
export async function getReplenishSummary() {
  const [docs, lines, binlog, status, pending, terakhir] = await Promise.all([
    one('SELECT COUNT(*) AS c FROM replenish_doc'),
    one('SELECT COUNT(*) AS c FROM replenish_doc_line'),
    one('SELECT COUNT(*) AS c FROM replenish_bin_log'),
    all('SELECT status, COUNT(*) AS c FROM replenish_doc GROUP BY status'),
    one('SELECT COUNT(*) AS c FROM replenish_doc WHERE detail_synced_at IS NULL'),
    one('SELECT MAX(created_at) AS t FROM replenish_doc'),
  ]);

  const perStatus = {};
  for (const r of status) perStatus[r.status || '(kosong)'] = Number(r.c);

  return {
    totalDokumen: Number(docs?.c) || 0,
    totalBarisDetail: Number(lines?.c) || 0,
    totalLogBin: Number(binlog?.c) || 0,
    perStatus,
    gagal: perStatus.Failed || 0,
    berhasil: perStatus.Success || 0,
    tertunda: perStatus.Pending || 0,
    detailBelumTertarik: Number(pending?.c) || 0,
    dokumenTerakhir: terakhir?.t || null,
  };
}

/**
 * Pencarian per SKU.
 *
 * Bawaannya mencocokkan kode secara **persis**. Pencocokan sebagian pernah
 * menjadi bawaan agar pengguna tidak perlu mengetik kode lengkap, tetapi itu
 * mencampur produk yang berbeda: mencari "CUSHION-LIGHT-1" ikut menampilkan
 * "REFILL-CUSHION-LIGHT-1", dan angkanya tergabung tanpa disadari.
 *
 * Perbandingannya tetap mengabaikan besar-kecil huruf, karena itu soal cara
 * mengetik, bukan soal identitas barang. Pencocokan sebagian masih tersedia
 * lewat `mode: 'contains'`, dan daftar SKU serupa selalu disertakan sebagai
 * saran sehingga pengguna yang hanya ingat sepotong kode tidak buntu.
 */
export async function searchBySku(query, { limit = 200, from = null, to = null, mode = 'exact' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: q, mode, binLog: [], docLines: [], skuTerkait: [] };

  const persis = mode !== 'contains';
  const like = `%${q.toLowerCase()}%`;
  const cocok = persis ? q.toLowerCase() : like;
  const operator = persis ? '=' : 'LIKE';
  const lim = safeLimit(limit, 200);

  const range = (col) => {
    const parts = [];
    const params = [];
    if (from) { parts.push(`AND ${col} >= ?`); params.push(from); }
    if (to) { parts.push(`AND ${col} <= ?`); params.push(`${to}￿`); }
    return { sql: parts.join(' '), params };
  };

  const rBin = range('created_at');
  const rDoc = range('d.created_at');

  const [binLog, docLines, skuTerkait] = await Promise.all([
    all(
      `SELECT id, seller_sku, bin_code, move_type, qty, created_at, created_by
         FROM replenish_bin_log
        WHERE LOWER(seller_sku) ${operator} ? ${rBin.sql}
        ORDER BY created_at DESC
        LIMIT ${lim}`,
      [cocok, ...rBin.params],
    ),
    all(
      `SELECT l.id, l.head_id, l.row_id, l.seller_sku, l.kode_barang, l.jumlah, l.satuan,
              d.doc_num, d.status, d.from_whs, d.to_whs, d.tgl_dok, d.tgl_post,
              d.remark, d.error_message, d.created_by, d.created_at, d.posted_at
         FROM replenish_doc_line l
         JOIN replenish_doc d ON d.id = l.head_id
        WHERE LOWER(l.seller_sku) ${operator} ? ${rDoc.sql}
        ORDER BY d.created_at DESC
        LIMIT ${lim}`,
      [cocok, ...rDoc.params],
    ),
    // Saran SKU selalu memakai pencocokan sebagian, bahkan saat mode persis:
    // inilah yang menolong pengguna yang salah ketik atau hanya ingat sepotong
    // kode, tanpa mencampurkannya ke dalam hasil utama.
    all(
      `SELECT seller_sku, COUNT(*) AS n FROM (
         SELECT seller_sku FROM replenish_bin_log WHERE LOWER(seller_sku) LIKE ?
         UNION ALL
         SELECT seller_sku FROM replenish_doc_line WHERE LOWER(seller_sku) LIKE ?
       ) x
       GROUP BY seller_sku
       ORDER BY n DESC
       LIMIT 30`,
      [like, like],
    ),
  ]);

  return {
    query: q,
    mode: persis ? 'exact' : 'contains',
    binLog,
    docLines,
    skuTerkait: skuTerkait.map((r) => ({ sku: r.seller_sku, jumlah: Number(r.n) })),
  };
}

/** Daftar dokumen terbaru, bisa disaring per status. */
export async function listDocs({ status = null, search = null, limit = 100 } = {}) {
  const where = [];
  const params = [];

  if (status && status !== 'ALL') {
    where.push('d.status = ?');
    params.push(status);
  }
  if (search) {
    const like = `%${String(search).trim().toLowerCase()}%`;
    where.push('(LOWER(d.doc_num) LIKE ? OR LOWER(d.remark) LIKE ? OR LOWER(d.created_by) LIKE ?)');
    params.push(like, like, like);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return all(
    `SELECT d.id, d.doc_num, d.status, d.from_whs, d.to_whs, d.tgl_dok, d.tgl_post,
            d.remark, d.error_message, d.created_by, d.created_at, d.posted_at,
            d.line_count, d.detail_synced_at
       FROM replenish_doc d
       ${clause}
      ORDER BY d.created_at DESC
      LIMIT ${safeLimit(limit, 100)}`,
    params,
  );
}

/** Satu dokumen beserta baris detailnya. */
export async function getDoc(id) {
  const head = await one(
    `SELECT id, doc_num, status, from_whs, to_whs, tgl_dok, tgl_post, remark,
            error_message, created_by, created_at, posted_at, line_count, detail_synced_at,
            apdraft_id
       FROM replenish_doc WHERE id = ?`,
    [id],
  );
  if (!head) return null;

  const lines = await all(
    `SELECT id, row_id, seller_sku, kode_barang, jumlah, satuan
       FROM replenish_doc_line WHERE head_id = ? ORDER BY row_id`,
    [id],
  );
  return { ...head, lines };
}

/** Saran SKU untuk kotak pencarian. */
export async function suggestSku(query, limit = 12) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const like = `%${q.toLowerCase()}%`;

  const rows = await all(
    `SELECT seller_sku, COUNT(*) AS n, MAX(created_at) AS terakhir FROM (
       SELECT seller_sku, created_at FROM replenish_bin_log WHERE LOWER(seller_sku) LIKE ?
       UNION ALL
       SELECT l.seller_sku, d.created_at
         FROM replenish_doc_line l JOIN replenish_doc d ON d.id = l.head_id
        WHERE LOWER(l.seller_sku) LIKE ?
     ) x
     GROUP BY seller_sku
     ORDER BY terakhir DESC
     LIMIT ${safeLimit(limit, 12, 50)}`,
    [like, like],
  );

  return rows.map((r) => ({
    sku: r.seller_sku,
    transaksi: Number(r.n),
    terakhir: r.terakhir,
  }));
}
