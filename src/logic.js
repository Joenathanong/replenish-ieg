import { all, one, getSettings } from './db.js';

/**
 * Status ditentukan dari Qty Rack (QtyGudangKecil di OCS) — stok yang benar-benar
 * ada di gudang kecil / rak picking.
 *
 *   MINUS  : qty_rack <  0                      -> ada selisih pencatatan, wajib dicek
 *   HABIS  : qty_rack == 0                      -> rak kosong
 *   TIPIS  : 0 < qty_rack <= ambang item        -> segera replenish
 *   AMAN   : qty_rack >  ambang item
 *
 * Ambang tiap item = override di tabel item_threshold, kalau tidak ada memakai
 * default global. Material baru otomatis ikut default sampai ada yang meng-override.
 */
export const STATUS = {
  MINUS: 'MINUS',
  HABIS: 'HABIS',
  TIPIS: 'TIPIS',
  AMAN: 'AMAN',
};

export const STATUS_ORDER = { MINUS: 0, HABIS: 1, TIPIS: 2, AMAN: 3 };

/** LIMIT tidak boleh memakai placeholder di MySQL, jadi angkanya divalidasi lalu disisipkan. */
function safeLimit(value, fallback, max = 5000) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const SELECT_BASE = `
  SELECT
    c.sku, c.area_id, c.name, c.sap_code, c.category, c.shop_code,
    c.qty_rack, c.qty_bulk, c.qty_on_hand, c.qty_on_order,
    c.available_qty, c.reserve_qty, c.is_active, c.is_under_reserve,
    c.prev_qty_rack, c.first_seen_at, c.updated_at,
    COALESCE(t.thin_threshold, ?) AS threshold,
    (t.thin_threshold IS NOT NULL) AS has_override,
    CASE
      WHEN c.qty_rack <  0 THEN 'MINUS'
      WHEN c.qty_rack =  0 THEN 'HABIS'
      WHEN c.qty_rack <= COALESCE(t.thin_threshold, ?) THEN 'TIPIS'
      ELSE 'AMAN'
    END AS status
  FROM stock_current c
  LEFT JOIN item_threshold t ON t.sku = c.sku AND t.area_id = c.area_id
`;

/** Filter lingkup: kategori mana yang ikut, dan apakah item non-aktif ditampilkan. */
function scopeClause(opts) {
  const where = [];
  const params = [];

  const categories = ['Sku'];
  if (opts.show_bundle) categories.push('Bundle');
  if (opts.show_gimmick) categories.push('Gimmick');
  where.push(`c.category IN (${categories.map(() => '?').join(',')})`);
  params.push(...categories);

  if (!opts.show_inactive) where.push('c.is_active = 1');
  if (opts.replenishable_only) where.push('c.qty_bulk > 0');

  // Item Clearance Sale (kategori Sku berawalan "CS-") sedang dihabiskan,
  // bukan diisi ulang, jadi secara bawaan tidak ikut dipantau.
  // UPPER() dipakai eksplisit karena kolom sku kini bercollation biner,
  // sehingga LIKE tidak lagi otomatis mengabaikan huruf besar/kecil.
  if (!opts.show_clearance) where.push("NOT (c.category = 'Sku' AND UPPER(c.sku) LIKE 'CS-%')");

  return { where, params };
}

/**
 * Waktu sinkronisasi pertama. Semua item terlihat pertama kali pada saat itu,
 * jadi mereka adalah data awal — bukan "material baru". Hanya item yang muncul
 * setelah baseline yang layak diberi tanda BARU.
 */
async function getBaselineTime() {
  const row = await one('SELECT MIN(started_at) AS t FROM sync_log');
  const t = row?.t ? Date.parse(row.t) : NaN;
  return Number.isFinite(t) ? t + 120_000 : 0; // toleransi 2 menit untuk sync pertama
}

