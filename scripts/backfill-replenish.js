import { ensureSchema, closePool, one } from '../src/db.js';
import { syncBinLog, syncDocs, syncDocDetails, countPendingDetails } from '../src/replenish.js';

/**
 * Menarik seluruh riwayat replenish dari OCS sampai habis.
 *
 * Baris detail dokumen hanya bisa diambil satu per satu, sehingga pengambilan
 * awal memakan waktu. Skrip ini aman dihentikan di tengah jalan dan dijalankan
 * ulang: dokumen yang detailnya sudah tertarik tidak diambil dua kali.
 */

const started = Date.now();
const menit = (ms) => (ms / 60000).toFixed(1);

try {
  await ensureSchema();

  console.log('\n  Menarik log per bin dan daftar dokumen...');
  const bin = await syncBinLog();
  const docs = await syncDocs();
  console.log(`    log per bin : ${bin.stored} baris`);
  console.log(`    dokumen     : ${docs.stored} dokumen`);

  let sisa = await countPendingDetails();
  console.log(`\n  Detail yang belum ditarik: ${sisa}`);
  if (sisa === 0) {
    console.log('  Tidak ada yang perlu dikerjakan.\n');
  } else {
    console.log('  Menarik bertahap. Aman dihentikan kapan saja (Ctrl+C).\n');

    let totalBaris = 0;
    let totalGagal = 0;
    let putaran = 0;

    while (sisa > 0) {
      putaran++;
      const t = Date.now();
      const hasil = await syncDocDetails({ limit: 300 });

      totalBaris += hasil.lines;
      totalGagal += hasil.failed;
      sisa = hasil.remaining;

      // Tidak ada kemajuan sama sekali berarti semua sisanya gagal; berhenti
      // daripada berputar tanpa henti.
      if (hasil.processed === 0) {
        console.log('    Tidak ada kemajuan pada putaran ini; dihentikan.');
        break;
      }

      const laju = hasil.processed / ((Date.now() - t) / 1000);
      const perkiraan = sisa / laju / 60;
      console.log(
        `    putaran ${String(putaran).padStart(3)} : ${hasil.processed} dokumen, ` +
        `${hasil.lines} baris, sisa ${sisa}` +
        (sisa > 0 ? `  (~${perkiraan.toFixed(0)} menit lagi)` : ''),
      );
    }

    console.log(`\n  Selesai dalam ${menit(Date.now() - started)} menit.`);
    console.log(`    baris detail tersimpan : ${totalBaris}`);
    if (totalGagal) console.log(`    dokumen gagal ditarik  : ${totalGagal} (akan dicoba lagi pada sinkronisasi berikutnya)`);
  }

  const l = await one('SELECT COUNT(*) AS c FROM replenish_doc_line');
  console.log(`\n  Total baris detail di database: ${l.c}\n`);
} catch (err) {
  console.error('\n  Gagal:', err.message, '\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
