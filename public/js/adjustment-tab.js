/* =========================================================================
   Tab "Adjustment Stok".

   Menelusuri riwayat penyesuaian stok dari OCS. Satu baris di tabel berarti
   satu SKU pada satu transaksi — bentuk yang paling langsung untuk ditelusuri
   maupun diekspor, ketimbang harus membuka dokumen satu per satu.
   ========================================================================= */

const ADJ = {
  ringkasan: null,
  filters: { tipe: [], shop: [], user: [], area: [] },
  hasil: null,
  // Sama seperti riwayat replenish: pencocokan kode persis secara bawaan.
  cocokPersis: true,
  nilai: { sku: '', type: 'ALL', shop: 'ALL', user: 'ALL', from: '', to: '', remarks: '' },
};

function adjTypeBadge(t) {
  if (t === 'IN') return '<span class="badge badge--ready">IN</span>';
  if (t === 'OUT') return '<span class="badge badge--blocked">OUT</span>';
  return `<span class="badge">${esc(t || '—')}</span>`;
}

/*
 * Angka penyesuaian diberi tanda plus/minus dan warna, tetapi barisnya sengaja
 * TIDAK diberi latar merah seperti baris stok minus di dashboard. Penyesuaian
 * bernilai negatif adalah operasi normal, bukan keadaan yang perlu dialarmkan —
 * dan mewarnai seluruh tabel merah justru menghilangkan artinya.
 */
function qtyCell(q) {
  const n = Number(q) || 0;
  const cls = n < 0 ? 'obj-num--negative' : n > 0 ? 'obj-num--positive' : 'obj-num--neutral';
  const tanda = n > 0 ? '+' : '';
  return `<span class="obj-num ${cls}">${tanda}${fmt(n)}</span>`;
}

async function renderAdjustment() {
  const main = $('#main');
  main.innerHTML = `<div class="page"><p class="muted">Memuat…</p></div>`;
  try {
    const s = await api('/api/adjustment/summary');
    ADJ.ringkasan = s;
    ADJ.filters = s.filters || ADJ.filters;
  } catch (err) {
    main.innerHTML = `<div class="page"></div>`;
    return toast(err.message, 'error');
  }
  paintAdjustment();
  cariAdjustment();
}

