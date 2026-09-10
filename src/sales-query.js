import { all, one } from './db.js';

/**
 * Pembacaan data penjualan untuk menu Penjualan.
 *
 * Dua sudut pandang, sesuai dua laporan di OCS:
 *   Order — jumlah order per hari, dipecah per status, brand, dan platform.
 *   SKU   — jumlah barang terjual per hari per SKU.
 */

function safeLimit(value, fallback, max = 5000) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const tanggalSaja = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Klausa filter bersama untuk kedua laporan. */
function filterUmum({ from, to, area, platform, shop }, kolomShop = true) {
  const where = [];
  const params = [];
  if (from) { where.push('sales_date >= ?'); params.push(from); }
  if (to) { where.push('sales_date <= ?'); params.push(to); }
  if (area && area !== 'ALL') { where.push('area = ?'); params.push(area); }
  if (platform && platform !== 'ALL') { where.push('commerce_platform = ?'); params.push(platform); }
  if (kolomShop && shop && shop !== 'ALL') { where.push('shop_name = ?'); params.push(shop); }
  return { where, params };
}

/** Ringkasan untuk kartu KPI dan pilihan filter. */
export async function getSalesSummary({ from = null, to = null } = {}) {
  const f = filterUmum({ from, to });
  const clause = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';

  const [totalOrder, totalQty, perStatus, shops, platforms, areas, statuses, cakupan] = await Promise.all([
    one(`SELECT COALESCE(SUM(order_count), 0) AS t FROM sales_order_status_daily ${clause}`, f.params),
    one(`SELECT COALESCE(SUM(qty), 0) AS t FROM sales_sku_daily ${clause}`, f.params),
    all(
      `SELECT status, COALESCE(SUM(order_count), 0) AS jumlah
         FROM sales_order_status_daily ${clause}
        GROUP BY status ORDER BY jumlah DESC`,
      f.params,
    ),
    all('SELECT DISTINCT shop_name AS v FROM sales_order_shop_daily ORDER BY shop_name'),
    all('SELECT DISTINCT commerce_platform AS v FROM sales_order_status_daily ORDER BY commerce_platform'),
    all('SELECT DISTINCT area AS v FROM sales_order_shop_daily ORDER BY area'),
    all('SELECT DISTINCT status AS v FROM sales_order_status_daily ORDER BY status'),
    one('SELECT MIN(sales_date) AS dari, MAX(sales_date) AS sampai, COUNT(*) AS hari, MAX(pulled_at) AS terakhir FROM sales_sync_day'),
  ]);

  const pick = (rows) => rows.map((r) => r.v).filter((x) => x !== null && x !== '');

  return {
    totalOrder: Number(totalOrder?.t) || 0,
    totalQty: Number(totalQty?.t) || 0,
    perStatus: perStatus.map((r) => ({ status: r.status, jumlah: Number(r.jumlah) })),
    filters: {
      shop: pick(shops),
      platform: pick(platforms),
      area: pick(areas),
      status: pick(statuses),
    },
    cakupan: {
      dari: tanggalSaja(cakupan?.dari),
      sampai: tanggalSaja(cakupan?.sampai),
      hari: Number(cakupan?.hari) || 0,
      terakhir: cakupan?.terakhir || null,
    },
  };
}

/**
 * Laporan Order: jumlah order per hari.
 *
 * Bisa dikelompokkan per hari saja, atau dipecah lebih rinci. Nilai status
 * dijadikan kolom hasil pivot supaya terbaca seperti tabel di OCS.
 */
