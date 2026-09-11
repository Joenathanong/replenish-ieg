import { all, one, run, getSettings } from './db.js';
import { fetchAtpStock, fetchAtpSkuRack, fetchAtpBundles, fetchAtpAreas } from './ocs.js';

/**
 * ATP Monitoring — penarikan dan perhitungan.
 *
 * ATP = persentase SKU aktif yang stoknya di atas ambang, dihitung per cabang.
 * Sumbernya stok fisik OCS per area, memakai akun yang bisa melihat kelima
 * cabang sekaligus.
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

const BATCH = 500;

/** Kolom stok yang boleh dipakai sebagai dasar perhitungan. */
export const KOLOM_STOK = {
  qty_on_hand: 'Stok fisik (QtyOnHand)',
  available_qty: 'Siap jual (AvailableQty)',
  qty_rack: 'Stok rak (QtyGudangKecil)',
};

async function insertBatched(sql, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(sql, [rows.slice(i, i + BATCH)]);
  }
}

// -------------------- cabang --------------------

/** Daftarkan cabang dari area OCS yang belum tercatat. */
export async function syncBranches() {
  const areas = await fetchAtpAreas();
  const now = new Date().toISOString();

  // Pusat ditaruh paling depan; sisanya menurut abjad.
  const urut = (a) => (a === 'Pusat' ? 0 : 10);

  /*
   * Rumpun hanya diisi saat baris baru dibuat, tidak ikut diperbarui, supaya
   * pemindahan rumpun yang dilakukan orang tidak tertimpa tiap sinkronisasi.
   */
  const rumpun = (a) => (a === 'Pusat' ? 'IEG' : 'OXAR');

  const rows = areas.map((a) => [a, a, a, rumpun(a), 1, urut(a), null, now]);
  if (rows.length) {
    await run(
      `INSERT INTO atp_branch (code, name, ocs_area, group_code, is_active, sort_order, note, created_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE ocs_area = VALUES(ocs_area)`,
      [rows],
    );
  }
  return { areas, ditambahkan: rows.length };
}

export async function listBranches() {
  return all(
    `SELECT code, name, ocs_area, group_code, is_active, sort_order, note, created_at
       FROM atp_branch ORDER BY sort_order, name`,
  );
}

export async function addBranch({ code, name, ocsArea = null, note = null, sortOrder = 100, groupCode = null }) {
  const kode = String(code || '').trim().slice(0, 40);
  if (!kode) throw new Error('Kode cabang wajib diisi');

  await run(
    `INSERT INTO atp_branch (code, name, ocs_area, group_code, is_active, sort_order, note, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), ocs_area = VALUES(ocs_area), group_code = VALUES(group_code),
       sort_order = VALUES(sort_order), note = VALUES(note)`,
    [kode, String(name || kode).slice(0, 120), ocsArea ? String(ocsArea).slice(0, 60) : null,
      groupCode ? String(groupCode).trim().toUpperCase().slice(0, 40) : null,
      int(sortOrder) || 100, note ? String(note).slice(0, 200) : null, new Date().toISOString()],
  );
  return { code: kode };
}

/** Pindahkan satu cabang ke rumpun lain, atau keluarkan dari rumpun mana pun. */
export async function setBranchGroup(code, groupCode) {
  const rumpun = groupCode ? String(groupCode).trim().toUpperCase().slice(0, 40) : null;
  const res = await run('UPDATE atp_branch SET group_code = ? WHERE code = ?', [rumpun, code]);
  if (!res.affectedRows) throw new Error('Cabang tidak ditemukan');
  return { code, groupCode: rumpun };
}

export async function setBranchActive(code, aktif) {
  await run('UPDATE atp_branch SET is_active = ? WHERE code = ?', [aktif ? 1 : 0, code]);
}

