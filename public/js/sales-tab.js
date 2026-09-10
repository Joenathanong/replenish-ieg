/* =========================================================================
   Tab "Penjualan".

   Tiga bagian:
     Order      — jumlah order per hari, dipecah per status.
     SKU        — jumlah barang terjual per SKU.
     Tarik Data — memilih sendiri rentang tanggal yang ingin diambil dari OCS.

   Yang disimpan adalah agregat harian dari halaman Report OCS, bukan barisan
   order — data mentahnya berjumlah 19,6 juta baris.
   ========================================================================= */

const SL = {
  ringkasan: null,
  tampilan: 'order',        // 'order' | 'sku' | 'tarik'
  hasil: null,
  hari: [],
  cocokPersis: true,
  nilai: {
    from: '', to: '', area: 'ALL', shop: 'ALL', platform: 'ALL',
    status: 'ALL', groupBy: 'date', sku: '', skuGroupBy: 'sku',
  },
  tarik: { from: '', to: '', berjalan: false },
};

/* Warna status mengikuti tahapan alur order, bukan sekadar berbeda-beda. */
const STATUS_NADA = {
  UNPAID: 'badge', IN_CANCEL: 'badge--blocked', CANCELLED: 'badge--blocked',
  READY_TO_PROCESS: 'badge--new', PROCESSED: 'badge--new',
  PICK_ASSIGNED: 'badge--new', PICKED: 'badge--new', SORTED: 'badge--new',
  PACKED: 'badge--new', MANIFESTED: 'badge--new',
  IN_TRANSIT: 'badge--new', DELIVERED: 'badge--ready', RETURN: 'badge--blocked',
};

