/* =========================================================================
   ATP Monitoring — submenu Master Data, Cabang, dan Riwayat.
   Dipisah dari atp-tab.js semata-mata agar tiap berkas tetap enak dibaca.
   ========================================================================= */

/* ---------------------------- Master Data ---------------------------- */

/**
 * Ringkasan jumlah ceklis per cabang.
 *
 * Angkanya mengikuti penyaring yang sedang aktif, dan dihitung server dari
 * seluruh hasil filter — bukan dari 300 baris yang kebetulan tampil.
 * Kartunya bisa diklik untuk menyaring ke cabang itu saja.
 */
function ringkasanCabang(m) {
  const r = m.ringkasan || [];
  if (!r.length) return '';

  const f = ATP.filterMaster;
  const dipilih = f.branch;

  /*
   * Kartu ini mengikuti penyaring, sedangkan dashboard dan Riwayat selalu
   * menghitung seluruh katalog. Tanpa keterangan lingkup, ATP Makassar bisa
   * terbaca 75,6% di sini dan 71,7% di Riwayat tanpa petunjuk apa pun bahwa
   * yang satu sedang disaring ke SKU tunggal saja. Jadi lingkupnya disebutkan.
   */
  const lingkup = [];
  if (f.search) lingkup.push(`pencarian "${esc(f.search)}"`);
  if (f.shop !== 'ALL') lingkup.push(`brand ${esc(f.shop)}`);
  if (f.category !== 'ALL') lingkup.push(f.category === 'Bundle' ? 'bundle saja' : 'SKU tunggal saja');
  /*
   * Cabang saja tidak mempersempit apa pun — tiap SKU punya baris di semua
   * cabang. Yang mempersempit adalah statusnya.
   */
  if (f.status !== 'ALL') {
    const L = { AKTIF: 'aktif', SIAP: 'siap', KOSONG: 'kosong' };
    lingkup.push(`SKU yang ${L[f.status] || f.status} di ${esc(f.branch)}`);
  }

  const keterangan = lingkup.length
    ? `<span class="badge badge--override">Disaring</span>
       Ringkasan hanya mencakup ${lingkup.join(' · ')}, jadi angkanya <b>tidak sama</b>
       dengan dashboard dan Riwayat yang selalu menghitung seluruh katalog.`
    : `Seluruh katalog — angka ini sama persis dengan dashboard dan Riwayat.`;

  return `
    <p class="panel__hint" style="margin:0 0 .6rem">${keterangan}</p>
    <div class="tiles" style="margin:0 0 1rem">
      ${r.map((c) => {
        // Persentase yang ditampilkan adalah ATP itu sendiri: siap dibagi yang
        // diceklis. Sempat memakai ceklis dibagi seluruh katalog, dan angkanya
        // bentrok dengan dashboard karena mengukur hal yang sama sekali lain.
        const atp = c.aktif ? (c.siap / c.aktif) * 100 : 0;
        const n = nadaAtp(atp);
        return `
        <button class="tile tile--neutral ${dipilih === c.branch ? 'is-active' : ''}"
                data-atp-cabang="${esc(c.branch)}"
                title="${esc(c.name)} — ${fmt(c.aktif)} SKU diceklis aktif, ${fmt(c.siap)} di antaranya stoknya di atas ambang. Klik untuk menyaring.">
          <span class="tile__label">${esc(c.name)}</span>
          <span class="tile__value">${fmt(c.aktif)}</span>
          <span class="tile__foot">
            SKU diceklis${c.ditimpa ? ` · ${fmt(c.ditimpa)} ditimpa manual` : ''}
            <br>
            <b class="teks-${n}">ATP ${atp.toFixed(1)}%</b> — ${fmt(c.siap)} siap
            <span class="meter" style="max-width:4rem;margin-left:.35rem">
              <span class="meter__fill is-${n}" style="width:${Math.max(1, atp).toFixed(1)}%"></span>
            </span>
          </span>
        </button>`;
      }).join('')}
    </div>`;
}

/**
 * Rumpun cabang, diurutkan mengikuti urutan cabangnya.
 *
 * Dibaca dari data, bukan ditulis mati di sini: cabang baru yang ditambahkan
 * lewat halaman Cabang langsung ikut rumpunnya tanpa menyentuh kode ini.
 */