function paintAdjustment() {
  const s = ADJ.ringkasan || {};
  const v = ADJ.nilai;

  const tiles = [
    { key: 'ALL', label: 'Total Transaksi', value: s.totalTransaksi, tone: 'neutral',
      foot: `${fmt(s.totalBaris)} baris penyesuaian` },
    { key: 'IN', label: 'Penambahan', value: s.masuk, tone: 'positive',
      foot: `+${fmt(s.qtyNaik)} pcs` },
    { key: 'OUT', label: 'Pengurangan', value: s.keluar, tone: 'negative',
      foot: `${fmt(s.qtyTurun)} pcs` },
  ].map((t) => `
    <button class="tile tile--${t.tone} ${v.type === t.key ? 'is-active' : ''}" data-adj-type="${t.key}">
      <span class="tile__label">${esc(t.label)}</span>
      <span class="tile__value">${fmt(t.value || 0)}</span>
      <span class="tile__foot">${esc(t.foot)}</span>
    </button>`).join('');

  const opsi = (list, dipilih, labelSemua) =>
    [`<option value="ALL">${labelSemua}</option>`]
      .concat(list.map((x) => `<option value="${esc(x)}" ${dipilih === x ? 'selected' : ''}>${esc(x)}</option>`))
      .join('');

  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">Adjustment Stok</h1>
      <p class="page__desc">
        Riwayat penyesuaian stok dari OCS. Satu baris berarti satu SKU pada satu transaksi.
      </p>

      <div class="tiles">${tiles}</div>

      <section class="panel">
        <div class="toolbar">
          <div class="field" style="flex:1 1 18rem">
            <label class="field__label" for="adjSku">Kode SKU</label>
            <input class="input" id="adjSku" type="search" autocomplete="off"
                   placeholder="Kosongkan untuk melihat semua" value="${esc(v.sku)}">
          </div>
          <div class="field">
            <label class="field__label" for="adjType">Jenis</label>
            <select class="select" id="adjType">
              <option value="ALL">Semua</option>
              ${ADJ.filters.tipe.map((t) => `<option value="${esc(t)}" ${v.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field__label" for="adjShop">Brand</label>
            <select class="select" id="adjShop">${opsi(ADJ.filters.shop, v.shop, 'Semua brand')}</select>
          </div>
          <div class="field">
            <label class="field__label" for="adjUser">Pengguna</label>
            <select class="select" id="adjUser">${opsi(ADJ.filters.user, v.user, 'Semua pengguna')}</select>
          </div>
          <div class="field">
            <label class="field__label" for="adjFrom">Dari tanggal</label>
            <input class="input" id="adjFrom" type="date" value="${esc(v.from)}">
          </div>
          <div class="field">
            <label class="field__label" for="adjTo">Sampai</label>
            <input class="input" id="adjTo" type="date" value="${esc(v.to)}">
          </div>
          <div class="field" style="flex:1 1 12rem">
            <label class="field__label" for="adjRemarks">Keterangan</label>
            <input class="input" id="adjRemarks" type="search" placeholder="Cari di kolom remarks" value="${esc(v.remarks)}">
          </div>
          <label class="switch" style="margin-bottom:.35rem"
                 title="Aktif: hanya kode yang sama persis. Nonaktif: semua kode yang mengandung kata kunci.">
            <input type="checkbox" id="adjPersis" ${ADJ.cocokPersis ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__text"><span class="switch__title">Cocok persis</span></span>
          </label>
          <div class="toolbar__spacer"></div>
          <button class="btn" id="adjReset">Bersihkan Filter</button>
          <a class="btn" id="adjExport" href="#">${icon('download')} Ekspor CSV</a>
          <button class="btn" id="adjSync">${icon('refresh')} Tarik Data Terbaru</button>
        </div>
        <div id="adjHasil"><div class="empty"><div class="muted">Memuat…</div></div></div>
      </section>
    </div>`;

  const ambilNilai = () => {
    ADJ.nilai = {
      sku: $('#adjSku').value.trim(),
      type: $('#adjType').value,
      shop: $('#adjShop').value,
      user: $('#adjUser').value,
      from: $('#adjFrom').value,
      to: $('#adjTo').value,
      remarks: $('#adjRemarks').value.trim(),
    };
  };

  let debounce;
  const tunda = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { ambilNilai(); cariAdjustment(); }, 350);
  };

  $('#adjSku').oninput = tunda;
  $('#adjRemarks').oninput = tunda;
  for (const id of ['adjType', 'adjShop', 'adjUser', 'adjFrom', 'adjTo']) {
    $(`#${id}`).onchange = () => { ambilNilai(); cariAdjustment(); };
  }
  $('#adjPersis').onchange = (e) => {
    ADJ.cocokPersis = e.target.checked;
    ambilNilai();
    cariAdjustment();
  };

  // Tautan ekspor mengikuti filter yang sedang aktif, bukan seluruh tabel.
  const segarkanEkspor = () => {
    const a = $('#adjExport');
    if (a) a.href = `/api/adjustment/export.csv?${adjQuery()}`;
  };
  segarkanEkspor();
  $('#adjExport').onclick = segarkanEkspor;

  $$('[data-adj-type]').forEach((b) => {
    b.onclick = () => {
      ADJ.nilai.type = b.dataset.adjType;
      paintAdjustment();
      cariAdjustment();
    };
  });

  $('#adjReset').onclick = () => {
    ADJ.nilai = { sku: '', type: 'ALL', shop: 'ALL', user: 'ALL', from: '', to: '', remarks: '' };
    ADJ.cocokPersis = true;
    paintAdjustment();
    cariAdjustment();
  };

  $('#adjSync').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const asli = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span><span>Menarik…</span>`;
    try {
      const r = await api('/api/adjustment/sync', { method: 'POST' });
      toast(
        `Selesai: ${fmt(r.heads.stored)} transaksi, ${fmt(r.details.lines)} baris detail (${r.durationMs} ms).`,
        'success',
      );
      await renderAdjustment();
    } catch (err) {
      toast(`Gagal menarik data: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = asli;
    }
  };
}