function hariIni() { return new Date().toISOString().slice(0, 10); }
function hariLalu(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

/*
 * Perkiraan durasi penarikan, berdasarkan pengukuran nyata.
 *
 * OCS menyegarkan materialized view untuk data terkini sehingga 30 hari
 * terakhir dijawab ~2,5 detik per hari. Data yang lebih lama tampaknya dipindai
 * dari tabel order 19,6 juta baris dan jauh lebih lambat. Satu angka rata-rata
 * akan menyesatkan, jadi keduanya dihitung terpisah.
 *
 * Angka data lama pernah diukur 31 detik per hari saat potongannya masih 7 hari;
 * setelah potongan untuk data lama dikecilkan menjadi 3 hari, pengukuran ulang
 * atas 39 hari memberi 14,5 detik per hari. Nilai di bawah memakai hasil
 * pengukuran terakhir itu.
 */
const DETIK_PER_HARI_BARU = 2.5;
const DETIK_PER_HARI_LAMA = 14.5;
const BATAS_HARI_LAMA = 30;

function perkiraanDetik(from, to) {
  const awal = Date.parse(`${from}T00:00:00Z`);
  const akhir = Date.parse(`${to}T00:00:00Z`);
  const batas = Date.now() - BATAS_HARI_LAMA * 86400000;
  let detik = 0;
  for (let t = awal; t <= akhir; t += 86400000) {
    detik += t < batas ? DETIK_PER_HARI_LAMA : DETIK_PER_HARI_BARU;
  }
  return Math.round(detik);
}

function formatDurasi(detik) {
  if (detik < 90) return `${detik} detik`;
  const menit = Math.round(detik / 60);
  if (menit < 90) return `${menit} menit`;
  return `${(menit / 60).toFixed(1)} jam`;
}

async function renderSales() {
  const main = $('#main');
  main.innerHTML = `<div class="page"><p class="muted">Memuat…</p></div>`;

  if (!SL.nilai.from) {
    SL.nilai.from = hariLalu(29);
    SL.nilai.to = hariIni();
  }
  if (!SL.tarik.from) {
    SL.tarik.from = hariLalu(29);
    SL.tarik.to = hariIni();
  }

  try {
    SL.ringkasan = await api(`/api/sales/summary?from=${SL.nilai.from}&to=${SL.nilai.to}`);
  } catch (err) {
    main.innerHTML = `<div class="page"></div>`;
    return toast(err.message, 'error');
  }
  paintSales();
}

function paintSales() {
  const s = SL.ringkasan || {};
  const c = s.coverage || {};
  const v = SL.nilai;

  const belumAdaData = !c.hari;

  const tiles = [
    { label: 'Total Order', value: s.totalOrder, tone: 'informative',
      foot: v.from ? `${v.from} s/d ${v.to}` : 'seluruh data' },
    { label: 'Barang Terjual', value: s.totalQty, tone: 'positive', foot: 'pcs pada rentang yang sama' },
    { label: 'Hari Tersimpan', value: c.hari || 0, tone: 'neutral',
      foot: c.dari ? `${c.dari} s/d ${c.sampai}` : 'belum ada data' },
  ].map((t) => `
    <div class="tile tile--${t.tone}" style="cursor:default">
      <span class="tile__label">${esc(t.label)}</span>
      <span class="tile__value">${fmt(t.value || 0)}</span>
      <span class="tile__foot">${esc(t.foot)}</span>
    </div>`).join('');

  const peringatanKosong = belumAdaData ? `
    <div class="strip strip--warning">
      ${icon('alert')}
      <span>
        Belum ada data penjualan tersimpan. Buka bagian <b>Tarik Data</b>, pilih rentang
        tanggalnya, lalu tarik dari OCS.
      </span>
    </div>` : '';

  const kosong = (c.kosong && c.kosong.length) ? `
    <div class="strip strip--error">
      ${icon('error')}
      <span>
        <b>${fmt(c.kosong.length)} hari</b> tercatat sudah ditarik tetapi tidak berisi data:
        ${c.kosong.slice(0, 10).map((t) => `<span class="badge badge--blocked">${esc(t)}</span>`).join(' ')}
        ${c.kosong.length > 10 ? ` dan ${fmt(c.kosong.length - 10)} lainnya` : ''}.
        Tarik ulang tanggal itu lewat <b>Tarik Data</b> — cakupannya tampak lengkap padahal tidak.
      </span>
    </div>` : '';

  const bolong = (c.bolong && c.bolong.length) ? `
    <div class="strip strip--warning">
      ${icon('alert')}
      <span>
        <b>${fmt(c.bolong.length)} hari</b> di dalam rentang tersimpan belum pernah ditarik:
        ${c.bolong.slice(0, 10).map((t) => `<span class="badge">${esc(t)}</span>`).join(' ')}
        ${c.bolong.length > 10 ? ` dan ${fmt(c.bolong.length - 10)} lainnya` : ''}.
        Angka pada rentang itu belum lengkap.
      </span>
    </div>` : '';

  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">Penjualan</h1>
      <p class="page__desc">
        Agregat harian dari halaman Report OCS — jumlah order per status dan barang terjual per SKU.
      </p>

      ${peringatanKosong}${kosong}${bolong}

      <div class="tiles">${tiles}</div>

      <section class="panel">
        <div class="toolbar">
          <div class="segmented">
            <button data-sl-view="order" class="${SL.tampilan === 'order' ? 'is-active' : ''}">Order</button>
            <button data-sl-view="sku" class="${SL.tampilan === 'sku' ? 'is-active' : ''}">SKU</button>
            <button data-sl-view="tarik" class="${SL.tampilan === 'tarik' ? 'is-active' : ''}">Tarik Data</button>
          </div>
          <div class="toolbar__spacer"></div>
          ${c.terakhir ? `<span class="panel__hint">Terakhir ditarik ${fmtWaktu(c.terakhir)}</span>` : ''}
        </div>
        <div id="slBody"></div>
      </section>
    </div>`;

  $$('[data-sl-view]').forEach((b) => {
    b.onclick = () => { SL.tampilan = b.dataset.slView; SL.hasil = null; paintSales(); };
  });

  if (SL.tampilan === 'tarik') paintTarik();
  else paintFilterPenjualan();
}

/* ---------------------------- Filter bersama ---------------------------- */

function opsiSelect(list, dipilih, labelSemua) {
  return [`<option value="ALL">${labelSemua}</option>`]
    .concat(list.map((x) => `<option value="${esc(x)}" ${dipilih === x ? 'selected' : ''}>${esc(x)}</option>`))
    .join('');
}

function paintFilterPenjualan() {
  const f = SL.ringkasan?.filters || { shop: [], platform: [], area: [], status: [] };
  const v = SL.nilai;
  const isOrder = SL.tampilan === 'order';

  const filterSku = `
    <div class="field" style="flex:1 1 16rem">
      <label class="field__label" for="slSku">Kode SKU</label>
      <input class="input" id="slSku" type="search" placeholder="Kosongkan untuk semua SKU" value="${esc(v.sku)}">
    </div>
    <label class="switch" style="margin-bottom:.35rem"
           title="Aktif: hanya kode yang sama persis. Nonaktif: semua kode yang mengandung kata kunci.">
      <input type="checkbox" id="slPersis" ${SL.cocokPersis ? 'checked' : ''}>
      <span class="switch__track"></span>
      <span class="switch__text"><span class="switch__title">Cocok persis</span></span>
    </label>`;

  const filterStatus = `
    <div class="field">
      <label class="field__label" for="slStatus">Status</label>
      <select class="select" id="slStatus">${opsiSelect(f.status, v.status, 'Semua status')}</select>
    </div>`;

  $('#slBody').innerHTML = `
    <div class="toolbar" style="background:transparent;box-shadow:none">
      <div class="field">
        <label class="field__label" for="slFrom">Dari tanggal</label>
        <input class="input" id="slFrom" type="date" value="${esc(v.from)}">
      </div>
      <div class="field">
        <label class="field__label" for="slTo">Sampai</label>
        <input class="input" id="slTo" type="date" value="${esc(v.to)}">
      </div>
      <div class="field">
        <label class="field__label" for="slArea">Area</label>
        <select class="select" id="slArea">${opsiSelect(f.area, v.area, 'Semua area')}</select>
      </div>
      ${isOrder ? `
      <div class="field">
        <label class="field__label" for="slShop">Brand</label>
        <select class="select" id="slShop">${opsiSelect(f.shop, v.shop, 'Semua brand')}</select>
      </div>` : ''}
      <div class="field">
        <label class="field__label" for="slPlatform">Platform</label>
        <select class="select" id="slPlatform">${opsiSelect(f.platform, v.platform, 'Semua platform')}</select>
      </div>
      ${isOrder ? filterStatus : filterSku}
      <div class="field">
        <label class="field__label" for="slGroup">Rincian</label>
        <select class="select" id="slGroup">
          ${(isOrder
            ? [['date', 'Per hari'], ['shop', 'Per hari & brand'], ['platform', 'Per hari & platform'], ['detail', 'Paling rinci']]
            : [['sku', 'Total per SKU'], ['day', 'Per hari & SKU'], ['platform', 'Per SKU & platform']]
          ).map(([val, lab]) => {
            const kini = isOrder ? v.groupBy : v.skuGroupBy;
            return `<option value="${val}" ${kini === val ? 'selected' : ''}>${lab}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="toolbar__spacer"></div>
      <button class="btn" id="slReset">Bersihkan Filter</button>
    </div>
    ${isOrder ? `
    <div class="panel__head" style="padding-top:0">
      <p class="panel__hint" style="margin:0">
        OCS mengelompokkan 32 status mentah menjadi 13 kelompok di bawah ini, dan
        jumlahnya selalu genap sama dengan total order.
      </p>
    </div>` : ''}
    <div id="slHasil"><div class="empty"><div class="muted">Memuat…</div></div></div>`;

  const ambil = () => {
    SL.nilai = {
      ...SL.nilai,
      from: $('#slFrom').value,
      to: $('#slTo').value,
      area: $('#slArea').value,
      shop: $('#slShop')?.value ?? 'ALL',
      platform: $('#slPlatform').value,
      status: $('#slStatus')?.value ?? 'ALL',
      sku: $('#slSku')?.value?.trim() ?? '',
      [isOrder ? 'groupBy' : 'skuGroupBy']: $('#slGroup').value,
    };
  };

  let debounce;
  for (const id of ['slFrom', 'slTo', 'slArea', 'slShop', 'slPlatform', 'slStatus', 'slGroup']) {
    const el = $(`#${id}`);
    if (el) el.onchange = async () => { ambil(); await muatRingkasanBila(id); cariPenjualan(); };
  }
  const boxSku = $('#slSku');
  if (boxSku) boxSku.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { ambil(); cariPenjualan(); }, 350);
  };
  const persis = $('#slPersis');
  if (persis) persis.onchange = (e) => { SL.cocokPersis = e.target.checked; ambil(); cariPenjualan(); };

  $('#slReset').onclick = () => {
    SL.nilai = {
      ...SL.nilai, from: hariLalu(29), to: hariIni(),
      area: 'ALL', shop: 'ALL', platform: 'ALL', status: 'ALL', sku: '',
    };
    SL.cocokPersis = true;
    renderSales();
  };

  cariPenjualan();
}

/** KPI ikut rentang tanggal, jadi kartunya disegarkan saat tanggal berubah. */
async function muatRingkasanBila(id) {
  if (id !== 'slFrom' && id !== 'slTo') return;
  try {
    SL.ringkasan = await api(`/api/sales/summary?from=${SL.nilai.from}&to=${SL.nilai.to}`);
    paintSales();
  } catch { /* biarkan tampilan lama */ }
}

function paramPenjualan() {
  const v = SL.nilai;
  const p = new URLSearchParams();
  if (v.from) p.set('from', v.from);
  if (v.to) p.set('to', v.to);
  if (v.area !== 'ALL') p.set('area', v.area);
  if (v.platform !== 'ALL') p.set('platform', v.platform);
  if (SL.tampilan === 'order') {
    if (v.shop !== 'ALL') p.set('shop', v.shop);
    if (v.status !== 'ALL') p.set('status', v.status);
    p.set('groupBy', v.groupBy);
  } else {
    if (v.sku) p.set('sku', v.sku);
    p.set('mode', SL.cocokPersis ? 'exact' : 'contains');
    p.set('groupBy', v.skuGroupBy);
  }
  return p;
}

async function cariPenjualan() {
  const host = $('#slHasil');
  if (!host) return;
  const jalur = SL.tampilan === 'order' ? '/api/sales/orders' : '/api/sales/sku';
  try {
    SL.hasil = await api(`${jalur}?${paramPenjualan()}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }
  if (SL.tampilan === 'order') paintHasilOrder();
  else paintHasilSku2();
}

/* ---------------------------- Tampilan Order ---------------------------- */

function paintHasilOrder() {
  const h = SL.hasil;
  const host = $('#slHasil');
  if (!h || !host) return;

  if (!h.rows.length) {
    host.innerHTML = `<div class="empty"><div class="empty__title">Tidak ada data pada rentang ini</div>
      <div>Pastikan tanggalnya sudah pernah ditarik lewat bagian <b>Tarik Data</b>.</div></div>`;
    return;
  }

  const dim = { date: [], shop: ['shop_name'], platform: ['commerce_platform'], detail: ['shop_name', 'commerce_platform'] }[h.groupBy] || [];
  const judulDim = { shop_name: 'Brand', commerce_platform: 'Platform' };
  const adaSoiMoi = h.groupBy === 'date' || h.groupBy === 'shop';

  const totalKolom = {};
  for (const r of h.rows) for (const st of h.statusColumns) totalKolom[st] = (totalKolom[st] || 0) + (r.status[st] || 0);
  const totalSemua = h.rows.reduce((a, r) => a + r.total, 0);

  host.innerHTML = `
    <div class="panel__head">
      <h2 class="panel__title">Order per Hari</h2>
      <p class="panel__hint" style="margin:0">${fmt(h.rows.length)} baris · total ${fmt(totalSemua)} order</p>
    </div>
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>Tanggal</th>
            ${dim.map((d) => `<th>${judulDim[d] || d}</th>`).join('')}
            <th class="num">Total</th>
            ${adaSoiMoi ? '<th class="num">SOI</th><th class="num">MOI</th>' : ''}
            ${h.statusColumns.map((st) => `<th class="num">${esc(st)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${h.rows.map((r) => `
            <tr>
              <td class="nowrap mono">${esc(r.sales_date)}</td>
              ${dim.map((d) => `<td>${r[d] ? `<span class="badge">${esc(r[d])}</span>` : '<span class="muted">—</span>'}</td>`).join('')}
              <td class="num"><b>${fmt(r.total)}</b></td>
              ${adaSoiMoi ? `<td class="num muted">${fmt(r.soi || 0)}</td><td class="num muted">${fmt(r.moi || 0)}</td>` : ''}
              ${h.statusColumns.map((st) => {
                const n = r.status[st] || 0;
                return `<td class="num ${n ? '' : 'muted'}">${n ? fmt(n) : '·'}</td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="font-weight:700;background:var(--surface-alt)">
            <td>Total</td>
            ${dim.map(() => '<td></td>').join('')}
            <td class="num">${fmt(totalSemua)}</td>
            ${adaSoiMoi ? '<td></td><td></td>' : ''}
            ${h.statusColumns.map((st) => `<td class="num">${fmt(totalKolom[st] || 0)}</td>`).join('')}
          </tr>
        </tfoot>
      </table>
    </div>`;
}

/* ---------------------------- Tampilan SKU ---------------------------- */

function paintHasilSku2() {
  const h = SL.hasil;
  const host = $('#slHasil');
  if (!h || !host) return;

  const tombolSku = (list) => list.map((s) =>
    `<button class="badge" style="cursor:pointer;margin:2px" data-sl-pick="${esc(s.sku)}">${esc(s.sku)} · ${fmt(s.jumlah)}</button>`,
  ).join(' ');

  if (!h.rows.length) {
    const saran = h.skuTerkait.length ? `
      <div style="margin-top:1rem">
        <div class="muted" style="margin-bottom:.5rem">Mungkin yang Anda maksud:</div>
        ${tombolSku(h.skuTerkait.slice(0, 12))}
      </div>` : '';
    host.innerHTML = `
      <div class="empty">
        <div class="empty__title">Tidak ada penjualan pada rentang ini</div>
        <div>${h.mode === 'exact' && SL.nilai.sku
          ? 'Pencocokan kode sedang disetel <b>persis</b>. Matikan sakelar itu untuk mencari kode yang mengandung kata kunci ini.'
          : 'Coba longgarkan filternya, atau tarik dulu tanggalnya lewat bagian <b>Tarik Data</b>.'}</div>
        ${saran}
      </div>`;
    $$('[data-sl-pick]').forEach((b) => {
      b.onclick = () => { $('#slSku').value = b.dataset.slPick; SL.nilai.sku = b.dataset.slPick; cariPenjualan(); };
    });
    return;
  }

  const perHari = h.groupBy === 'day';
  const perPlatform = h.groupBy === 'platform';

  host.innerHTML = `
    <div class="panel__head">
      <h2 class="panel__title">Barang Terjual</h2>
      <p class="panel__hint" style="margin:0">
        ${fmt(h.rows.length)} baris · ${fmt(h.totalSku)} SKU · total <b>${fmt(h.totalQty)}</b> pcs
      </p>
    </div>
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            ${perHari ? '<th>Tanggal</th>' : ''}
            <th>SKU</th>
            ${perPlatform ? '<th>Platform</th>' : ''}
            <th class="num">Qty Terjual</th>
            ${!perHari ? '<th class="num">Hari Ada Penjualan</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${h.rows.map((r) => `
            <tr>
              ${perHari ? `<td class="nowrap mono">${esc(r.sales_date)}</td>` : ''}
              <td><span class="obj-id__title">${esc(r.seller_sku)}</span></td>
              ${perPlatform ? `<td><span class="badge">${esc(r.commerce_platform)}</span></td>` : ''}
              <td class="num"><span class="obj-num obj-num--positive">${fmt(r.qty)}</span></td>
              ${!perHari ? `<td class="num muted">${fmt(r.hari)}</td>` : ''}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ---------------------------- Tarik Data ---------------------------- */

function paintTarik() {
  const c = SL.ringkasan?.coverage || {};
  const t = SL.tarik;

  $('#slBody').innerHTML = `
    <div class="panel__body">
      <p class="panel__hint" style="margin:0 0 .5rem">
        Pilih sendiri rentang tanggal yang ingin diambil dari OCS. Menarik rentang yang
        sama berulang kali aman — hari yang sudah ada <b>ditulis ulang</b>, bukan ditambahkan,
        sehingga angkanya tidak pernah berlipat.
      </p>
      <p class="panel__hint" style="margin:0 0 1rem">
        Rentang sepanjang apa pun boleh diisi. Permintaan ke OCS <b>dipecah otomatis</b>
        menjadi potongan kecil — 7 hari untuk data baru, 3 hari untuk data lama — sehingga
        batas 31 hari di OCS tidak pernah tersentuh. Potongan yang gagal dilaporkan dan
        bisa ditarik ulang sendiri tanpa mengganggu hari yang sudah masuk.
      </p>

      <div class="toolbar" style="background:transparent;box-shadow:none;padding-left:0">
        <div class="field">
          <label class="field__label" for="slTarikFrom">Dari tanggal</label>
          <input class="input" id="slTarikFrom" type="date" value="${esc(t.from)}">
        </div>
        <div class="field">
          <label class="field__label" for="slTarikTo">Sampai</label>
          <input class="input" id="slTarikTo" type="date" value="${esc(t.to)}">
        </div>
        <div class="field">
          <label class="field__label">Pintasan</label>
          <div class="row">
            ${[7, 30, 90, 365].map((n) => {
              const d = perkiraanDetik(hariLalu(n - 1), hariIni());
              return `<button class="btn btn--sm" data-sl-cepat="${n}" title="Perkiraan ${formatDurasi(d)}">
                        ${n === 365 ? '1 tahun' : n + ' hari'} <span class="muted">~${formatDurasi(d)}</span>
                      </button>`;
            }).join('')}
          </div>
        </div>
        <div class="toolbar__spacer"></div>
        <button class="btn" id="slLengkapiBtn" title="Hanya menarik tanggal yang belum tersimpan di rentang ini">
          ${icon('refresh')} Lengkapi yang Kosong
        </button>
        <button class="btn btn--emphasized" id="slTarikBtn">${icon('download')} Tarik Ulang Semua</button>
      </div>

      <div id="slTarikPesan"></div>

      <h3 class="panel__title" style="margin:1.5rem 0 .5rem">Hari yang Sudah Tersimpan</h3>
      <p class="panel__hint" style="margin:0 0 .75rem">
        ${c.hari ? `${fmt(c.hari)} hari, ${esc(c.dari)} sampai ${esc(c.sampai)}` : 'Belum ada.'}
      </p>
      <div id="slHari"><div class="muted">Memuat…</div></div>
    </div>`;

  $$('[data-sl-cepat]').forEach((b) => {
    b.onclick = () => {
      const n = Number(b.dataset.slCepat);
      $('#slTarikFrom').value = hariLalu(n - 1);
      $('#slTarikTo').value = hariIni();
    };
  });

  $('#slTarikBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    const from = $('#slTarikFrom').value;
    const to = $('#slTarikTo').value;
    if (!from || !to) return toast('Isi kedua tanggalnya dulu.', 'error');
    if (from > to) return toast('Tanggal awal melewati tanggal akhir.', 'error');

    const hari = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const pesan = $('#slTarikPesan');
    btn.disabled = true;
    const asli = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span><span>Menarik…</span>`;
    const perkiraan = formatDurasi(perkiraanDetik(from, to));
    pesan.innerHTML = `
      <div class="strip">
        ${icon('alert')}
        <span>
          Menarik <b>${fmt(hari)} hari</b> dari OCS, perkiraan <b>${perkiraan}</b> — jangan tutup halaman ini.
          Data lebih dari 30 hari ke belakang jauh lebih lambat karena tidak dilayani
          ringkasan siap pakai di OCS.
        </span>
      </div>`;

    try {
      const r = await api('/api/sales/pull', { method: 'POST', body: JSON.stringify({ from, to }) });
      const adaGagal = r.gagal && r.gagal.length;
      pesan.innerHTML = `
        <div class="strip ${adaGagal ? 'strip--warning' : 'strip--success'}">
          ${icon(adaGagal ? 'alert' : 'check')}
          <span>
            Selesai: <b>${fmt(r.hari)} hari</b>, ${fmt(r.orderRows)} baris order dan
            ${fmt(r.skuRows)} baris SKU, dalam ${formatDurasi(Math.round(r.durationMs / 1000))}.
            ${adaGagal ? `<br><b>${r.gagal.length} potongan gagal</b> dan hari di dalamnya belum lengkap:
              ${r.gagal.map((g) => `<span class="badge badge--blocked">${esc(g.from)}…${esc(g.to)}</span>`).join(' ')}
              — tarik ulang rentang itu saja, aman diulang.` : ''}
          </span>
        </div>`;
      SL.tarik = { from, to, berjalan: false };
      SL.ringkasan = await api(`/api/sales/summary?from=${SL.nilai.from}&to=${SL.nilai.to}`);
      await muatDaftarHari();
    } catch (err) {
      pesan.innerHTML = `<div class="strip strip--error">${icon('error')}<span>${esc(err.message)}</span></div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = asli;
    }
  };

  /*
   * "Lengkapi yang Kosong" hanya menyentuh tanggal yang belum tersimpan.
   * Jauh lebih murah daripada menarik ulang seluruh rentang, dan inilah cara
   * yang dipakai saat memperluas cakupan ke belakang.
   */
  $('#slLengkapiBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    const from = $('#slTarikFrom').value;
    const to = $('#slTarikTo').value;
    if (!from || !to) return toast('Isi kedua tanggalnya dulu.', 'error');

    const pesan = $('#slTarikPesan');
    btn.disabled = true;
    const asli = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span><span>Memeriksa…</span>`;
    try {
      const r = await api('/api/sales/fill', { method: 'POST', body: JSON.stringify({ from, to }) });
      pesan.innerHTML = r.sudahLengkap
        ? `<div class="strip strip--success">${icon('check')}<span>Rentang ini sudah lengkap — tidak ada yang perlu ditarik.</span></div>`
        : `<div class="strip strip--success">${icon('check')}<span>
             Melengkapi <b>${fmt(r.hari)}</b> dari ${fmt(r.diminta)} hari yang kosong,
             dalam ${formatDurasi(Math.round(r.durationMs / 1000))}.
             ${r.gagal.length ? `<br><b>${r.gagal.length} potongan gagal</b> — jalankan lagi untuk mengejar sisanya.` : ''}
           </span></div>`;
      SL.ringkasan = await api(`/api/sales/summary?from=${SL.nilai.from}&to=${SL.nilai.to}`);
      await muatDaftarHari();
    } catch (err) {
      pesan.innerHTML = `<div class="strip strip--error">${icon('error')}<span>${esc(err.message)}</span></div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = asli;
    }
  };

  muatDaftarHari();
}

async function muatDaftarHari() {
  const host = $('#slHari');
  if (!host) return;
  try {
    SL.hari = await api('/api/sales/days?limit=400');
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }
  if (!SL.hari.length) {
    host.innerHTML = `<div class="muted">Belum ada hari yang ditarik.</div>`;
    return;
  }
  host.innerHTML = `
    <div class="table-wrap" style="max-height:22rem;overflow-y:auto">
      <table class="ftable">
        <thead><tr><th>Tanggal</th><th class="num">Baris Order</th><th class="num">Baris SKU</th><th>Ditarik</th><th>Angka</th></tr></thead>
        <tbody>
          ${SL.hari.map((d) => `
            <tr>
              <td class="mono nowrap">${esc(d.tanggal)}</td>
              <td class="num">${fmt(d.orderRows)}</td>
              <td class="num">${fmt(d.skuRows)}</td>
              <td class="muted nowrap">${fmtWaktu(d.pulledAt)}</td>
              <td>${d.stableCount >= 2
                ? '<span class="badge badge--ready" title="Isinya sudah sama beberapa kali berturut-turut, jadi tidak ditarik ulang lagi">Mengendap</span>'
                : '<span class="badge badge--new" title="Masih mungkin berubah, jadi tetap disegarkan berkala">Masih berubah</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
