import { all, one, run, withTransaction, getSettings } from './db.js';
import { fetchSalesOrderReport, fetchSalesSkuReport } from './ocs.js';

/**
 * Sinkronisasi penjualan harian dari halaman Report OCS.
 *
 * Data mentah order berjumlah 19,6 juta baris, jadi yang ditarik adalah agregat
 * harian dari endpoint report — bukan barisan order.
 *
 * Isi satu hari BISA BERUBAH setelah hari itu lewat, karena order berpindah
 * status (hari ini IN_TRANSIT, besok DELIVERED). Karena itu penarikan ulang
 * menghapus dulu seluruh baris tanggal tersebut lalu menulis ulang. Menarik
 * rentang yang sama berkali-kali karena itu tidak pernah menggandakan angka —
 * hasilnya selalu sama dengan keadaan terakhir di OCS.
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

/** Kolom yang bukan status pada rincian platform. */
const BUKAN_STATUS = new Set(['Date', 'ShopName', 'Area', 'CommercePlatform', 'TotalOrder', 'Detail']);

const BATCH = 500;

/** Hari per permintaan. Rentang panjang dipecah agar tidak menabrak batas waktu. */
const HARI_PER_TARIKAN = 7;

const hariISO = (d) => d.toISOString().slice(0, 10);

/**
 * Ubah nilai tanggal menjadi "YYYY-MM-DD".
 *
 * Menangani dua bentuk: string dari OCS ("2026-09-09T00:00:00") dan objek Date
 * yang dikembalikan driver untuk kolom DATE. Tanpa pemeriksaan objek Date,
 * String(v).slice(0,10) menghasilkan "Sun Sep 06" — bukan tanggal yang bisa
 * dibandingkan maupun ditampilkan.
 */
const tanggalSaja = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Daftar tanggal dari `from` sampai `to`, inklusif. */
export function daftarTanggal(fromDate, toDate) {
  const out = [];
  const a = new Date(`${fromDate}T00:00:00.000Z`);
  const b = new Date(`${toDate}T00:00:00.000Z`);
  for (let t = a.getTime(); t <= b.getTime(); t += 86400_000) out.push(hariISO(new Date(t)));
  return out;
}

/** Pecah rentang menjadi potongan berisi paling banyak `HARI_PER_TARIKAN` hari. */
function potongRentang(fromDate, toDate) {
  const tanggal = daftarTanggal(fromDate, toDate);
  const potongan = [];
  for (let i = 0; i < tanggal.length; i += HARI_PER_TARIKAN) {
    const bagian = tanggal.slice(i, i + HARI_PER_TARIKAN);
    potongan.push({ from: bagian[0], to: bagian[bagian.length - 1], hari: bagian });
  }
  return potongan;
}

async function insertBatched(conn, sql, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await conn.query(sql, [rows.slice(i, i + BATCH)]);
  }
}

const SHOP_SQL = `INSERT INTO sales_order_shop_daily (sales_date, shop_name, area, total_order, soi, moi) VALUES ?`;
const STATUS_SQL = `INSERT INTO sales_order_status_daily (sales_date, shop_name, area, commerce_platform, status, order_count) VALUES ?`;
const SKU_SQL = `INSERT INTO sales_sku_daily (sales_date, seller_sku, area, commerce_platform, qty) VALUES ?`;