function adjQuery() {
  const v = ADJ.nilai;
  const p = new URLSearchParams({ mode: ADJ.cocokPersis ? 'exact' : 'contains' });
  if (v.sku) p.set('sku', v.sku);
  if (v.type && v.type !== 'ALL') p.set('type', v.type);
  if (v.shop && v.shop !== 'ALL') p.set('shop', v.shop);
  if (v.user && v.user !== 'ALL') p.set('user', v.user);
  if (v.from) p.set('from', v.from);
  if (v.to) p.set('to', v.to);
  if (v.remarks) p.set('remarks', v.remarks);
  return p;
}

async function cariAdjustment() {
  const host = $('#adjHasil');
  if (!host) return;

  try {
    ADJ.hasil = await api(`/api/adjustment/search?${adjQuery()}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }
  paintHasilAdjustment();
  const a = $('#adjExport');
  if (a) a.href = `/api/adjustment/export.csv?${adjQuery()}`;
}

function paintHasilAdjustment() {
  const h = ADJ.hasil;
  const host = $('#adjHasil');
  if (!h || !host) return;

  const tombolSku = (list) => list.map((s) =>
    `<button class="badge" style="cursor:pointer;margin:2px" data-adj-pick="${esc(s.sku)}">${esc(s.sku)} · ${fmt(s.jumlah)}</button>`,
  ).join(' ');

  if (!h.rows.length) {
    const persis = h.mode !== 'contains';
    const saran = h.skuTerkait.length ? `
      <div style="margin-top:1rem">
        <div class="muted" style="margin-bottom:.5rem">Mungkin yang Anda maksud:</div>
        ${tombolSku(h.skuTerkait.slice(0, 12))}
      </div>` : '';

    host.innerHTML = `
      <div class="empty">
        <div class="empty__title">Tidak ada penyesuaian yang cocok</div>
        <div>${persis && ADJ.nilai.sku
          ? 'Pencocokan kode sedang disetel <b>persis</b>. Matikan sakelar itu untuk mencari kode yang mengandung kata kunci ini.'
          : 'Coba longgarkan filternya.'}</div>
        ${saran}
      </div>`;
    pasangAksiAdjustment();
    return;
  }

  // Saat mode sebagian aktif, hasilnya menggabungkan beberapa SKU — itu harus
  // dinyatakan supaya jumlah qty tidak dikira milik satu barang.
  const peringatan = (h.mode === 'contains' && h.skuTerkait.length > 1) ? `
    <div class="strip strip--warning" style="margin:1rem">
      ${icon('alert')}
      <span>Hasil ini <b>menggabungkan ${h.skuTerkait.length} SKU</b>: ${tombolSku(h.skuTerkait.slice(0, 12))}</span>
    </div>` : '';

  const catatanBatas = h.dibatasi ? `
    <p class="panel__hint" style="margin:0">
      Menampilkan ${fmt(h.rows.length)} baris teratas dari <b>${fmt(h.total)}</b>.
      Persempit filter atau ekspor ke CSV untuk melihat seluruhnya.
    </p>` : `
    <p class="panel__hint" style="margin:0">${fmt(h.total)} baris</p>`;

  host.innerHTML = `
    ${peringatan}
    <div class="panel__head">
      <h2 class="panel__title">Hasil</h2>
      ${catatanBatas}
      <div class="toolbar__spacer"></div>
      <p class="panel__hint" style="margin:0">
        Total penyesuaian: <b class="${h.totalQty < 0 ? 'delta--down' : 'delta--up'}">${h.totalQty > 0 ? '+' : ''}${fmt(h.totalQty)}</b> pcs
      </p>
    </div>
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>Waktu</th><th>No. Transaksi</th><th>Jenis</th><th>SKU</th>
            <th class="num">Qty</th><th>Keterangan</th><th>Brand</th><th>Oleh</th><th class="num"></th>
          </tr>
        </thead>
        <tbody>
          ${h.rows.map((r) => `
            <tr>
              <td class="nowrap">${fmtWaktu(r.created_at)}</td>
              <td><span class="mono">${esc(r.transaction_id || '—')}</span></td>
              <td>${adjTypeBadge(r.adj_type)}</td>
              <td><span class="obj-id__title">${esc(r.seller_sku || '—')}</span></td>
              <td class="num">${qtyCell(r.qty)}</td>
              <td class="muted">${esc(r.remarks || '—')}</td>
              <td>${r.shop_code ? `<span class="badge">${esc(r.shop_code)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="muted">${esc(r.user_code || '—')}</td>
              <td class="num">
                <button class="btn btn--sm btn--transparent" data-adj-trx="${esc(r.id)}"
                        title="Lihat seluruh isi transaksi">${icon('doc')}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  pasangAksiAdjustment();
}

function pasangAksiAdjustment() {
  $$('[data-adj-pick]').forEach((b) => {
    b.onclick = () => {
      $('#adjSku').value = b.dataset.adjPick;
      ADJ.nilai.sku = b.dataset.adjPick;
      cariAdjustment();
    };
  });
  $$('[data-adj-trx]').forEach((b) => {
    b.onclick = () => bukaAdjustment(b.dataset.adjTrx);
  });
}

async function bukaAdjustment(id) {
  const host = $('#dialogHost');
  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog"><div class="dialog__body"><p class="muted">Memuat transaksi…</p></div></div>
    </div>`;

  let d;
  try {
    d = await api(`/api/adjustment/trx/${encodeURIComponent(id)}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  const total = d.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);

  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" style="width:min(48rem,100%)">
        <div class="dialog__head">
          <h2 class="dialog__title">${esc(d.transaction_id || `Transaksi #${d.id}`)}</h2>
          ${adjTypeBadge(d.adj_type)}
          <button class="btn btn--sm btn--transparent" style="margin-left:auto" id="adjTutup">${icon('close')}</button>
        </div>
        <div class="dialog__body">
          <div class="grid-2" style="gap:.35rem 1.5rem;margin-bottom:1rem">
            ${[
              ['Waktu', fmtWaktu(d.created_at)],
              ['Area', d.area_id],
              ['Brand', d.shop_code || '—'],
              ['Dilakukan oleh', d.user_code],
            ].map(([k, v]) => `
              <div class="setting-row" style="padding:.35rem 0;border:none">
                <div class="setting-row__main">
                  <div class="setting-row__desc" style="margin:0">${esc(k)}</div>
                  <div class="setting-row__title">${esc(v || '—')}</div>
                </div>
              </div>`).join('')}
          </div>

          <h3 class="panel__title" style="margin:0 0 .5rem">
            Baris Penyesuaian (${fmt(d.lines.length)}) ·
            total <span class="${total < 0 ? 'delta--down' : 'delta--up'}">${total > 0 ? '+' : ''}${fmt(total)}</span> pcs
          </h3>
          ${d.lines.length ? `
          <div class="table-wrap">
            <table class="ftable">
              <thead><tr><th class="num">#</th><th>SKU</th><th class="num">Qty</th><th>Keterangan</th></tr></thead>
              <tbody>
                ${d.lines.map((l) => `
                  <tr>
                    <td class="num muted">${l.row_no}</td>
                    <td><span class="obj-id__title">${esc(l.seller_sku || '—')}</span></td>
                    <td class="num">${qtyCell(l.qty)}</td>
                    <td class="muted">${esc(l.remarks || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `<div class="empty" style="padding:1.5rem"><div class="muted">Transaksi ini tidak punya baris detail.</div></div>`}
        </div>
        <div class="dialog__foot"><button class="btn" id="adjTutup2">Tutup</button></div>
      </div>
    </div>`;

  const tutup = () => { host.innerHTML = ''; };
  $('#adjTutup').onclick = tutup;
  $('#adjTutup2').onclick = tutup;
  host.querySelector('.dialog-backdrop').onclick = (e) => {
    if (e.target === e.currentTarget) tutup();
  };
}
