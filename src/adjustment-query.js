import { all, one } from './db.js';

/** LIMIT tidak menerima placeholder di MySQL, jadi angkanya divalidasi lalu disisipkan. */
function safeLimit(value, fallback, max = 2000) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Ringkasan untuk kartu KPI di halaman Adjustment Stok. */
export async function getAdjustmentSummary() {
  const [heads, lines, tipe, naik, turun, terakhir, pending] = await Promise.all([
    one('SELECT COUNT(*) AS c FROM adjustment_head'),
    one('SELECT COUNT(*) AS c FROM adjustment_line'),
    all('SELECT adj_type, COUNT(*) AS c FROM adjustment_head GROUP BY adj_type'),
    one('SELECT COALESCE(SUM(qty), 0) AS q FROM adjustment_line WHERE qty > 0'),
    one('SELECT COALESCE(SUM(qty), 0) AS q FROM adjustment_line WHERE qty < 0'),
    one('SELECT MAX(created_at) AS t FROM adjustment_head'),
    one('SELECT COUNT(*) AS c FROM adjustment_head WHERE detail_synced_at IS NULL'),
  ]);

  const perTipe = {};
  for (const r of tipe) perTipe[r.adj_type || '(kosong)'] = Number(r.c);

  return {
    totalTransaksi: Number(heads?.c) || 0,
    totalBaris: Number(lines?.c) || 0,
    perTipe,
    masuk: perTipe.IN || 0,
    keluar: perTipe.OUT || 0,
    qtyNaik: Number(naik?.q) || 0,
    qtyTurun: Number(turun?.q) || 0,
    transaksiTerakhir: terakhir?.t || null,
    detailBelumTertarik: Number(pending?.c) || 0,
  };
}

/** Nilai yang tersedia untuk mengisi pilihan filter di UI. */
export async function getAdjustmentFilterOptions() {
  const [tipe, shop, user, area] = await Promise.all([
    all("SELECT DISTINCT adj_type AS v FROM adjustment_head WHERE adj_type <> '' ORDER BY adj_type"),
    all("SELECT DISTINCT shop_code AS v FROM adjustment_head WHERE shop_code <> '' AND shop_code IS NOT NULL ORDER BY shop_code"),
    all("SELECT DISTINCT user_code AS v FROM adjustment_head WHERE user_code <> '' AND user_code IS NOT NULL ORDER BY user_code"),
    all("SELECT DISTINCT area_id AS v FROM adjustment_head WHERE area_id <> '' AND area_id IS NOT NULL ORDER BY area_id"),
  ]);
  const pick = (rows) => rows.map((r) => r.v).filter(Boolean);
  return { tipe: pick(tipe), shop: pick(shop), user: pick(user), area: pick(area) };
}

/**
 * Menyusun klausa filter bersama.
 *
 * Pencocokan SKU persis secara bawaan, sama seperti riwayat replenish:
 * "CUSHION-LIGHT-1" tidak boleh ikut menampilkan "REFILL-CUSHION-LIGHT-1".
 */
function buildFilter({ sku, mode, type, shop, user, area, from, to, remarks }) {
  const where = [];
  const params = [];

  if (sku && String(sku).trim()) {
    const q = String(sku).trim().toLowerCase();
    if (mode === 'contains') {
      where.push('LOWER(l.seller_sku) LIKE ?');
      params.push(`%${q}%`);
    } else {
      where.push('LOWER(l.seller_sku) = ?');
      params.push(q);
    }
  }
  if (type && type !== 'ALL') { where.push('h.adj_type = ?'); params.push(type); }
  if (shop && shop !== 'ALL') { where.push('h.shop_code = ?'); params.push(shop); }
  if (user && user !== 'ALL') { where.push('h.user_code = ?'); params.push(user); }
  if (area && area !== 'ALL') { where.push('h.area_id = ?'); params.push(area); }
  if (from) { where.push('h.created_at >= ?'); params.push(from); }
  // Tanggal "sampai" bersifat inklusif: pengguna menulis tanggal, bukan detik.
  if (to) { where.push('h.created_at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  if (remarks && String(remarks).trim()) {
    where.push('LOWER(l.remarks) LIKE ?');
    params.push(`%${String(remarks).trim().toLowerCase()}%`);
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Baris penyesuaian beserta header transaksinya.
 * Satu baris di sini = satu SKU pada satu transaksi, bentuk yang paling
 * berguna untuk ditelusuri maupun diekspor.
 */
export async function searchAdjustment(opts = {}) {
  const f = buildFilter(opts);
  const lim = safeLimit(opts.limit, 300);

  const rows = await all(
    `SELECT h.id, h.transaction_id, h.area_id, h.shop_code, h.user_code, h.adj_type, h.created_at,
            l.row_no, l.seller_sku, l.qty, l.remarks
       FROM adjustment_line l
       JOIN adjustment_head h ON h.id = l.head_id
       ${f.sql}
      ORDER BY h.created_at DESC, h.id DESC, l.row_no
      LIMIT ${lim}`,
    f.params,
  );

  // Total dihitung terpisah agar pengguna tahu ada berapa banyak sebenarnya,
  // bukan sekadar sebanyak yang muat pada batas tampilan.
  const total = await one(
    `SELECT COUNT(*) AS c, COALESCE(SUM(l.qty), 0) AS jumlah
       FROM adjustment_line l
       JOIN adjustment_head h ON h.id = l.head_id
       ${f.sql}`,
    f.params,
  );

  // Saran SKU serupa, selalu memakai pencocokan sebagian supaya pengguna yang
  // hanya ingat sepotong kode tidak buntu.
  let skuTerkait = [];
  if (opts.sku && String(opts.sku).trim()) {
    const like = `%${String(opts.sku).trim().toLowerCase()}%`;
    const s = await all(
      `SELECT seller_sku, COUNT(*) AS n FROM adjustment_line
        WHERE LOWER(seller_sku) LIKE ?
        GROUP BY seller_sku ORDER BY n DESC LIMIT 20`,
      [like],
    );
    skuTerkait = s.map((r) => ({ sku: r.seller_sku, jumlah: Number(r.n) }));
  }

  return {
    mode: opts.mode === 'contains' ? 'contains' : 'exact',
    rows,
    total: Number(total?.c) || 0,
    totalQty: Number(total?.jumlah) || 0,
    dibatasi: rows.length < (Number(total?.c) || 0),
    skuTerkait,
  };
}

/** Satu transaksi beserta seluruh barisnya. */
export async function getAdjustment(id) {
  const head = await one(
    `SELECT id, transaction_id, area_id, shop_code, user_code, adj_type, created_at,
            line_count, detail_synced_at
       FROM adjustment_head WHERE id = ?`,
    [id],
  );
  if (!head) return null;

  const lines = await all(
    'SELECT row_no, seller_sku, qty, remarks FROM adjustment_line WHERE head_id = ? ORDER BY row_no',
    [id],
  );
  return { ...head, lines };
}
