import { all, one, run } from './db.js';
import { getAtpConfig, hitungAtp, KOLOM_STOK } from './atp.js';

/** Pembacaan data untuk menu ATP Monitoring. */

function safeLimit(value, fallback, max = 3000) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const tanggalSaja = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Status aktif yang berlaku: override manusia bila ada, kalau tidak ikut OCS. */
const AKTIF = 'COALESCE(b.is_active_override, b.is_active_ocs) = 1';

/**
 * Data dashboard: ATP keseluruhan, per cabang, per brand, dan trennya.
 * Dihitung dari keadaan sekarang — rekaman harian dipakai untuk grafik tren.
 */
export async function getAtpDashboard({ shop = 'ALL' } = {}) {
  const cfg = await getAtpConfig();
  const hasil = await hitungAtp();

  const cocok = (r) => shop === 'ALL' || r.shop === shop;
  const rows = hasil.rows.filter(cocok);

  const jumlah = (arr) => arr.reduce((a, r) => ({ active: a.active + r.active, ready: a.ready + r.ready }), { active: 0, ready: 0 });
  const pct = (x) => (x.active ? (x.ready / x.active) * 100 : 0);

  const cabangSet = [...new Set(rows.map((r) => r.branch))];
  const brandSet = [...new Set(hasil.rows.map((r) => r.shop))].sort();

  const perCabang = cabangSet.map((c) => {
    const semua = rows.filter((r) => r.branch === c);
    const sku = jumlah(semua.filter((r) => r.category === 'Sku'));
    const bdl = jumlah(semua.filter((r) => r.category === 'Bundle'));
    const tot = jumlah(semua);
    return {
      branch: c,
      total: { ...tot, pct: pct(tot) },
      sku: { ...sku, pct: pct(sku) },
      bundle: { ...bdl, pct: pct(bdl) },
    };
  }).sort((a, b) => a.total.pct - b.total.pct);

  const perBrand = [...new Set(rows.map((r) => r.shop))].map((s) => {
    const tot = jumlah(rows.filter((r) => r.shop === s));
    return { shop: s, ...tot, pct: pct(tot) };
  }).sort((a, b) => b.active - a.active);

  /*
   * Matriks cabang x brand untuk peta panas.
   * Urutan barisnya mengikuti peringkat di atas — cabang terlemah lebih dulu —
   * supaya pembaca tidak perlu mencocokkan dua urutan yang berbeda.
   */
  const matriks = perCabang.map((pc) => pc.branch).map((c) => ({
    branch: c,
    cells: perBrand.map((b) => {
      const x = jumlah(rows.filter((r) => r.branch === c && r.shop === b.shop));
      return { shop: b.shop, ...x, pct: pct(x) };
    }),
  }));

  const total = jumlah(rows);

  const [tren, cabangInfo, terakhir] = await Promise.all([
    all(
      `SELECT snapshot_date,
              SUM(active_count) AS active_count,
              SUM(ready_count)  AS ready_count
         FROM atp_snapshot
        GROUP BY snapshot_date
        ORDER BY snapshot_date DESC
        LIMIT 60`,
    ),
    all('SELECT code, name, ocs_area, is_active FROM atp_branch ORDER BY sort_order, name'),
    one('SELECT MAX(updated_at) AS t FROM atp_sku_branch'),
  ]);

  return {
    config: { ...cfg, pilihanKolom: KOLOM_STOK },
    total: { ...total, pct: pct(total) },
    perCabang,
    perBrand,
    matriks,
    brands: brandSet,
    cabang: cabangInfo,
    tren: tren.map((r) => ({
      tanggal: tanggalSaja(r.snapshot_date),
      active: Number(r.active_count),
      ready: Number(r.ready_count),
      pct: Number(r.active_count) ? (Number(r.ready_count) / Number(r.active_count)) * 100 : 0,
    })).reverse(),
    terakhirDitarik: terakhir?.t || null,
  };
}

/**
 * Master data: satu baris per SKU, dengan kolom stok dan status aktif
 * untuk setiap cabang.
 */
