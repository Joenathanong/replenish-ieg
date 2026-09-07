/* =========================================================================
   Tab "Transaksi Replenish".

   Dua sudut pandang atas kejadian yang sama, karena keduanya menjawab
   pertanyaan berbeda:

     Masuk ke Rak     — SKU ini pernah masuk ke bin mana, berapa, oleh siapa.
     Dokumen Transfer — dokumen SAP mana yang memuatnya, dan berhasil posting
                        atau gagal.
   ========================================================================= */

const RP = {
  query: '',
  hasil: null,
  ringkasan: null,
  tampilan: 'sku',          // 'sku' | 'dokumen'
  statusFilter: 'ALL',
  dokumen: [],
  memuat: false,
};

function statusBadge(status) {
  const map = {
    Success: ['badge--ready', 'Berhasil'],
    Failed: ['badge--blocked', 'Gagal'],
    Pending: ['badge--new', 'Tertunda'],
  };
  const [cls, label] = map[status] || ['', status || '—'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function fmtWaktu(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(String(iso).slice(0, 19));
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Dipanggil router saat hash berbentuk "transaksi/<sku>". */
function setReplenishQuery(sku) {
  const q = String(sku || '').trim();
  if (q) {
    RP.query = q;
    RP.tampilan = 'sku';
    RP.hasil = null;   // paksa ambil ulang untuk kata kunci baru
  }
}

async function renderTransaksi() {
  const main = $('#main');
  main.innerHTML = `<div class="page"><p class="muted">Memuat…</p></div>`;

  try {
    RP.ringkasan = await api('/api/replenish/summary');
  } catch (err) {
    main.innerHTML = `<div class="page"></div>`;
    return toast(err.message, 'error');
  }

  paintTransaksi();
}

function paintTransaksi() {
  const s = RP.ringkasan || {};

  const tiles = [
    { key: 'ALL', label: 'Total Dokumen', value: s.totalDokumen, tone: 'neutral',
      foot: `${fmt(s.totalBarisDetail)} baris detail` },
    { key: 'Success', label: 'Berhasil Posting', value: s.berhasil, tone: 'positive',
      foot: 'Terkirim ke SAP' },
    { key: 'Failed', label: 'Gagal Posting', value: s.gagal, tone: 'negative',
      foot: 'Perlu ditindaklanjuti' },
    { key: 'Pending', label: 'Tertunda', value: s.tertunda, tone: 'critical',
      foot: 'Belum selesai diproses' },
    { key: 'BIN', label: 'Log Masuk Rak', value: s.totalLogBin, tone: 'informative',
      foot: 'Baris pergerakan ke bin' },
  ].map((t) => `
    <button class="tile tile--${t.tone} ${RP.tampilan === 'dokumen' && RP.statusFilter === t.key ? 'is-active' : ''}"
            data-rp-status="${t.key}">
      <span class="tile__label">${esc(t.label)}</span>
      <span class="tile__value">${fmt(t.value || 0)}</span>
      <span class="tile__foot">${esc(t.foot)}</span>
    </button>`).join('');

  const catatanBackfill = s.detailBelumTertarik > 0 ? `
    <div class="strip strip--warning">
      ${icon('alert')}
      <span>
        Detail dari <b>${fmt(s.detailBelumTertarik)}</b> dokumen belum selesai ditarik dari OCS.
        Baris detail hanya bisa diambil satu per satu, jadi pengambilan awal berlangsung bertahap.
        Dokumen tersebut sudah tercatat, hanya isi barisnya yang belum lengkap.
      </span>
    </div>` : '';

  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">Transaksi Replenish</h1>
      <p class="page__desc">
        Riwayat pemindahan stok ke rak dan dokumen transfer ke SAP, ditarik dari OCS
        dan disimpan agar bisa ditelusuri per SKU.
      </p>

      ${catatanBackfill}

      <div class="tiles">${tiles}</div>

      <section class="panel">
        <div class="toolbar">
          <div class="segmented">
            <button data-rp-view="sku" class="${RP.tampilan === 'sku' ? 'is-active' : ''}">Cari per SKU</button>
            <button data-rp-view="dokumen" class="${RP.tampilan === 'dokumen' ? 'is-active' : ''}">Telusuri Dokumen</button>
          </div>
          <div class="toolbar__spacer"></div>
          <button class="btn" id="rpSync">${icon('refresh')} Tarik Data Terbaru</button>
        </div>

        <div id="rpBody"></div>
      </section>
    </div>`;

  $$('[data-rp-view]').forEach((b) => {
    b.onclick = () => {
      RP.tampilan = b.dataset.rpView;
      paintTransaksi();
    };
  });

  $$('[data-rp-status]').forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.rpStatus;
      if (key === 'BIN') {
        RP.tampilan = 'sku';
        paintTransaksi();
        $('#rpSku')?.focus();
        return;
      }
      RP.tampilan = 'dokumen';
      RP.statusFilter = key;
      paintTransaksi();
      await muatDokumen();
    };
  });

  $('#rpSync').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const asli = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span><span>Menarik…</span>`;
    try {
      const r = await api('/api/replenish/sync', { method: 'POST' });
      toast(
        `Selesai: ${fmt(r.binLog.stored)} log rak, ${fmt(r.docs.stored)} dokumen, ` +
        `${fmt(r.details.processed)} detail ditarik. Sisa antrean detail ${fmt(r.sisaDetail)}.`,
        'success',
      );
      RP.ringkasan = await api('/api/replenish/summary');
      paintTransaksi();
      if (RP.tampilan === 'dokumen') await muatDokumen();
    } catch (err) {
      toast(`Gagal menarik data: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = asli;
    }
  };

  if (RP.tampilan === 'sku') paintPencarianSku();
  else { paintDaftarDokumen(); muatDokumen(); }
}

// ---------------------------- Tampilan: cari per SKU ----------------------------

function paintPencarianSku() {
  $('#rpBody').innerHTML = `
    <div class="toolbar" style="background:transparent;box-shadow:none">
      <div class="field" style="flex:1 1 24rem">
        <label class="field__label" for="rpSku">Kode SKU</label>
        <input class="input" id="rpSku" type="search" autocomplete="off"
               placeholder="Ketik sebagian kode SKU, misalnya SERUM-GOLD" value="${esc(RP.query)}">
      </div>
      <div class="field">
        <label class="field__label" for="rpFrom">Dari tanggal</label>
        <input class="input" id="rpFrom" type="date">
      </div>
      <div class="field">
        <label class="field__label" for="rpTo">Sampai</label>
        <input class="input" id="rpTo" type="date">
      </div>
    </div>
    <div id="rpHasil"></div>`;

  const box = $('#rpSku');
  let debounce;
  const jalankan = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => cariSku(box.value), 350);
  };
  box.oninput = jalankan;
  $('#rpFrom').onchange = () => cariSku(box.value);
  $('#rpTo').onchange = () => cariSku(box.value);

  if (RP.query && !RP.hasil) {
    cariSku(RP.query);
  } else if (RP.hasil) {
    paintHasilSku();
  } else {
    $('#rpHasil').innerHTML = `
      <div class="empty">
        ${icon('search', 'icon icon-lg')}
        <div class="empty__title">Ketik kode SKU untuk menelusuri</div>
        <div>Tidak perlu lengkap — potongan kode sudah cukup.</div>
      </div>`;
  }
  box.focus();
}

async function cariSku(q) {
  const query = String(q || '').trim();
  RP.query = query;

  if (!query) {
    RP.hasil = null;
    $('#rpHasil').innerHTML = `
      <div class="empty">
        ${icon('search', 'icon icon-lg')}
        <div class="empty__title">Ketik kode SKU untuk menelusuri</div>
        <div>Tidak perlu lengkap — potongan kode sudah cukup.</div>
      </div>`;
    return;
  }

  $('#rpHasil').innerHTML = `<div class="empty"><div class="muted">Mencari…</div></div>`;

  const p = new URLSearchParams({ sku: query });
  const from = $('#rpFrom')?.value;
  const to = $('#rpTo')?.value;
  if (from) p.set('from', from);
  if (to) p.set('to', to);

  try {
    RP.hasil = await api(`/api/replenish/search?${p}`);
    paintHasilSku();
  } catch (err) {
    $('#rpHasil').innerHTML = '';
    toast(err.message, 'error');
  }
}

function paintHasilSku() {
  const h = RP.hasil;
  if (!h) return;

  const kosong = !h.binLog.length && !h.docLines.length;
  if (kosong) {
    $('#rpHasil').innerHTML = `
      <div class="empty">
        <div class="empty__title">Tidak ada transaksi untuk "${esc(h.query)}"</div>
        <div>Coba potongan kode yang lebih pendek, atau longgarkan rentang tanggalnya.</div>
      </div>`;
    return;
  }

  // Bila kata kuncinya cocok ke beberapa SKU, tunjukkan supaya pengguna sadar
  // hasilnya gabungan dan bisa mempersempit.
  const daftarSku = h.skuTerkait.length > 1 ? `
    <div class="panel__head" style="padding-bottom:0">
      <p class="panel__hint" style="margin:0">
        Cocok dengan <b>${h.skuTerkait.length}</b> SKU:
        ${h.skuTerkait.slice(0, 12).map((s) =>
          `<button class="badge" style="cursor:pointer;margin:2px" data-rp-pick="${esc(s.sku)}">${esc(s.sku)} · ${fmt(s.jumlah)}</button>`,
        ).join(' ')}
      </p>
    </div>` : '';

  $('#rpHasil').innerHTML = `
    ${daftarSku}

    <div class="panel__head">
      <h2 class="panel__title">Masuk ke Rak</h2>
      <p class="panel__hint">${fmt(h.binLog.length)} pergerakan · dari log bin OCS</p>
    </div>
    ${h.binLog.length ? `
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>Waktu</th><th>SKU</th><th>Bin</th><th>Jenis</th>
            <th class="num">Qty</th><th>Oleh</th>
          </tr>
        </thead>
        <tbody>
          ${h.binLog.map((r) => `
            <tr>
              <td class="nowrap">${fmtWaktu(r.created_at)}</td>
              <td><span class="obj-id__title">${esc(r.seller_sku)}</span></td>
              <td><span class="badge">${esc(r.bin_code || '—')}</span></td>
              <td><span class="badge badge--ready">${esc(r.move_type || '—')}</span></td>
              <td class="num"><b>${fmt(r.qty)}</b></td>
              <td class="muted">${esc(r.created_by || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty"><div class="muted">Tidak ada catatan masuk rak untuk SKU ini.</div></div>`}

    <div class="panel__head" style="margin-top:.5rem">
      <h2 class="panel__title">Dokumen Transfer</h2>
      <p class="panel__hint">${fmt(h.docLines.length)} baris · dokumen Inventory Transfer ke SAP</p>
    </div>
    ${h.docLines.length ? `
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>Tanggal</th><th>No. Dokumen</th><th>Status</th><th>Gudang</th>
            <th>SKU</th><th>Kode SAP</th><th class="num">Jumlah</th><th>Oleh</th><th class="num"></th>
          </tr>
        </thead>
        <tbody>
          ${h.docLines.map((r) => `
            <tr class="${r.status === 'Failed' ? 'row--minus' : ''}">
              <td class="nowrap">${fmtWaktu(r.created_at)}</td>
              <td><span class="mono">${esc(r.doc_num || '—')}</span></td>
              <td>${statusBadge(r.status)}</td>
              <td class="nowrap muted">${esc(r.from_whs || '?')} → ${esc(r.to_whs || '?')}</td>
              <td><span class="obj-id__title">${esc(r.seller_sku)}</span></td>
              <td class="muted mono">${esc(r.kode_barang || '—')}</td>
              <td class="num"><b>${fmt(r.jumlah)}</b></td>
              <td class="muted">${esc(r.created_by || '—')}</td>
              <td class="num">
                <button class="btn btn--sm btn--transparent" data-rp-doc="${esc(r.head_id)}"
                        title="Lihat seluruh isi dokumen">${icon('doc')}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty"><div class="muted">Tidak ada dokumen transfer yang memuat SKU ini.</div></div>`}`;

  pasangAksiHasil();
}

function pasangAksiHasil() {
  $$('[data-rp-pick]').forEach((b) => {
    b.onclick = () => {
      const box = $('#rpSku');
      box.value = b.dataset.rpPick;
      cariSku(box.value);
    };
  });
  $$('[data-rp-doc]').forEach((b) => {
    b.onclick = () => bukaDokumen(b.dataset.rpDoc);
  });
}

// ---------------------------- Tampilan: telusuri dokumen ----------------------------

function paintDaftarDokumen() {
  const opsi = ['ALL', 'Success', 'Failed', 'Pending']
    .map((v) => `<option value="${v}" ${RP.statusFilter === v ? 'selected' : ''}>${
      v === 'ALL' ? 'Semua status' : v === 'Success' ? 'Berhasil' : v === 'Failed' ? 'Gagal' : 'Tertunda'
    }</option>`).join('');

  $('#rpBody').innerHTML = `
    <div class="toolbar" style="background:transparent;box-shadow:none">
      <div class="field" style="flex:1 1 20rem">
        <label class="field__label" for="rpCari">Cari dokumen</label>
        <input class="input" id="rpCari" type="search" placeholder="Nomor dokumen, remark, atau nama pengguna">
      </div>
      <div class="field">
        <label class="field__label" for="rpStatus">Status</label>
        <select class="select" id="rpStatus">${opsi}</select>
      </div>
    </div>
    <div id="rpDokumen"><div class="empty"><div class="muted">Memuat…</div></div></div>`;

  let debounce;
  $('#rpCari').oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(muatDokumen, 350);
  };
  $('#rpStatus').onchange = (e) => {
    RP.statusFilter = e.target.value;
    muatDokumen();
  };
}

async function muatDokumen() {
  const host = $('#rpDokumen');
  if (!host) return;

  const p = new URLSearchParams({ limit: '150' });
  if (RP.statusFilter && RP.statusFilter !== 'ALL') p.set('status', RP.statusFilter);
  const cari = $('#rpCari')?.value?.trim();
  if (cari) p.set('search', cari);

  try {
    RP.dokumen = await api(`/api/replenish/docs?${p}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  if (!RP.dokumen.length) {
    host.innerHTML = `<div class="empty"><div class="empty__title">Tidak ada dokumen yang cocok</div></div>`;
    return;
  }

  host.innerHTML = `
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>Dibuat</th><th>No. Dokumen</th><th>Status</th><th>Gudang</th>
            <th class="num">Baris</th><th>Remark</th><th>Oleh</th><th>Diposting</th><th class="num"></th>
          </tr>
        </thead>
        <tbody>
          ${RP.dokumen.map((d) => `
            <tr class="${d.status === 'Failed' ? 'row--minus' : ''}">
              <td class="nowrap">${fmtWaktu(d.created_at)}</td>
              <td><span class="mono">${esc(d.doc_num || '—')}</span></td>
              <td>${statusBadge(d.status)}</td>
              <td class="nowrap muted">${esc(d.from_whs || '?')} → ${esc(d.to_whs || '?')}</td>
              <td class="num">${d.detail_synced_at ? fmt(d.line_count || 0) : '<span class="muted" title="Detail belum ditarik">…</span>'}</td>
              <td class="muted">${esc((d.remark || '—').slice(0, 40))}</td>
              <td class="muted">${esc(d.created_by || '—')}</td>
              <td class="nowrap muted">${d.posted_at ? fmtWaktu(d.posted_at) : '—'}</td>
              <td class="num">
                <button class="btn btn--sm btn--transparent" data-rp-doc="${esc(d.id)}">${icon('doc')}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  $$('[data-rp-doc]', host).forEach((b) => {
    b.onclick = () => bukaDokumen(b.dataset.rpDoc);
  });
}

// ---------------------------- Dialog detail dokumen ----------------------------

async function bukaDokumen(id) {
  const host = $('#dialogHost');
  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog"><div class="dialog__body"><p class="muted">Memuat dokumen…</p></div></div>
    </div>`;

  let d;
  try {
    d = await api(`/api/replenish/doc/${encodeURIComponent(id)}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  const galat = d.error_message ? `
    <div class="strip strip--error" style="margin:0 0 1rem">
      ${icon('error')}
      <span><b>Pesan galat dari SAP:</b><br>${esc(d.error_message)}</span>
    </div>` : '';

  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" style="width:min(52rem,100%)">
        <div class="dialog__head">
          <h2 class="dialog__title">Dokumen ${esc(d.doc_num || '(tanpa nomor)')}</h2>
          ${statusBadge(d.status)}
          <button class="btn btn--sm btn--transparent" style="margin-left:auto" id="rpTutup">${icon('close')}</button>
        </div>
        <div class="dialog__body">
          ${galat}
          <div class="grid-2" style="gap:.5rem 1.5rem;margin-bottom:1rem">
            ${[
              ['Gudang asal', d.from_whs],
              ['Gudang tujuan', d.to_whs],
              ['Tanggal dokumen', d.tgl_dok],
              ['Tanggal posting', d.tgl_post],
              ['Dibuat oleh', d.created_by],
              ['Dibuat pada', fmtWaktu(d.created_at)],
              ['Diposting pada', d.posted_at ? fmtWaktu(d.posted_at) : '—'],
              ['Remark', d.remark],
            ].map(([k, v]) => `
              <div class="setting-row" style="padding:.35rem 0;border:none">
                <div class="setting-row__main">
                  <div class="setting-row__desc" style="margin:0">${esc(k)}</div>
                  <div class="setting-row__title">${esc(v || '—')}</div>
                </div>
              </div>`).join('')}
          </div>

          <h3 class="panel__title" style="margin:0 0 .5rem">Baris Detail (${fmt(d.lines.length)})</h3>
          ${d.lines.length ? `
          <div class="table-wrap">
            <table class="ftable">
              <thead><tr><th class="num">#</th><th>SKU</th><th>Kode SAP</th><th class="num">Jumlah</th><th>Satuan</th></tr></thead>
              <tbody>
                ${d.lines.map((l) => `
                  <tr>
                    <td class="num muted">${l.row_id ?? '—'}</td>
                    <td><span class="obj-id__title">${esc(l.seller_sku || '—')}</span></td>
                    <td class="muted mono">${esc(l.kode_barang || '—')}</td>
                    <td class="num"><b>${fmt(l.jumlah)}</b></td>
                    <td class="muted">${esc(l.satuan || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `
          <div class="empty" style="padding:1.5rem">
            <div class="muted">${d.detail_synced_at
              ? 'Dokumen ini memang tidak punya baris detail.'
              : 'Baris detail belum ditarik dari OCS.'}</div>
          </div>`}
        </div>
        <div class="dialog__foot">
          <button class="btn" id="rpTutup2">Tutup</button>
        </div>
      </div>
    </div>`;

  const tutup = () => { host.innerHTML = ''; };
  $('#rpTutup').onclick = tutup;
  $('#rpTutup2').onclick = tutup;
  host.querySelector('.dialog-backdrop').onclick = (e) => {
    if (e.target === e.currentTarget) tutup();
  };
}