function daftarRumpun(cab) {
  const peta = new Map();
  for (const c of cab) {
    if (!c.group_code) continue;
    if (!peta.has(c.group_code)) peta.set(c.group_code, []);
    peta.get(c.group_code).push(c);
  }
  return [...peta.entries()];
}

/**
 * Terjemahkan pilihan "Terapkan ke" jadi daftar kode cabang.
 *
 * Cabang sumber selalu dikeluarkan, termasuk ketika ia kebetulan anggota
 * rumpun yang dipilih — menyalin sebuah cabang ke dirinya sendiri tidak ada
 * artinya, dan menolak seluruh aksi hanya karena itu malah menyusahkan.
 */
function tujuanMassal(pilihan, cab, asal) {
  let daftar;
  if (pilihan.startsWith('grup:')) {
    const kode = pilihan.slice(5);
    daftar = cab.filter((c) => c.group_code === kode);
  } else if (pilihan === 'SELAIN') {
    daftar = cab;
  } else {
    daftar = cab.filter((c) => c.code === pilihan);
  }
  return daftar.map((c) => c.code).filter((k) => k !== asal);
}

/**
 * Aksi massal untuk ceklis.
 *
 * Lingkupnya mengikuti pencarian, brand, dan jenis yang sedang aktif — sama
 * persis dengan yang tampil di tabel. Penyaring cabang dan status tidak ikut,
 * karena keduanya memilih baris berdasarkan keadaan yang justru sedang diubah.
 */
function barAksiMassal(m) {
  const cab = m.cabang || [];
  if (cab.length < 2) return '';

  const asal = ATP.massalSumber || (cab.some((c) => c.code === 'Pusat') ? 'Pusat' : cab[0].code);
  const tujuan = ATP.massalTujuan || 'grup:OXAR';
  const lain = cab.filter((c) => c.code !== asal);
  const grup = daftarRumpun(cab);

  return `
    <div class="toolbar" style="margin-bottom:1rem">
      <div class="field">
        <label class="field__label" for="bSumber">Sumber</label>
        <select class="select" id="bSumber">
          ${cab.map((c) => `<option value="${esc(c.code)}" ${asal === c.code ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="bTujuan">Terapkan ke</label>
        <select class="select" id="bTujuan">
          ${grup.map(([kode, anggota]) => {
            const pakai = anggota.filter((c) => c.code !== asal);
            if (!pakai.length) return '';
            const nilai = `grup:${kode}`;
            return `<option value="${esc(nilai)}" ${tujuan === nilai ? 'selected' : ''}>
              Rumpun ${esc(kode)} — ${pakai.map((c) => esc(c.name)).join(', ')}
            </option>`;
          }).join('')}
          <option value="SELAIN" ${tujuan === 'SELAIN' ? 'selected' : ''}>Semua cabang selain ${esc(asal)} (${lain.length})</option>
          ${lain.map((c) => `<option value="${esc(c.code)}" ${tujuan === c.code ? 'selected' : ''}>${esc(c.name)} saja</option>`).join('')}
        </select>
      </div>
      <div class="toolbar__spacer"></div>
      <button class="btn btn--emphasized" data-massal="salin">Samakan dengan ${esc(asal)}</button>
      <button class="btn" data-massal="ocs">Ikut Aktif OCS</button>
      <button class="btn" data-massal="aktif">Ceklis Semua</button>
      <button class="btn btn--negative" data-massal="nonaktif">Hapus Semua Ceklis</button>
    </div>`;
}

/** Dialog penegasan sebelum mengubah ribuan baris sekaligus. */
function konfirmMassal({ judul, rincian, lanjut }) {
  const host = $('#dialogHost');
  const tutup = () => { host.innerHTML = ''; };
  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog" style="max-width:34rem">
        <div class="dialog__head"><h3 class="dialog__title">${judul}</h3></div>
        <div class="dialog__body">${rincian}</div>
        <div class="dialog__foot">
          <button class="btn" id="kBatal">Batal</button>
          <button class="btn btn--emphasized" id="kLanjut">Terapkan</button>
        </div>
      </div>
    </div>`;
  $('#kBatal').onclick = tutup;
  host.querySelector('.dialog-backdrop').onclick = (e) => { if (e.target === e.currentTarget) tutup(); };
  $('#kLanjut').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await lanjut(); tutup(); } catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
  };
}