export async function deleteBranch(code) {
  // Cabang yang bersumber dari OCS tidak boleh dihapus — akan muncul lagi
  // pada sinkronisasi berikutnya dan hanya membingungkan.
  const b = await one('SELECT ocs_area FROM atp_branch WHERE code = ?', [code]);
  if (!b) throw new Error('Cabang tidak ditemukan');
  if (b.ocs_area) throw new Error('Cabang ini bersumber dari OCS dan tidak bisa dihapus. Nonaktifkan saja bila tidak ingin ditampilkan.');

  await run('DELETE FROM atp_sku_branch WHERE branch_code = ?', [code]);
  await run('DELETE FROM atp_branch WHERE code = ?', [code]);
}

// -------------------- master data --------------------

const SKU_SQL = `
  INSERT INTO atp_sku (sku, name, category, shop_code, sap_code, barcode, is_bundle, updated_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    name       = VALUES(name),
    category   = VALUES(category),
    shop_code  = COALESCE(VALUES(shop_code), atp_sku.shop_code),
    sap_code   = COALESCE(VALUES(sap_code), atp_sku.sap_code),
    barcode    = COALESCE(VALUES(barcode), atp_sku.barcode),
    is_bundle  = VALUES(is_bundle),
    updated_at = VALUES(updated_at)
`;

const BRANCH_SQL = `
  INSERT INTO atp_sku_branch
    (sku, branch_code, qty_on_hand, available_qty, qty_rack, is_active_ocs, updated_at)
  VALUES ?
  ON DUPLICATE KEY UPDATE
    qty_on_hand   = VALUES(qty_on_hand),
    available_qty = VALUES(available_qty),
    qty_rack      = VALUES(qty_rack),
    is_active_ocs = VALUES(is_active_ocs),
    updated_at    = VALUES(updated_at)
`;
/* is_active_override sengaja tidak ikut: itu keputusan manusia dan tidak boleh
   tertimpa oleh penarikan data. */

const BUNDLE_SQL = `
  INSERT INTO atp_bundle_item (bundle_sku, component_sku, qty) VALUES ?
  ON DUPLICATE KEY UPDATE qty = VALUES(qty)
`;