export async function getAtpMaster({
  search = null, shop = 'ALL', category = 'ALL',
  branch = 'ALL', status = 'ALL', limit = 300,
} = {}) {
  const cfg = await getAtpConfig();
  const cabang = await all('SELECT code, name FROM atp_branch WHERE is_active = 1 ORDER BY sort_order, name');

  const where = [];
  const params = [];

  if (search && String(search).trim()) {
    const q = `%${String(search).trim().toLowerCase()}%`;
    where.push('(LOWER(s.sku) LIKE ? OR LOWER(s.name) LIKE ? OR LOWER(s.sap_code) LIKE ?)');
    params.push(q, q, q);
  }
  if (shop && shop !== 'ALL') { where.push('s.shop_code = ?'); params.push(shop); }
  if (category && category !== 'ALL') {
    where.push(category === 'Bundle' ? 's.is_bundle = 1' : 's.is_bundle = 0');
  }

  /*
   * Penyaringan status dan cabang memakai EXISTS, bukan JOIN, supaya satu SKU
   * tidak terduplikasi ketika cocok di beberapa cabang sekaligus.
   */
  if (branch && branch !== 'ALL') {
    if (status === 'AKTIF') {
      where.push(`EXISTS (SELECT 1 FROM atp_sku_branch b WHERE b.sku = s.sku AND b.branch_code = ? AND ${AKTIF})`);
      params.push(branch);
    } else if (status === 'SIAP') {
      where.push(`EXISTS (SELECT 1 FROM atp_sku_branch b WHERE b.sku = s.sku AND b.branch_code = ? AND ${AKTIF} AND b.${cfg.stockField} > ?)`);
      params.push(branch, cfg.threshold);
    } else if (status === 'KOSONG') {
      where.push(`EXISTS (SELECT 1 FROM atp_sku_branch b WHERE b.sku = s.sku AND b.branch_code = ? AND ${AKTIF} AND b.${cfg.stockField} <= ?)`);
      params.push(branch, cfg.threshold);
    } else {
      where.push('EXISTS (SELECT 1 FROM atp_sku_branch b WHERE b.sku = s.sku AND b.branch_code = ?)');
      params.push(branch);
    }
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = safeLimit(limit, 300);

  const [skus, total] = await Promise.all([
    all(
      `SELECT s.sku, s.name, s.category, s.shop_code, s.sap_code, s.is_bundle
         FROM atp_sku s ${clause}
        ORDER BY s.sku LIMIT ${lim}`,
      params,
    ),
    one(`SELECT COUNT(*) AS c FROM atp_sku s ${clause}`, params),
  ]);

  /*
   * Ringkasan per cabang dihitung ulang dari database memakai penyaring yang
   * sama, bukan dari baris yang kebetulan tampil. Kalau dihitung di layar,
   * angkanya hanya mencakup 300 baris pertama dan justru menyesatkan.
   */
  const ringkasan = await all(
    `SELECT b.branch_code,
            COUNT(*)                                                   AS total,
            SUM(${AKTIF})                                              AS aktif,
            SUM(b.is_active_override IS NOT NULL)                      AS ditimpa,
            SUM(${AKTIF} AND b.${cfg.stockField} > ?)                  AS siap
       FROM atp_sku_branch b
      WHERE b.sku IN (SELECT s.sku FROM atp_sku s ${clause})
      GROUP BY b.branch_code`,
    [cfg.threshold, ...params],
  );
  const petaRingkasan = new Map(ringkasan.map((r) => [r.branch_code, r]));

  // Ambil baris cabang hanya untuk SKU yang ditampilkan.
  const daftar = skus.map((r) => r.sku);
  const perCabang = new Map();

  if (daftar.length) {
    const rows = await all(
      `SELECT b.sku, b.branch_code, b.qty_on_hand, b.available_qty, b.qty_rack,
              b.is_active_ocs, b.is_active_override
         FROM atp_sku_branch b
        WHERE b.sku IN (${daftar.map(() => '?').join(',')})`,
      daftar,
    );
    for (const r of rows) {
      if (!perCabang.has(r.sku)) perCabang.set(r.sku, {});
      const aktif = r.is_active_override === null ? !!r.is_active_ocs : !!r.is_active_override;
      perCabang.get(r.sku)[r.branch_code] = {
        qtyOnHand: Number(r.qty_on_hand),
        availableQty: Number(r.available_qty),
        qtyRack: Number(r.qty_rack),
        aktifOcs: !!r.is_active_ocs,
        override: r.is_active_override === null ? null : !!r.is_active_override,
        aktif,
        siap: aktif && Number(r[cfg.stockField]) > cfg.threshold,
      };
    }
  }

  return {
    config: cfg,
    cabang,
    ringkasan: cabang.map((c) => {
      const r = petaRingkasan.get(c.code);
      return {
        branch: c.code,
        name: c.name,
        total: Number(r?.total) || 0,
        aktif: Number(r?.aktif) || 0,
        ditimpa: Number(r?.ditimpa) || 0,
        siap: Number(r?.siap) || 0,
      };
    }),
    total: Number(total?.c) || 0,
    dibatasi: skus.length < (Number(total?.c) || 0),
    items: skus.map((r) => ({
      sku: r.sku,
      name: r.name,
      category: r.category,
      shop: r.shop_code,
      sapCode: r.sap_code,
      isBundle: !!r.is_bundle,
      branches: perCabang.get(r.sku) || {},
    })),
  };
}

/** Komponen satu bundle beserta stoknya di tiap cabang. */
export async function getBundleDetail(sku) {
  const cfg = await getAtpConfig();
  const items = await all(
    `SELECT i.component_sku, i.qty, s.name, s.shop_code
       FROM atp_bundle_item i
       LEFT JOIN atp_sku s ON s.sku = i.component_sku
      WHERE i.bundle_sku = ?
      ORDER BY i.component_sku`,
    [sku],
  );
  if (!items.length) return { sku, items: [] };

  const kode = items.map((i) => i.component_sku);
  const stok = await all(
    `SELECT sku, branch_code, qty_on_hand, available_qty, qty_rack
       FROM atp_sku_branch
      WHERE sku IN (${kode.map(() => '?').join(',')})`,
    kode,
  );

  const peta = new Map();
  for (const r of stok) {
    if (!peta.has(r.sku)) peta.set(r.sku, {});
    peta.get(r.sku)[r.branch_code] = {
      qtyOnHand: Number(r.qty_on_hand),
      availableQty: Number(r.available_qty),
      qtyRack: Number(r.qty_rack),
    };
  }

  return {
    sku,
    config: cfg,
    items: items.map((i) => ({
      sku: i.component_sku,
      name: i.name,
      shop: i.shop_code,
      qty: Number(i.qty),
      branches: peta.get(i.component_sku) || {},
    })),
  };
}

/** Ubah status aktif manual untuk satu SKU di satu cabang. */
export async function setOverride(sku, branch, nilai) {
  const v = nilai === null ? null : (nilai ? 1 : 0);
  const res = await run(
    'UPDATE atp_sku_branch SET is_active_override = ? WHERE sku = ? AND branch_code = ?',
    [v, sku, branch],
  );
  if (!res.affectedRows) throw new Error('SKU tidak terdaftar di cabang tersebut');
  return { sku, branch, override: v === null ? null : !!v };
}

/** Riwayat rekaman harian, untuk grafik dan tabel tren. */
export async function getAtpHistory({ days = 60, branch = 'ALL', shop = 'ALL' } = {}) {
  const where = [];
  const params = [];
  if (branch && branch !== 'ALL') { where.push('branch_code = ?'); params.push(branch); }
  if (shop && shop !== 'ALL') { where.push('shop_code = ?'); params.push(shop); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await all(
    `SELECT snapshot_date, branch_code,
            SUM(active_count) AS active_count,
            SUM(ready_count)  AS ready_count,
            MAX(stock_field)  AS stock_field,
            MAX(threshold)    AS threshold,
            MAX(taken_at)     AS taken_at
       FROM atp_snapshot ${clause}
      GROUP BY snapshot_date, branch_code
      ORDER BY snapshot_date DESC, branch_code
      LIMIT ${safeLimit(days * 10, 600, 3000)}`,
    params,
  );

  return rows.map((r) => ({
    tanggal: tanggalSaja(r.snapshot_date),
    branch: r.branch_code,
    active: Number(r.active_count),
    ready: Number(r.ready_count),
    pct: Number(r.active_count) ? (Number(r.ready_count) / Number(r.active_count)) * 100 : 0,
    stockField: r.stock_field,
    threshold: Number(r.threshold),
    takenAt: r.taken_at,
  }));
}
