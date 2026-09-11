/*
 * Menjalankan templat ATP di luar peramban untuk memastikan markup yang
 * dihasilkan utuh. Bukan pengganti melihat layar, tetapi menangkap kesalahan
 * yang paling sering lolos: tag tidak tertutup dan kendali yang hilang.
 *
 * Kedua berkas digabung lalu dijalankan sebagai satu skrip, karena deklarasi
 * const di tingkat atas tidak menempel ke globalThis — memuatnya terpisah
 * membuat ATP tidak terlihat dari luar.
 */
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const simpan = new Map();
const el = (id) => {
  if (!simpan.has(id)) {
    simpan.set(id, {
      id, innerHTML: '', dataset: {}, value: '', options: [],
      classList: { add() {}, remove() {} },
      // Penelusuran di dalam elemen selalu kosong: yang diuji markupnya, bukan perilakunya.
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 200 }),
    });
  }
  return simpan.get(id);
};

globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.document = { documentElement: { setAttribute() {}, removeAttribute() {}, getAttribute: () => null } };
globalThis.$ = (sel) => el(String(sel).replace('#', ''));
globalThis.$$ = () => [];
globalThis.api = async (path) => (await fetch('http://127.0.0.1:3100' + path)).json();
globalThis.toast = () => {};
globalThis.esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.fmt = (n) => new Intl.NumberFormat('id-ID').format(Number(n) || 0);
globalThis.fmtWaktu = (t) => String(t || '');
globalThis.icon = (n) => `<svg class="icon"><use href="#i-${n}"/></svg>`;

globalThis.__data = await (await fetch('http://127.0.0.1:3100/api/atp/dashboard')).json();

const gabung = [
  readFileSync('public/js/atp-tab.js', 'utf8'),
  readFileSync('public/js/atp-views.js', 'utf8'),
  'ATP.data = globalThis.__data; paintAtp(); globalThis.__html = $("#main").innerHTML;',
].join('\n;\n');

runInThisContext(gabung);
const html = globalThis.__html;

/** Hitung keseimbangan tag, abaikan yang memang tidak berpasangan. */
function periksaTag(s) {
  const tunggal = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'use', 'path', 'circle', 'rect', 'line', 'polyline', 'col']);
  const tumpuk = [];
  const salah = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    const [, tutup, nama, mandiri] = m;
    const n = nama.toLowerCase();
    if (tunggal.has(n) || mandiri) continue;
    if (tutup) {
      if (tumpuk[tumpuk.length - 1] === n) tumpuk.pop();
      else salah.push(`</${n}> tidak cocok dengan <${tumpuk[tumpuk.length - 1] || 'kosong'}>`);
    } else tumpuk.push(n);
  }
  if (tumpuk.length) salah.push(`belum tertutup: ${tumpuk.join(', ')}`);
  return salah;
}

const laporan = (nama, markup, wajib) => {
  const salah = periksaTag(markup);
  console.log(`
=== ${nama} — ${markup.length} karakter, tag bermasalah: ${salah.length ? salah.join(' | ') : 'tidak ada'}`);
  for (const [label, pola] of wajib) console.log((pola.test(markup) ? '  ok  ' : '  >>> ') + label);
};

laporan('Dashboard', html, [
  ['baris "Dasar perhitungan"', /class="atp-dasar"/],
  ['pemilih kolom stok',        /id="atpKolom"/],
  ['isian ambang',              /id="atpAmbang"/],
  ['tiga pilihan kolom',        /<option value="qty_on_hand"[\s\S]*?<option value="available_qty"[\s\S]*?<option value="qty_rack"/],
  ['pilihan aktif tertandai',   /<option value="qty_on_hand" selected/],
  ['sakelar bersegmen',         /class="segmented"/],
  ['tombol tarik',              /id="atpSync"/],
]);

const render = async (fn) => { await fn(); return $('#atpBody').innerHTML; };

const mdHtml = await render(paintMaster);
laporan('Master Data', mdHtml, [
  ['kartu ringkasan cabang',   /class="tiles"/],
  ['keterangan lingkup',       /Seluruh katalog|Disaring/],
  ['bar aksi massal',          /data-massal="salin"/],
  ['pilihan rumpun OXAR',      /value="grup:OXAR"/],
  ['pemilih sumber',           /id="bSumber"/],
  ['keempat tombol massal',    /data-massal="salin"[\s\S]*data-massal="ocs"[\s\S]*data-massal="aktif"[\s\S]*data-massal="nonaktif"/],
  ['penyaring jenis',          /id="mCat"/],
  ['ceklis per cabang',        /data-atp-ceklis=/],
]);

laporan('Cabang', await render(paintCabang), [
  ['kolom rumpun',             /data-cab-grup=/],
  ['sakelar tampil',           /data-cab-aktif=/],
  ['isian rumpun baru',        /id="cGrup"/],
]);

laporan('Riwayat', await render(paintRiwayat), [
  ['pemilih jenis',            /id="rJenis"/],
  ['tiga opsi jenis',          /value="ALL"[\s\S]*value="Sku"[\s\S]*value="Bundle"/],
  ['tombol ambil rekaman',     /id="rAmbil2"|id="rAmbil"/],
]);


// --- Pembedahan ukuran markup Master Data ---
const barisMd = (mdHtml.match(/<tr>/g) || []).length;
const judul = mdHtml.match(/title="[^"]*"/g) || [];
const panjangJudul = judul.reduce((a, t) => a + t.length, 0);
const n = (x) => x.toLocaleString('id-ID');

console.log('');
console.log('=== Ukuran markup Master Data ===');
console.log('  total           :', n(mdHtml.length), 'karakter');
console.log('  baris <tr>      :', barisMd);
console.log('  rata per baris  :', n(Math.round(mdHtml.length / Math.max(1, barisMd))), 'karakter');
console.log('  atribut title   :', judul.length, 'buah,', n(panjangJudul), 'karakter (' + Math.round(panjangJudul / mdHtml.length * 100) + '% dari total)');
console.log('  elemen <button> :', (mdHtml.match(/<button/g) || []).length);
console.log('  elemen <input>  :', (mdHtml.match(/<input/g) || []).length);