/** Tarik master data ATP: stok per cabang, atribut SKU, dan komponen bundle. */
export async function syncAtpMaster() {
  const t0 = Date.now();

  await syncBranches();
  const cabang = await all('SELECT code, ocs_area FROM atp_branch WHERE ocs_area IS NOT NULL');
  const areaKeCabang = new Map(cabang.map((b) => [b.ocs_area, b.code]));

  const [stok, rack, bundles] = await Promise.all([
    fetchAtpStock(),
    fetchAtpSkuRack(),
    fetchAtpBundles(),
  ]);

  const now = new Date().toISOString();

  // Atribut tambahan dari master rack: brand, kode SAP, barcode.
  const atribut = new Map();
  for (const r of rack) {
    const sku = r.SellerSku;
    if (!sku || atribut.has(sku)) continue;
    atribut.set(sku, {
      shop: str(r.ShopCode, 60),
      sap: str(r.SapCode, 60),
      barcode: str(r.Barcode, 60),
    });
  }

  const bundleSet = new Set(bundles.map((b) => b.BundleSku).filter(Boolean));

  // Satu baris per SKU, diambil dari baris stok mana pun (atributnya sama).
  const skuMap = new Map();
  const branchValues = [];

  for (const r of stok) {
    const sku = r.Sku;
    if (!sku) continue;

    if (!skuMap.has(sku)) {
      const a = atribut.get(sku) || {};
      skuMap.set(sku, [
        str(sku, 120),
        str(r.Name, 512),
        str(r.Category, 40),
        a.shop ?? null,
        a.sap ?? str(r.SapCode, 60),
        a.barcode ?? null,
        bundleSet.has(sku) || r.Category === 'Bundle' ? 1 : 0,
        now,
      ]);
    }

    const kode = areaKeCabang.get(r.AreaId);
    if (!kode) continue; // area yang belum terdaftar sebagai cabang

    branchValues.push([
      str(sku, 120), kode,
      int(r.QtyOnHand), int(r.AvailableQty), int(r.QtyGudangKecil),
      r.IsActive ? 1 : 0, now,
    ]);
  }

  await insertBatched(SKU_SQL, [...skuMap.values()]);
  await insertBatched(BRANCH_SQL, branchValues);

  const bundleValues = [];
  for (const b of bundles) {
    if (!b.BundleSku) continue;
    for (const it of b.Items || []) {
      if (!it?.SellerSku) continue;
      bundleValues.push([str(b.BundleSku, 120), str(it.SellerSku, 120), Math.max(1, int(it.SellerSkuQty))]);
    }
  }
  if (bundleValues.length) await insertBatched(BUNDLE_SQL, bundleValues);

  /*
   * Brand bundle diturunkan dari komponennya.
   *
   * Master rack hanya memuat barang yang benar-benar dirak, dan bundle tidak —
   * akibatnya seluruh bundle tidak punya ShopCode, padahal itu tiga perempat
   * katalog. Tanpa langkah ini tampilan per brand nyaris tak berguna karena
   * mayoritasnya jatuh ke "(tanpa brand)".
   *
   * Brand diambil dari komponen yang paling sering muncul; bila komponennya
   * berasal dari beberapa brand, yang terbanyak yang menang.
   */
  const brandBundle = await all(
    `SELECT i.bundle_sku, s.shop_code, COUNT(*) AS n
       FROM atp_bundle_item i
       JOIN atp_sku s ON s.sku = i.component_sku
      WHERE s.shop_code IS NOT NULL AND s.shop_code <> ''
      GROUP BY i.bundle_sku, s.shop_code`,
  );

  const pilihan = new Map();
  for (const r of brandBundle) {
    const kini = pilihan.get(r.bundle_sku);
    if (!kini || Number(r.n) > kini.n) pilihan.set(r.bundle_sku, { shop: r.shop_code, n: Number(r.n) });
  }

  const brandValues = [...pilihan.entries()].map(([sku, v]) => [sku, v.shop, now]);
  if (brandValues.length) {
    await insertBatched(
      `INSERT INTO atp_sku (sku, shop_code, updated_at) VALUES ?
       ON DUPLICATE KEY UPDATE shop_code = VALUES(shop_code)`,
      brandValues,
    );
  }

  return {
    sku: skuMap.size,
    barisCabang: branchValues.length,
    bundle: bundles.length,
    komponen: bundleValues.length,
    cabang: cabang.length,
    durationMs: Date.now() - t0,
  };
}

// -------------------- perhitungan ATP --------------------

/** Kolom stok dan ambang yang sedang berlaku. */
export async function getAtpConfig() {
  const s = await getSettings();
  const kolom = KOLOM_STOK[s.atp_stock_field] ? s.atp_stock_field : 'qty_on_hand';
  return {
    stockField: kolom,
    stockFieldLabel: KOLOM_STOK[kolom],
    threshold: Math.max(0, int(s.atp_threshold)),
    snapshotHour: Math.min(23, Math.max(0, int(s.atp_snapshot_hour))),
  };
}

/**
 * Status aktif yang berlaku: override manusia bila ada, kalau tidak ikut OCS.
 * Dipakai berulang di beberapa query, jadi ditulis sekali di sini.
 */
const AKTIF_SQL = 'COALESCE(b.is_active_override, b.is_active_ocs) = 1';

/**
 * Hitung ATP untuk keadaan saat ini.
 * Tidak menyimpan apa pun — dipakai tampilan langsung dan oleh snapshot harian.
 */