/** Tarik satu potongan rentang lalu tulis ulang hari-hari di dalamnya. */
async function tarikPotongan({ from, to, hari }, opsi) {
  const [orderRows, skuRows] = await Promise.all([
    fetchSalesOrderReport(from, to, opsi),
    fetchSalesSkuReport(from, to, opsi),
  ]);

  const shopValues = [];
  const statusValues = [];
  const skuValues = [];

  for (const r of orderRows) {
    const tgl = tanggalSaja(r.Date);
    if (!tgl) continue;

    shopValues.push([
      tgl, str(r.ShopName, 60) ?? '', str(r.Area, 60) ?? '',
      int(r.TotalOrder), int(r.Soi), int(r.Moi),
    ]);

    for (const d of r.Detail || []) {
      const platform = str(d.CommercePlatform, 40) ?? '';
      for (const [kolom, nilai] of Object.entries(d)) {
        if (BUKAN_STATUS.has(kolom)) continue;
        statusValues.push([
          tgl, str(r.ShopName, 60) ?? '', str(r.Area, 60) ?? '',
          platform, str(kolom, 40), int(nilai),
        ]);
      }
    }
  }

  for (const r of skuRows) {
    const tgl = tanggalSaja(r.Date);
    if (!tgl || !r.SellerSku) continue;
    for (const d of r.Detail || []) {
      skuValues.push([
        tgl, str(r.SellerSku, 120), str(r.Area, 60) ?? '',
        str(d.CommercePlatform, 40) ?? '', int(d.Qty),
      ]);
    }
  }

  const now = new Date().toISOString();

  /*
   * Hari yang dihapus adalah gabungan hari yang DIMINTA dan hari yang benar-benar
   * DIKEMBALIKAN server.
   *
   * Hari yang diminta harus ikut walau kosong, supaya tanggal yang transaksinya
   * hilang tidak meninggalkan sisa penarikan lama. Hari yang dikembalikan harus
   * ikut karena batas rentang di sisi server pernah menyertakan hari di luar
   * permintaan — kalau tidak dihapus, barisnya menabrak kunci primer pada
   * penarikan berikutnya.
   */
  const hariDitulis = [...new Set([
    ...hari,
    ...shopValues.map((v) => v[0]),
    ...statusValues.map((v) => v[0]),
    ...skuValues.map((v) => v[0]),
  ])];

  await withTransaction(async (conn) => {
    const tanda = hariDitulis.map(() => '?').join(',');
    await conn.query(`DELETE FROM sales_order_shop_daily WHERE sales_date IN (${tanda})`, hariDitulis);
    await conn.query(`DELETE FROM sales_order_status_daily WHERE sales_date IN (${tanda})`, hariDitulis);
    await conn.query(`DELETE FROM sales_sku_daily WHERE sales_date IN (${tanda})`, hariDitulis);

    if (shopValues.length) await insertBatched(conn, SHOP_SQL, shopValues);
    if (statusValues.length) await insertBatched(conn, STATUS_SQL, statusValues);
    if (skuValues.length) await insertBatched(conn, SKU_SQL, skuValues);

    const cakupan = hariDitulis.map((tgl) => [
      tgl,
      statusValues.filter((v) => v[0] === tgl).length,
      skuValues.filter((v) => v[0] === tgl).length,
      now,
    ]);
    await conn.query(
      `INSERT INTO sales_sync_day (sales_date, order_rows, sku_rows, pulled_at) VALUES ?
       ON DUPLICATE KEY UPDATE order_rows = VALUES(order_rows), sku_rows = VALUES(sku_rows), pulled_at = VALUES(pulled_at)`,
      [cakupan],
    );
  });

  return { hari: hariDitulis.length, orderRows: statusValues.length, skuRows: skuValues.length };
}

/**
 * Tarik rentang tanggal apa pun.
 * `onProgress(selesai, total, potongan)` dipanggil tiap potongan selesai.
 */
export async function syncSalesRange(fromDate, toDate, { onProgress = null, ...opsi } = {}) {
  const t0 = Date.now();
  const potongan = potongRentang(fromDate, toDate);

  let hari = 0;
  let orderRows = 0;
  let skuRows = 0;

  for (let i = 0; i < potongan.length; i++) {
    const hasil = await tarikPotongan(potongan[i], opsi);
    hari += hasil.hari;
    orderRows += hasil.orderRows;
    skuRows += hasil.skuRows;
    if (onProgress) onProgress(i + 1, potongan.length, potongan[i]);
  }

  return { from: fromDate, to: toDate, hari, orderRows, skuRows, durationMs: Date.now() - t0 };
}

/**
 * Penarikan berkala: menyegarkan beberapa hari terakhir.
 *
 * Bukan hanya hari ini, karena order yang dibuat kemarin masih bisa berpindah
 * status hari ini. Banyaknya hari diatur lewat `sales_resync_days` di halaman
 * Pengaturan.
 */
export async function syncSalesRecent({ days = null } = {}) {
  const settings = await getSettings();
  const n = Math.max(1, Math.trunc(Number(days ?? settings.sales_resync_days) || 7));

  const to = hariISO(new Date());
  const from = hariISO(new Date(Date.now() - (n - 1) * 86400_000));
  return syncSalesRange(from, to);
}

/** Ringkasan cakupan: rentang tanggal yang sudah tersimpan dan berapa harinya. */
export async function getSalesCoverage() {
  const row = await one(
    `SELECT MIN(sales_date) AS dari, MAX(sales_date) AS sampai, COUNT(*) AS hari,
            MAX(pulled_at) AS terakhir
       FROM sales_sync_day`,
  );
  const hari = Number(row?.hari) || 0;
  if (!hari) return { hari: 0, dari: null, sampai: null, terakhir: null, bolong: [] };

  // Hari yang berada di dalam rentang tetapi belum pernah ditarik.
  const adaSet = new Set((await all('SELECT sales_date FROM sales_sync_day')).map((r) => tanggalSaja(r.sales_date)));
  const bolong = daftarTanggal(tanggalSaja(row.dari), tanggalSaja(row.sampai)).filter((t) => !adaSet.has(t));

  return {
    hari,
    dari: tanggalSaja(row.dari),
    sampai: tanggalSaja(row.sampai),
    terakhir: row.terakhir,
    bolong,
  };
}
