import { ensureSchema, closePool, one } from '../src/db.js';
import { syncSalesMissing, getSalesCoverage } from '../src/sales.js';

/**
 * Menarik riwayat penjualan bulan demi bulan, dari yang terbaru ke yang terlama.
 *
 * Urutan mundur dipilih karena bulan yang lebih dekat lebih sering dipakai —
 * kalau penarikan terhenti di tengah jalan, yang sudah masuk adalah bagian yang
 * paling berguna.
 *
 * Tanggal yang sudah tersimpan dilewati, sehingga menjalankan ulang skrip ini
 * hanya mengerjakan sisanya. Aman dihentikan kapan saja.
 *
 * Pemakaian:
 *   node scripts/backfill-sales.js 2026-01 2026-06
 *   node scripts/backfill-sales.js 2026-01            (sampai bulan berjalan)
 */

const argv = process.argv.slice(2);

function uraiBulan(teks, bawaan) {
  if (!teks) return bawaan;
  const m = /^(\d{4})-(\d{2})$/.exec(teks.trim());
  if (!m) throw new Error(`Format bulan harus YYYY-MM, bukan "${teks}"`);
  return { tahun: Number(m[1]), bulan: Number(m[2]) };
}

const kini = new Date();
const bulanAwal = uraiBulan(argv[0], { tahun: kini.getUTCFullYear(), bulan: 1 });
const bulanAkhir = uraiBulan(argv[1], { tahun: kini.getUTCFullYear(), bulan: kini.getUTCMonth() + 1 });

/** Daftar bulan dari akhir ke awal — terbaru dikerjakan lebih dulu. */
function daftarBulanMundur(awal, akhir) {
  const out = [];
  let t = akhir.tahun;
  let b = akhir.bulan;
  while (t > awal.tahun || (t === awal.tahun && b >= awal.bulan)) {
    out.push({ tahun: t, bulan: b });
    b--;
    if (b === 0) { b = 12; t--; }
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
const awalBulan = (t, b) => `${t}-${pad(b)}-01`;
const akhirBulan = (t, b) => {
  const hari = new Date(Date.UTC(t, b, 0)).getUTCDate();
  return `${t}-${pad(b)}-${pad(hari)}`;
};

const namaBulan = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const mulai = Date.now();

try {
  await ensureSchema();

  const bulanan = daftarBulanMundur(bulanAwal, bulanAkhir);
  log(`Menarik ${bulanan.length} bulan, dari ${namaBulan[bulanAkhir.bulan]} ${bulanAkhir.tahun} mundur ke ${namaBulan[bulanAwal.bulan]} ${bulanAwal.tahun}.`);
  log('Tanggal yang sudah tersimpan dilewati. Aman dihentikan kapan saja (Ctrl+C).');
  console.log('');

  let totalHari = 0;
  let totalGagal = 0;

  for (const { tahun, bulan } of bulanan) {
    const dari = awalBulan(tahun, bulan);
    // Bulan berjalan tidak ditarik melewati hari ini.
    const hariIni = new Date().toISOString().slice(0, 10);
    const sampai = akhirBulan(tahun, bulan) > hariIni ? hariIni : akhirBulan(tahun, bulan);

    if (dari > hariIni) {
      log(`${namaBulan[bulan]} ${tahun}: belum tiba, dilewati.`);
      continue;
    }

    const t0 = Date.now();
    const hasil = await syncSalesMissing(dari, sampai);

    if (hasil.sudahLengkap) {
      log(`${namaBulan[bulan]} ${tahun}: sudah lengkap, dilewati.`);
      continue;
    }

    totalHari += hasil.hari;
    totalGagal += hasil.gagal.length;

    const menit = ((Date.now() - t0) / 60000).toFixed(1);
    log(
      `${namaBulan[bulan]} ${tahun}: ${hasil.hari}/${hasil.diminta} hari, ` +
      `${hasil.orderRows} baris order, ${hasil.skuRows} baris SKU (${menit} menit)` +
      (hasil.gagal.length ? ` — ${hasil.gagal.length} potongan GAGAL` : ''),
    );
    for (const g of hasil.gagal) log(`    gagal: ${g.from} s/d ${g.to} — ${g.error.slice(0, 80)}`);
  }

  console.log('');
  const c = await getSalesCoverage();
  log(`Selesai dalam ${((Date.now() - mulai) / 60000).toFixed(1)} menit.`);
  log(`Cakupan sekarang: ${c.hari} hari, ${c.dari} s/d ${c.sampai}, ${c.bolong.length} hari bolong.`);
  if (totalGagal) log(`${totalGagal} potongan gagal — jalankan ulang perintah ini untuk mengejar sisanya.`);

  const t = await one('SELECT COALESCE(SUM(order_count),0) o FROM sales_order_status_daily');
  const q = await one('SELECT COALESCE(SUM(qty),0) q FROM sales_sku_daily');
  log(`Total tersimpan: ${Number(t.o).toLocaleString('id-ID')} order, ${Number(q.q).toLocaleString('id-ID')} pcs.`);
} catch (err) {
  console.error('\n  Gagal:', err.message, '\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