async function paintMaster() {
  const host = $('#atpBody');
  host.innerHTML = `<div class="panel__body"><p class="muted">Memuat…</p></div>`;

  const f = ATP.filterMaster;
  const p = new URLSearchParams({ limit: '300' });
  for (const [k, v] of Object.entries(f)) if (v && v !== 'ALL') p.set(k, v);

  try {
    ATP.master = await api(`/api/atp/master?${p}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  const m = ATP.master;
  const cab = m.cabang || [];
  const brands = ATP.data?.brands || [];

  const opsi = (list, dipilih, semua) =>
    [`<option value="ALL">${semua}</option>`]
      .concat(list.map((x) => `<option value="${esc(x)}" ${dipilih === x ? 'selected' : ''}>${esc(x)}</option>`))
      .join('');

  host.innerHTML = `
    <div class="toolbar" style="background:transparent;box-shadow:none">
      <div class="field" style="flex:1 1 18rem">
        <label class="field__label" for="mSearch">Cari</label>
        <input class="input" id="mSearch" type="search" placeholder="Kode SKU, nama, atau kode SAP" value="${esc(f.search)}">
      </div>
      <div class="field">
        <label class="field__label" for="mShop">Brand</label>
        <select class="select" id="mShop">${opsi(brands, f.shop, 'Semua brand')}</select>
      </div>
      <div class="field">
        <label class="field__label" for="mCat">Jenis</label>
        <select class="select" id="mCat">
          <option value="ALL">Semua</option>
          <option value="Sku" ${f.category === 'Sku' ? 'selected' : ''}>SKU tunggal</option>
          <option value="Bundle" ${f.category === 'Bundle' ? 'selected' : ''}>Bundle</option>
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="mBranch">Cabang</label>
        <select class="select" id="mBranch">${opsi(cab.map((c) => c.code), f.branch, 'Semua cabang')}</select>
      </div>
      <div class="field">
        <label class="field__label" for="mStatus">Status di cabang itu</label>
        <select class="select" id="mStatus" ${f.branch === 'ALL' ? 'disabled' : ''}>
          <option value="ALL">Semua</option>
          <option value="AKTIF" ${f.status === 'AKTIF' ? 'selected' : ''}>Aktif</option>
          <option value="SIAP" ${f.status === 'SIAP' ? 'selected' : ''}>Siap (di atas ambang)</option>
          <option value="KOSONG" ${f.status === 'KOSONG' ? 'selected' : ''}>Kosong (di bawah ambang)</option>
        </select>
      </div>
      <div class="toolbar__spacer"></div>
      <button class="btn" id="mReset">Bersihkan</button>
    </div>

    ${ringkasanCabang(m)}
    ${barAksiMassal(m)}

    <div class="panel__head" style="padding-top:0">
      <p class="panel__hint" style="margin:0">
        ${m.dibatasi
          ? `Menampilkan ${fmt(m.items.length)} dari <b>${fmt(m.total)}</b> SKU. Persempit pencarian untuk melihat sisanya.`
          : `${fmt(m.total)} SKU`}
        · angka yang ditampilkan: <b>${esc(m.config.stockFieldLabel)}</b>, ambang &gt; ${fmt(m.config.threshold)} pcs
        · ceklis menandai SKU aktif di cabang itu, dan hanya yang terceklis yang dihitung ATP
      </p>
    </div>

    ${m.items.length ? `
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>SKU</th><th>Brand</th><th>Jenis</th>
            ${cab.map((c) => `<th class="num">${esc(c.name)}</th>`).join('')}
            <th class="num"></th>
          </tr>
        </thead>
        <tbody>
          ${m.items.map((it) => `
            <tr>
              <td>
                <div class="obj-id">
                  <span class="obj-id__title">${esc(it.sku)}</span>
                  <span class="obj-id__text" title="${esc(it.name)}">${esc(it.name || '')}</span>
                </div>
              </td>
              <td>${it.shop ? `<span class="badge">${esc(it.shop)}</span>` : '<span class="muted">—</span>'}</td>
              <td>${it.isBundle ? '<span class="badge badge--override">Bundle</span>' : '<span class="badge">Tunggal</span>'}</td>
              ${cab.map((c) => selCabang(it, c.code, m.config)).join('')}
              <td class="num">
                ${it.isBundle ? `<button class="btn btn--sm btn--transparent" data-atp-bundle="${esc(it.sku)}" title="Lihat komponen">${icon('doc')}</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty"><div class="empty__title">Tidak ada SKU yang cocok</div></div>`}`;

  let debounce;
  $('#mSearch').oninput = (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { ATP.filterMaster.search = e.target.value.trim(); paintMaster(); }, 350);
  };
  for (const [id, key] of [['mShop', 'shop'], ['mCat', 'category'], ['mBranch', 'branch'], ['mStatus', 'status']]) {
    $(`#${id}`).onchange = (e) => {
      ATP.filterMaster[key] = e.target.value;
      // Status hanya bermakna bila satu cabang dipilih.
      if (key === 'branch' && e.target.value === 'ALL') ATP.filterMaster.status = 'ALL';
      paintMaster();
    };
  }
  $$('[data-atp-cabang]').forEach((el) => {
    el.onclick = () => {
      const kode = el.dataset.atpCabang;
      // Mengklik cabang yang sedang dipilih berarti melepas penyaringnya.
      const lepas = ATP.filterMaster.branch === kode;
      ATP.filterMaster.branch = lepas ? 'ALL' : kode;
      if (lepas) ATP.filterMaster.status = 'ALL';
      paintMaster();
    };
  });

  const bS = $('#bSumber');
  const bT = $('#bTujuan');
  if (bS) bS.onchange = (e) => { ATP.massalSumber = e.target.value; ATP.massalTujuan = 'grup:OXAR'; paintMaster(); };
  if (bT) bT.onchange = (e) => { ATP.massalTujuan = e.target.value; };

  $$('[data-massal]').forEach((el) => {
    el.onclick = () => {
      const aksi = el.dataset.massal;
      const f = ATP.filterMaster;
      const cab = m.cabang || [];
      const asal = ATP.massalSumber || (cab.some((c) => c.code === 'Pusat') ? 'Pusat' : cab[0].code);
      const pilihTujuan = ATP.massalTujuan || 'grup:OXAR';
      const targets = tujuanMassal(pilihTujuan, cab, asal);
      if (!targets.length) return toast('Tidak ada cabang tujuan selain cabang sumber.', 'error');

      const lingkup = [];
      if (f.search) lingkup.push(`pencarian "${esc(f.search)}"`);
      if (f.shop !== 'ALL') lingkup.push(`brand ${esc(f.shop)}`);
      if (f.category !== 'ALL') lingkup.push(f.category === 'Bundle' ? 'bundle saja' : 'SKU tunggal saja');

      const teks = {
        salin: {
          judul: `Samakan dengan ${esc(asal)}`,
          apa: `Ceklis di ${targets.length} cabang tujuan akan disalin dari keadaan yang berlaku di <b>${esc(asal)}</b>.`,
          catatan: 'Hasilnya potret, bukan tautan. Kalau nanti ' + esc(asal) + ' berubah, cabang tujuan tidak ikut sampai tombol ini ditekan lagi.',
        },
        ocs: {
          judul: 'Kembalikan ke Aktif OCS',
          apa: 'Ceklis manual akan dihapus, sehingga barisnya kembali mengikuti OCS.',
          catatan: 'Setelah ini nilainya berubah sendiri setiap penarikan, mengikuti OCS.',
        },
        aktif: {
          judul: 'Ceklis semua',
          apa: 'Semua baris dalam lingkup akan ditandai <b>aktif</b> secara manual.',
          catatan: 'Ceklis manual mengalahkan OCS dan tidak berubah walau OCS berubah.',
        },
        nonaktif: {
          judul: 'Hapus semua ceklis',
          apa: 'Semua baris dalam lingkup akan ditandai <b>non-aktif</b> secara manual, sehingga tidak lagi dihitung ATP.',
          catatan: 'Ceklis manual mengalahkan OCS dan tidak berubah walau OCS berubah.',
        },
      }[aksi];

      konfirmMassal({
        judul: teks.judul,
        rincian: `
          <p>${teks.apa}</p>
          <p class="muted" style="font-size:.8rem">${teks.catatan}</p>
          <table class="ftable" style="margin-top:.75rem">
            <tbody>
              <tr><td>Cabang tujuan</td><td><b>${targets.map(esc).join(', ')}</b></td></tr>
              <tr><td>Lingkup SKU</td><td><b>${lingkup.length ? lingkup.join(' · ') : 'seluruh katalog'}</b></td></tr>
              <tr><td>Perkiraan baris</td><td><b>${fmt(m.total * targets.length)}</b></td></tr>
            </tbody>
          </table>`,
        lanjut: async () => {
          const body = {
            mode: aksi === 'salin' ? 'salin' : aksi === 'ocs' ? 'ocs' : 'set',
            targets,
            source: aksi === 'salin' ? asal : null,
            aktif: aksi === 'aktif',
            search: f.search || null,
            shop: f.shop,
            category: f.category,
          };
          const r = await api('/api/atp/override/bulk', { method: 'POST', body: JSON.stringify(body) });
          toast(`${fmt(r.diubah)} baris diperbarui.`, 'success');
          ATP.data = null;           // dashboard wajib dihitung ulang
          await paintMaster();
        },
      });
    };
  });

  $('#mReset').onclick = () => {
    ATP.filterMaster = { search: '', shop: 'ALL', category: 'ALL', branch: 'ALL', status: 'ALL' };
    paintMaster();
  };

  $$('[data-atp-ceklis]').forEach((el) => {
    el.onchange = async () => {
      const sku = el.dataset.atpCeklis;
      const branch = el.dataset.atpBranch;
      try {
        await api('/api/atp/override', {
          method: 'PUT',
          body: JSON.stringify({ sku, branch, override: el.checked }),
        });
        toast(`${sku} di ${branch} ditandai ${el.checked ? 'aktif' : 'non-aktif'} secara manual.`, 'success');
        paintMaster();
      } catch (err) {
        el.checked = !el.checked;
        toast(err.message, 'error');
      }
    };
  });

  $$('[data-atp-reset-override]').forEach((b) => {
    b.onclick = async () => {
      const sku = b.dataset.atpResetOverride;
      const branch = b.dataset.atpBranch;
      await api('/api/atp/override', { method: 'PUT', body: JSON.stringify({ sku, branch, override: null }) });
      toast(`${sku} di ${branch} kembali mengikuti OCS.`, 'success');
      paintMaster();
    };
  });

  $$('[data-atp-bundle]').forEach((b) => {
    b.onclick = () => bukaBundle(b.dataset.atpBundle);
  });
}

/** Satu sel cabang: ceklis aktif + angka stok, diberi warna sesuai keadaannya. */
function selCabang(it, kode, cfg) {
  const b = it.branches[kode];
  if (!b) return `<td class="cabang-sel muted">—</td>`;

  const qty = cfg.stockField === 'available_qty' ? b.availableQty
    : cfg.stockField === 'qty_rack' ? b.qtyRack : b.qtyOnHand;

  const kelas = !b.aktif ? 'cabang-sel--nonaktif' : (b.siap ? 'cabang-sel--siap' : 'cabang-sel--kosong');
  const judul = `${it.sku} di ${kode} — ${qty} pcs\n` +
    `OCS: ${b.aktifOcs ? 'aktif' : 'non-aktif'}` +
    (b.override === null ? '' : `\nDitimpa manual: ${b.override ? 'aktif' : 'non-aktif'}`);

  return `
    <td class="cabang-sel ${kelas}" title="${esc(judul)}">
      <input type="checkbox" class="ceklis ${b.override === null ? '' : 'ditimpa'}"
             ${b.aktif ? 'checked' : ''}
             data-atp-ceklis="${esc(it.sku)}" data-atp-branch="${esc(kode)}">
      <div class="cabang-sel__qty">${fmt(qty)}</div>
      ${b.override === null ? '' : `<button class="btn btn--sm btn--transparent" style="padding:0 .2rem;font-size:.6rem"
          data-atp-reset-override="${esc(it.sku)}" data-atp-branch="${esc(kode)}"
          title="Kembalikan ke status dari OCS">ikuti OCS</button>`}
    </td>`;
}

async function bukaBundle(sku) {
  const host = $('#dialogHost');
  host.innerHTML = `<div class="dialog-backdrop"><div class="dialog"><div class="dialog__body"><p class="muted">Memuat…</p></div></div></div>`;

  let d;
  try {
    d = await api(`/api/atp/bundle/${encodeURIComponent(sku)}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  const cab = ATP.master?.cabang || [];
  const cfg = d.config || {};
  const ambil = (b) => !b ? null
    : (cfg.stockField === 'available_qty' ? b.availableQty : cfg.stockField === 'qty_rack' ? b.qtyRack : b.qtyOnHand);

  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" style="width:min(56rem,100%)">
        <div class="dialog__head">
          <h2 class="dialog__title">Komponen ${esc(sku)}</h2>
          <button class="btn btn--sm btn--transparent" style="margin-left:auto" id="bTutup">${icon('close')}</button>
        </div>
        <div class="dialog__body">
          <p class="panel__hint" style="margin:0 0 1rem">
            ${fmt(d.items.length)} komponen, angka mengikuti pengaturan yang berlaku
            (<b>${esc(cfg.stockFieldLabel || '')}</b>). ATP sendiri memakai stok bundle ini,
            bukan komponennya — daftar ini untuk menelusuri bila bundle terlihat kosong.
          </p>
          ${d.items.length ? `
          <div class="table-wrap">
            <table class="ftable">
              <thead><tr><th>Komponen</th><th class="num">Qty/bundle</th>${cab.map((c) => `<th class="num">${esc(c.name)}</th>`).join('')}</tr></thead>
              <tbody>
                ${d.items.map((i) => `
                  <tr>
                    <td>
                      <div class="obj-id">
                        <span class="obj-id__title">${esc(i.sku)}</span>
                        <span class="obj-id__text">${esc(i.name || '')}</span>
                      </div>
                    </td>
                    <td class="num"><b>${fmt(i.qty)}</b></td>
                    ${cab.map((c) => {
                      const q = ambil(i.branches[c.code]);
                      if (q === null) return '<td class="num muted">—</td>';
                      const cukup = q >= i.qty;
                      return `<td class="num"><span class="${cukup ? 'teks-good' : 'teks-critical'}" style="font-weight:700">${fmt(q)}</span></td>`;
                    }).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `<div class="empty"><div class="muted">Bundle ini tidak punya definisi komponen.</div></div>`}
        </div>
        <div class="dialog__foot"><button class="btn" id="bTutup2">Tutup</button></div>
      </div>
    </div>`;

  const tutup = () => { host.innerHTML = ''; };
  $('#bTutup').onclick = tutup;
  $('#bTutup2').onclick = tutup;
  host.querySelector('.dialog-backdrop').onclick = (e) => { if (e.target === e.currentTarget) tutup(); };
}

/* ---------------------------- Cabang ---------------------------- */

async function paintCabang() {
  const host = $('#atpBody');
  host.innerHTML = `<div class="panel__body"><p class="muted">Memuat…</p></div>`;
  try {
    ATP.cabang = await api('/api/atp/branches');
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  host.innerHTML = `
    <div class="panel__body">
      <p class="panel__hint" style="margin:0 0 1rem">
        Cabang bertanda <b>OCS</b> datanya tertarik otomatis. Cabang yang didaftarkan manual
        tercatat di sini tetapi <b>stoknya belum terisi</b> sampai ada sumber datanya di OCS —
        ia akan tampil kosong, bukan nol yang keliru.
      </p>
      <p class="panel__hint" style="margin:0 0 1rem">
        <b>Rumpun</b> mengelompokkan cabang supaya tombol ceklis massal di Master Data bisa
        menyasar semuanya sekali klik. Bawaannya <b>IEG</b> untuk Pusat dan <b>OXAR</b> untuk
        keempat cabang lain; isi rumpun yang sama pada cabang baru agar ikut terpilih.
      </p>

      <div class="table-wrap">
        <table class="ftable">
          <thead><tr><th>Kode</th><th>Nama</th><th>Sumber</th><th>Rumpun</th><th>Ditampilkan</th><th>Catatan</th><th class="num"></th></tr></thead>
          <tbody>
            ${ATP.cabang.map((c) => `
              <tr>
                <td><span class="mono obj-id__title">${esc(c.code)}</span></td>
                <td>${esc(c.name)}</td>
                <td>${c.ocs_area
                  ? `<span class="badge badge--ready">OCS · ${esc(c.ocs_area)}</span>`
                  : '<span class="badge">Manual</span>'}</td>
                <td>
                  <input class="input" style="width:7rem;text-transform:uppercase"
                         value="${esc(c.group_code || '')}" placeholder="—"
                         data-cab-grup="${esc(c.code)}"
                         title="Rumpun dipakai tombol ceklis massal untuk menyasar beberapa cabang sekaligus. Kosongkan bila cabang ini berdiri sendiri.">
                </td>
                <td>
                  <label class="switch">
                    <input type="checkbox" ${c.is_active ? 'checked' : ''} data-cab-aktif="${esc(c.code)}">
                    <span class="switch__track"></span>
                  </label>
                </td>
                <td class="muted">${esc(c.note || '—')}</td>
                <td class="num">
                  ${c.ocs_area ? '' : `<button class="btn btn--sm btn--transparent btn--negative" data-cab-hapus="${esc(c.code)}">${icon('close')}</button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <h3 class="panel__title" style="margin:1.5rem 0 .75rem">Tambah Cabang</h3>
      <div class="toolbar" style="background:transparent;box-shadow:none;padding-left:0">
        <div class="field">
          <label class="field__label" for="cKode">Kode</label>
          <input class="input" id="cKode" placeholder="misal BITUNG" style="width:10rem">
        </div>
        <div class="field" style="flex:1 1 14rem">
          <label class="field__label" for="cNama">Nama</label>
          <input class="input" id="cNama" placeholder="misal PT Inovasi Eka Gemilang - Bitung">
        </div>
        <div class="field">
          <label class="field__label" for="cGrup">Rumpun</label>
          <input class="input" id="cGrup" placeholder="misal OXAR" style="width:8rem;text-transform:uppercase">
        </div>
        <div class="field" style="flex:1 1 12rem">
          <label class="field__label" for="cNote">Catatan</label>
          <input class="input" id="cNote" placeholder="opsional">
        </div>
        <button class="btn btn--emphasized" id="cTambah">Tambah</button>
      </div>
    </div>`;

  $$('[data-cab-aktif]').forEach((el) => {
    el.onchange = async () => {
      const kode = el.dataset.cabAktif;
      await api('/api/atp/branches', { method: 'PUT', body: JSON.stringify({ code: kode, active: el.checked }) });
      toast(`Cabang ${kode} ${el.checked ? 'ditampilkan' : 'disembunyikan'}.`, 'success');
      ATP.data = await api(`/api/atp/dashboard?shop=${encodeURIComponent(ATP.brandFilter)}`);
    };
  });

  /*
   * Rumpun disimpan saat kolom ditinggalkan, bukan pada tiap ketikan — nilai
   * setengah jadi seperti "OX" tidak perlu ikut tersimpan.
   */
  $$('[data-cab-grup]').forEach((el) => {
    const semula = el.value;
    el.onchange = async () => {
      const kode = el.dataset.cabGrup;
      const baru = el.value.trim().toUpperCase();
      if (baru === semula.trim().toUpperCase()) return;
      try {
        await api('/api/atp/branches', {
          method: 'PUT',
          body: JSON.stringify({ code: kode, groupCode: baru || null }),
        });
        toast(baru ? `Cabang ${kode} masuk rumpun ${baru}.` : `Cabang ${kode} dikeluarkan dari rumpun.`, 'success');
        paintCabang();
      } catch (err) {
        el.value = semula;
        toast(err.message, 'error');
      }
    };
  });

  $$('[data-cab-hapus]').forEach((b) => {
    b.onclick = async () => {
      const kode = b.dataset.cabHapus;
      if (!confirm(`Hapus cabang ${kode}?`)) return;
      try {
        await api(`/api/atp/branches?code=${encodeURIComponent(kode)}`, { method: 'DELETE' });
        toast(`Cabang ${kode} dihapus.`, 'success');
        paintCabang();
      } catch (err) { toast(err.message, 'error'); }
    };
  });

  $('#cTambah').onclick = async () => {
    const code = $('#cKode').value.trim();
    const name = $('#cNama').value.trim();
    if (!code) return toast('Kode cabang wajib diisi.', 'error');
    try {
      await api('/api/atp/branches', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name: name || code,
          groupCode: $('#cGrup').value.trim() || null,
          note: $('#cNote').value.trim() || null,
        }),
      });
      toast(`Cabang ${code} ditambahkan.`, 'success');
      paintCabang();
    } catch (err) { toast(err.message, 'error'); }
  };
}

/* ---------------------------- Riwayat ---------------------------- */

async function paintRiwayat() {
  const host = $('#atpBody');
  host.innerHTML = `<div class="panel__body"><p class="muted">Memuat…</p></div>`;
  const jenis = ATP.jenisRiwayat || 'ALL';
  const qs = new URLSearchParams({ days: '60' });
  if (jenis !== 'ALL') qs.set('category', jenis);

  try {
    ATP.riwayat = await api(`/api/atp/history?${qs}`);
  } catch (err) {
    host.innerHTML = '';
    return toast(err.message, 'error');
  }

  const jam = ATP.data?.config?.snapshotHour ?? 7;

  // Kosong karena penyaring jenis adalah keadaan lain daripada belum pernah merekam.
  if (!ATP.riwayat.length && jenis !== 'ALL') {
    host.innerHTML = `
      <div class="empty">
        <div class="empty__title">Tidak ada rekaman untuk ${jenis === 'Bundle' ? 'bundle' : 'SKU tunggal'}</div>
        <div>Rekaman harian yang tersimpan tidak memuat jenis ini.</div>
        <button class="btn btn--emphasized" style="margin-top:1rem" id="rSemua">Tampilkan Tunggal + Bundle</button>
      </div>`;
    $('#rSemua').onclick = () => { ATP.jenisRiwayat = 'ALL'; paintRiwayat(); };
    return;
  }

  if (!ATP.riwayat.length) {
    host.innerHTML = `
      <div class="empty">
        <div class="empty__title">Belum ada rekaman harian</div>
        <div>Rekaman diambil otomatis tiap jam ${fmt(jam)}:00 WIB. Anda juga bisa mengambilnya sekarang.</div>
        <button class="btn btn--emphasized" style="margin-top:1rem" id="rAmbil">Ambil Rekaman Sekarang</button>
      </div>`;
    $('#rAmbil').onclick = async (e) => {
      e.currentTarget.disabled = true;
      await api('/api/atp/snapshot', { method: 'POST', body: JSON.stringify({}) });
      toast('Rekaman tersimpan.', 'success');
      paintRiwayat();
    };
    return;
  }

  const tanggal = [...new Set(ATP.riwayat.map((r) => r.tanggal))].sort().reverse();
  const cabang = [...new Set(ATP.riwayat.map((r) => r.branch))].sort();
  const peta = new Map(ATP.riwayat.map((r) => [`${r.tanggal}|${r.branch}`, r]));

  host.innerHTML = `
    <div class="panel__head">
      <h2 class="panel__title">Rekaman Harian</h2>
      <p class="panel__hint" style="margin:0">
        ${fmt(tanggal.length)} hari tersimpan · diambil tiap jam ${fmt(jam)}:00 WIB
        ${jenis === 'ALL' ? '' : `· hanya ${jenis === 'Bundle' ? 'bundle' : 'SKU tunggal'}`}
      </p>
      <div class="toolbar__spacer"></div>
      <div class="field">
        <label class="field__label" for="rJenis">Jenis</label>
        <select class="select" id="rJenis">
          <option value="ALL" ${jenis === 'ALL' ? 'selected' : ''}>Tunggal + bundle</option>
          <option value="Sku" ${jenis === 'Sku' ? 'selected' : ''}>SKU tunggal saja</option>
          <option value="Bundle" ${jenis === 'Bundle' ? 'selected' : ''}>Bundle saja</option>
        </select>
      </div>
      <button class="btn" id="rAmbil2">${icon('refresh')} Ambil Rekaman Hari Ini</button>
    </div>
    <div class="table-wrap">
      <table class="ftable">
        <thead><tr><th>Tanggal</th>${cabang.map((c) => `<th class="num">${esc(c)}</th>`).join('')}<th>Dasar</th></tr></thead>
        <tbody>
          ${tanggal.map((t) => {
            const any = cabang.map((c) => peta.get(`${t}|${c}`)).find(Boolean);
            return `
            <tr>
              <td class="mono nowrap">${esc(t)}</td>
              ${cabang.map((c) => {
                const r = peta.get(`${t}|${c}`);
                if (!r) return '<td class="num muted">—</td>';
                const n = nadaAtp(r.pct);
                return `<td class="num" title="${fmt(r.ready)} siap dari ${fmt(r.active)} SKU aktif">
                  <span class="teks-${n}" style="font-weight:700">${pct1(r.pct)}%</span></td>`;
              }).join('')}
              <td class="muted" style="font-size:.7rem">${any ? `&gt;${any.threshold} · ${esc(any.stockField)}` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  $('#rJenis').onchange = (e) => { ATP.jenisRiwayat = e.target.value; paintRiwayat(); };

  $('#rAmbil2').onclick = async (e) => {
    e.currentTarget.disabled = true;
    await api('/api/atp/snapshot', { method: 'POST', body: JSON.stringify({}) });
    toast('Rekaman hari ini diperbarui.', 'success');
    paintRiwayat();
  };
}