export async function hitungAtp({ stockField = null, threshold = null } = {}) {
  const cfg = await getAtpConfig();
  const kolom = stockField && KOLOM_STOK[stockField] ? stockField : cfg.stockField;
  const ambang = threshold === null || threshold === undefined ? cfg.threshold : int(threshold);

  const rows = await all(
    `SELECT b.branch_code,
            COALESCE(s.shop_code, '(tanpa brand)') AS shop_code,
            CASE WHEN s.is_bundle = 1 THEN 'Bundle' ELSE 'Sku' END AS category,
            COUNT(*) AS active_count,
            SUM(CASE WHEN b.${kolom} > ? THEN 1 ELSE 0 END) AS ready_count
       FROM atp_sku_branch b
       JOIN atp_sku s ON s.sku = b.sku
       JOIN atp_branch c ON c.code = b.branch_code AND c.is_active = 1
      WHERE ${AKTIF_SQL}
      GROUP BY b.branch_code,
               COALESCE(s.shop_code, '(tanpa brand)'),
               CASE WHEN s.is_bundle = 1 THEN 'Bundle' ELSE 'Sku' END`,
    [ambang],
  );

  return {
    stockField: kolom,
    stockFieldLabel: KOLOM_STOK[kolom],
    threshold: ambang,
    rows: rows.map((r) => ({
      branch: r.branch_code,
      shop: r.shop_code,
      category: r.category,
      active: Number(r.active_count),
      ready: Number(r.ready_count),
      pct: Number(r.active_count) ? (Number(r.ready_count) / Number(r.active_count)) * 100 : 0,
    })),
  };
}

/**
 * Simpan hasil perhitungan sebagai rekaman satu tanggal.
 *
 * Ditulis ulang bila tanggal yang sama disimpan dua kali, sehingga menjalankan
 * ulang tidak pernah menggandakan baris.
 */
export async function simpanSnapshot({ tanggal = null } = {}) {
  const hasil = await hitungAtp();
  const tgl = tanggal || new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  await run('DELETE FROM atp_snapshot WHERE snapshot_date = ?', [tgl]);

  if (hasil.rows.length) {
    const values = hasil.rows.map((r) => [
      tgl, r.branch, r.shop, r.category,
      r.active, r.ready, r.pct.toFixed(2),
      hasil.stockField, hasil.threshold, now,
    ]);
    await insertBatched(
      `INSERT INTO atp_snapshot
         (snapshot_date, branch_code, shop_code, category, active_count, ready_count,
          atp_pct, stock_field, threshold, taken_at)
       VALUES ?`,
      values,
    );
  }

  return { tanggal: tgl, baris: hasil.rows.length, ...hasil };
}

/**
 * Simpan rekaman harian bila jamnya sudah lewat dan hari ini belum tersimpan.
 *
 * Dipanggil worker tiap putaran. Pengecekan dilakukan di sini, bukan lewat
 * penjadwal terpisah, supaya rekaman tetap terambil walau worker sempat mati
 * melewati jam yang ditentukan.
 */
export async function perluSnapshot() {
  const cfg = await getAtpConfig();

  // Jam dinyatakan dalam waktu setempat gudang (WIB), bukan UTC.
  const wib = new Date(Date.now() + 7 * 3600_000);
  const tgl = wib.toISOString().slice(0, 10);

  if (wib.getUTCHours() < cfg.snapshotHour) {
    return { perlu: false, tanggal: tgl, alasan: `Belum jam ${cfg.snapshotHour}:00 WIB` };
  }

  const ada = await one('SELECT 1 AS a FROM atp_snapshot WHERE snapshot_date = ? LIMIT 1', [tgl]);
  if (ada) return { perlu: false, tanggal: tgl, alasan: `Rekaman ${tgl} sudah ada` };

  return { perlu: true, tanggal: tgl };
}

export async function snapshotBilaWaktunya() {
  const cek = await perluSnapshot();
  if (!cek.perlu) return { diambil: false, alasan: cek.alasan };

  const hasil = await simpanSnapshot({ tanggal: cek.tanggal });
  return { diambil: true, ...hasil };
}

/** Satu putaran penuh ATP: tarik master, lalu ambil rekaman bila waktunya. */
export async function syncAtp() {
  const master = await syncAtpMaster();
  const snap = await snapshotBilaWaktunya();
  return { master, snapshot: snap };
}