function decorate(row, newItemDays, baselineTime) {
  const delta =
    row.prev_qty_rack === null || row.prev_qty_rack === undefined
      ? null
      : row.qty_rack - row.prev_qty_rack;

  const firstSeen = Date.parse(row.first_seen_at);
  const isNew =
    Number.isFinite(firstSeen) &&
    firstSeen > baselineTime &&
    Date.now() - firstSeen <= newItemDays * 86400_000;

  // Berapa banyak yang perlu dipindahkan agar rak kembali ke ambang.
  const suggestedQty = row.status === 'AMAN' ? 0 : Math.max(0, row.threshold - row.qty_rack);

  return {
    sku: row.sku,
    areaId: row.area_id,
    name: row.name,
    sapCode: row.sap_code,
    category: row.category,
    shopCode: row.shop_code,
    qtyRack: row.qty_rack,
    qtyBulk: row.qty_bulk,
    qtyOnHand: row.qty_on_hand,
    qtyOnOrder: row.qty_on_order,
    availableQty: row.available_qty,
    reserveQty: row.reserve_qty,
    isActive: !!row.is_active,
    isUnderReserve: !!row.is_under_reserve,
    threshold: row.threshold,
    hasOverride: !!row.has_override,
    status: row.status,
    delta,
    isNew,
    // Bisa dikerjakan sekarang: barangnya ada di gudang besar, tinggal transfer.
    canReplenish: row.qty_bulk > 0,
    suggestedQty: Math.min(suggestedQty, Math.max(0, row.qty_bulk)),
    shortageQty: suggestedQty,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Data utama dashboard.
 * `overrides` boleh berisi status, search, shop, sort — dipakai oleh filter di UI
 * tanpa mengubah pengaturan yang tersimpan.
 */
export async function getDashboard(overrides = {}) {
  const settings = await getSettings();
  const opts = { ...settings, ...overrides };
  const def = Number(opts.default_thin_threshold) || 0;

  const { where, params } = scopeClause(opts);

  const sql = `${SELECT_BASE} WHERE ${where.join(' AND ')}`;
  const rows = await all(sql, [def, def, ...params]);

  const baselineTime = await getBaselineTime();
  const all_ = rows.map((r) => decorate(r, Number(opts.new_item_days) || 7, baselineTime));

  // KPI dihitung dari seluruh lingkup, bukan dari hasil pencarian,
  // supaya angka di kartu tidak ikut berubah saat pengguna mengetik di kotak cari.
  const summary = {
    total: all_.length,
    minus: all_.filter((i) => i.status === STATUS.MINUS).length,
    habis: all_.filter((i) => i.status === STATUS.HABIS).length,
    tipis: all_.filter((i) => i.status === STATUS.TIPIS).length,
    aman: all_.filter((i) => i.status === STATUS.AMAN).length,
    perluTindakan: all_.filter((i) => i.status !== STATUS.AMAN).length,
    bisaReplenish: all_.filter((i) => i.status !== STATUS.AMAN && i.canReplenish).length,
    itemBaru: all_.filter((i) => i.isNew).length,
  };

  let items = all_;

  if (opts.hide_safe) items = items.filter((i) => i.status !== STATUS.AMAN);

  if (overrides.status && overrides.status !== 'ALL') {
    const wanted = String(overrides.status).toUpperCase();
    items = wanted === 'ACTIONABLE'
      ? items.filter((i) => i.status !== STATUS.AMAN)
      : items.filter((i) => i.status === wanted);
  }

  if (overrides.shop && overrides.shop !== 'ALL') {
    items = items.filter((i) => (i.shopCode || '') === overrides.shop);
  }

  if (overrides.search) {
    const q = String(overrides.search).trim().toLowerCase();
    if (q) {
      items = items.filter(
        (i) =>
          i.sku.toLowerCase().includes(q) ||
          (i.name || '').toLowerCase().includes(q) ||
          (i.sapCode || '').toLowerCase().includes(q),
      );
    }
  }

  items.sort(compareBy(overrides.sort));

  const shops = [...new Set(all_.map((i) => i.shopCode).filter(Boolean))].sort();

  return {
    summary,
    items,
    shops,
    settings,
    scope: {
      categories: ['Sku', opts.show_bundle ? 'Bundle' : null, opts.show_gimmick ? 'Gimmick' : null]
        .filter(Boolean),
      includeInactive: !!opts.show_inactive,
      includeClearance: !!opts.show_clearance,
      replenishableOnly: !!opts.replenishable_only,
      hideSafe: !!opts.hide_safe,
      defaultThreshold: def,
    },
  };
}

function compareBy(sort) {
  switch (sort) {
    case 'qty_asc':
      return (a, b) => a.qtyRack - b.qtyRack || a.sku.localeCompare(b.sku);
    case 'qty_desc':
      return (a, b) => b.qtyRack - a.qtyRack || a.sku.localeCompare(b.sku);
    case 'name':
      return (a, b) => (a.name || '').localeCompare(b.name || '');
    case 'sku':
      return (a, b) => a.sku.localeCompare(b.sku);
    case 'delta':
      return (a, b) => (a.delta ?? 0) - (b.delta ?? 0);
    case 'urgency':
    default:
      // Paling mendesak di atas; yang stoknya tersedia di gudang besar didahulukan
      // karena bisa langsung dikerjakan.
      return (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        Number(b.canReplenish) - Number(a.canReplenish) ||
        a.qtyRack - b.qtyRack ||
        a.sku.localeCompare(b.sku);
  }
}

/** Riwayat pergerakan satu item untuk grafik tren. */
export async function getItemHistory(sku, areaId, limit = 200) {
  const rows = await all(
    `SELECT qty_rack, qty_bulk, qty_on_hand, captured_at
       FROM stock_history
      WHERE sku = ? AND area_id = ?
      ORDER BY captured_at DESC
      LIMIT ${safeLimit(limit, 200)}`,
    [sku, areaId],
  );
  return rows.reverse();
}

/** Daftar override ambang untuk halaman Pengaturan. */
export async function listThresholds() {
  const rows = await all(`
    SELECT t.sku, t.area_id, t.thin_threshold, t.note, t.updated_at,
           c.name, c.category, c.qty_rack, c.shop_code
      FROM item_threshold t
      LEFT JOIN stock_current c ON c.sku = t.sku AND c.area_id = t.area_id
     ORDER BY t.updated_at DESC
  `);
  return rows.map((r) => ({
    sku: r.sku,
    areaId: r.area_id,
    threshold: r.thin_threshold,
    note: r.note,
    updatedAt: r.updated_at,
    name: r.name,
    category: r.category,
    qtyRack: r.qty_rack,
    shopCode: r.shop_code,
  }));
}

/** Cari item untuk dialog "atur ambang khusus". */
export async function searchItems(query, limit = 30) {
  const q = `%${String(query || '').trim().toLowerCase()}%`;
  const rows = await all(
    `SELECT sku, area_id, name, category, qty_rack, qty_bulk, shop_code, is_active
       FROM stock_current
      WHERE LOWER(sku) LIKE ? OR LOWER(name) LIKE ?
      ORDER BY is_active DESC, sku
      LIMIT ${safeLimit(limit, 30, 200)}`,
    [q, q],
  );
  return rows.map((r) => ({
    sku: r.sku,
    areaId: r.area_id,
    name: r.name,
    category: r.category,
    qtyRack: r.qty_rack,
    qtyBulk: r.qty_bulk,
    shopCode: r.shop_code,
    isActive: !!r.is_active,
  }));
}

export async function getSyncHistory(limit = 20) {
  return all(
    `SELECT id, started_at, finished_at, status, row_count, new_count, duration_ms, message
       FROM sync_log
      ORDER BY started_at DESC
      LIMIT ${safeLimit(limit, 20, 200)}`,
  );
}