export async function getSalesOrders({
  from = null, to = null, area = 'ALL', platform = 'ALL', shop = 'ALL',
  status = 'ALL', groupBy = 'date', limit = 1000,
} = {}) {
  const f = filterUmum({ from, to, area, platform, shop });
  if (status && status !== 'ALL') { f.where.push('status = ?'); f.params.push(status); }
  const clause = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';

  const dimensi = {
    date: ['sales_date'],
    shop: ['sales_date', 'shop_name'],
    platform: ['sales_date', 'commerce_platform'],
    detail: ['sales_date', 'shop_name', 'commerce_platform'],
  }[groupBy] || ['sales_date'];

  const kolom = dimensi.join(', ');

  const rows = await all(
    `SELECT ${kolom}, status, COALESCE(SUM(order_count), 0) AS jumlah
       FROM sales_order_status_daily ${clause}
      GROUP BY ${kolom}, status
      ORDER BY sales_date DESC`,
    f.params,
  );

  // Pivot di sisi aplikasi: status menjadi kolom, bukan baris.
  const peta = new Map();
  const semuaStatus = new Set();

  for (const r of rows) {
    const kunci = dimensi.map((d) => tanggalSaja(r[d]) ?? r[d]).join('|');
    if (!peta.has(kunci)) {
      const dasar = { total: 0, status: {} };
      dimensi.forEach((d) => { dasar[d] = d === 'sales_date' ? tanggalSaja(r[d]) : r[d]; });
      peta.set(kunci, dasar);
    }
    const baris = peta.get(kunci);
    const n = Number(r.jumlah) || 0;
    baris.status[r.status] = (baris.status[r.status] || 0) + n;
    baris.total += n;
    semuaStatus.add(r.status);
  }

  const hasil = [...peta.values()].slice(0, safeLimit(limit, 1000));

  // SOI/MOI hanya tersedia pada tingkat shop, jadi hanya disertakan bila
  // pengelompokannya memang sampai ke sana.
  if (groupBy === 'date' || groupBy === 'shop') {
    const fs = filterUmum({ from, to, area, shop });
    const cs = fs.where.length ? `WHERE ${fs.where.join(' AND ')}` : '';
    const kol = groupBy === 'shop' ? 'sales_date, shop_name' : 'sales_date';
    const sm = await all(
      `SELECT ${kol}, COALESCE(SUM(soi), 0) AS soi, COALESCE(SUM(moi), 0) AS moi
         FROM sales_order_shop_daily ${cs} GROUP BY ${kol}`,
      fs.params,
    );
    const idx = new Map(sm.map((r) => [
      groupBy === 'shop' ? `${tanggalSaja(r.sales_date)}|${r.shop_name}` : tanggalSaja(r.sales_date),
      r,
    ]));
    for (const b of hasil) {
      const k = groupBy === 'shop' ? `${b.sales_date}|${b.shop_name}` : b.sales_date;
      const m = idx.get(k);
      b.soi = Number(m?.soi) || 0;
      b.moi = Number(m?.moi) || 0;
    }
  }

  return {
    groupBy,
    statusColumns: [...semuaStatus].sort(),
    rows: hasil,
    totalRows: peta.size,
  };
}

/** Laporan SKU: jumlah barang terjual, bisa diringkas atau dirinci per hari. */
export async function getSalesSku({
  from = null, to = null, area = 'ALL', platform = 'ALL',
  sku = null, mode = 'exact', groupBy = 'sku', limit = 500,
} = {}) {
  const f = filterUmum({ from, to, area, platform }, false);

  if (sku && String(sku).trim()) {
    const q = String(sku).trim().toLowerCase();
    if (mode === 'contains') { f.where.push('LOWER(seller_sku) LIKE ?'); f.params.push(`%${q}%`); }
    else { f.where.push('LOWER(seller_sku) = ?'); f.params.push(q); }
  }

  const clause = f.where.length ? `WHERE ${f.where.join(' AND ')}` : '';
  const dimensi = {
    sku: ['seller_sku'],
    day: ['sales_date', 'seller_sku'],
    platform: ['seller_sku', 'commerce_platform'],
  }[groupBy] || ['seller_sku'];
  const kolom = dimensi.join(', ');

  const rows = await all(
    `SELECT ${kolom}, COALESCE(SUM(qty), 0) AS qty, COUNT(DISTINCT sales_date) AS hari
       FROM sales_sku_daily ${clause}
      GROUP BY ${kolom}
      ORDER BY qty DESC
      LIMIT ${safeLimit(limit, 500)}`,
    f.params,
  );

  const total = await one(
    `SELECT COALESCE(SUM(qty), 0) AS qty, COUNT(DISTINCT seller_sku) AS sku
       FROM sales_sku_daily ${clause}`,
    f.params,
  );

  // Saran SKU serupa, selalu memakai pencocokan sebagian.
  let skuTerkait = [];
  if (sku && String(sku).trim()) {
    const like = `%${String(sku).trim().toLowerCase()}%`;
    const s = await all(
      `SELECT seller_sku, COALESCE(SUM(qty), 0) AS qty FROM sales_sku_daily
        WHERE LOWER(seller_sku) LIKE ?
        GROUP BY seller_sku ORDER BY qty DESC LIMIT 20`,
      [like],
    );
    skuTerkait = s.map((r) => ({ sku: r.seller_sku, jumlah: Number(r.qty) }));
  }

  return {
    groupBy,
    mode: mode === 'contains' ? 'contains' : 'exact',
    rows: rows.map((r) => ({
      ...r,
      sales_date: r.sales_date ? tanggalSaja(r.sales_date) : undefined,
      qty: Number(r.qty),
      hari: Number(r.hari),
    })),
    totalQty: Number(total?.qty) || 0,
    totalSku: Number(total?.sku) || 0,
    skuTerkait,
  };
}

/** Daftar hari yang sudah tersimpan, untuk halaman penarikan data. */
export async function getSalesDays(limit = 400) {
  const rows = await all(
    `SELECT sales_date, order_rows, sku_rows, pulled_at, stable_count
       FROM sales_sync_day ORDER BY sales_date DESC LIMIT ${safeLimit(limit, 400, 2000)}`,
  );
  return rows.map((r) => ({
    tanggal: tanggalSaja(r.sales_date),
    orderRows: Number(r.order_rows),
    skuRows: Number(r.sku_rows),
    pulledAt: r.pulled_at,
    stableCount: Number(r.stable_count) || 0,
  }));
}
