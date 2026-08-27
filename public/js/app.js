/* =========================================================================
   OCS Replenish Monitor — front-end (vanilla JS, tanpa build step)
   ========================================================================= */

const state = {
  tab: 'monitoring',
  data: null,
  settings: null,
  // status 'DEFAULT' = ikuti pengaturan (mis. sembunyikan item aman);
  // 'ALL' = tampilkan seluruh lingkup apa adanya.
  filters: { status: 'DEFAULT', search: '', shop: 'ALL', sort: 'urgency' },
  thresholds: [],
  syncLog: [],
  loading: false,
  lastSyncStamp: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nf = new Intl.NumberFormat('id-ID');
const fmt = (n) => nf.format(Number(n) || 0);

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  const s = Math.round(diff / 1000);
  if (s < 10) return 'baru saja';
  if (s < 60) return `${s} detik lalu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} menit lalu`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

const icon = (name, cls = 'icon') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

// ---------------------------- API ----------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function dashboardQuery() {
  const p = new URLSearchParams();
  const { status, search, shop, sort } = state.filters;

  if (status === 'ALL') {
    // Kartu "Total Dipantau" harus benar-benar menampilkan seluruh item,
    // jadi setelan "sembunyikan item aman" ditiadakan sementara.
    p.set('hide_safe', '0');
  } else if (status && status !== 'DEFAULT') {
    p.set('status', status);
  }

  if (search) p.set('search', search);
  if (shop && shop !== 'ALL') p.set('shop', shop);
  if (sort) p.set('sort', sort);
  return p.toString();
}

async function loadDashboard() {
  state.data = await api(`/api/dashboard?${dashboardQuery()}`);
  state.settings = state.data.settings;
  return state.data;
}

// ---------------------------- Notifikasi ----------------------------

function toast(message, type = 'info') {
  const host = $('#main');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `strip strip--${type}`;
  el.innerHTML = `
    ${icon(type === 'error' ? 'error' : type === 'success' ? 'check' : 'alert')}
    <span>${esc(message)}</span>
    <button class="strip__close" aria-label="Tutup">${icon('close')}</button>`;
  el.querySelector('.strip__close').onclick = () => el.remove();
  host.prepend(el);
  if (type !== 'error') setTimeout(() => el.remove(), 5000);
}

// ---------------------------- Status bar ----------------------------

function renderSyncStatus(status) {
  const dot = $('#syncStatus .dot');
  const text = $('#syncStatusText');
  if (!dot || !text) return;

  if (status?.running) {
    dot.className = 'dot dot--busy';
    text.textContent = 'Menarik data…';
    return;
  }
  const last = status?.lastSync;
  if (last && last.ok === false) {
    dot.className = 'dot dot--err';
    text.textContent = `Gagal: ${last.error || 'tidak diketahui'}`;
    return;
  }
  dot.className = 'dot dot--ok';
  const when = last?.finishedAt ? fmtRelative(last.finishedAt) : '—';
  text.textContent = `Diperbarui ${when}`;
}

/**
 * Di Vercel setiap polling adalah satu invocation function + satu query ke TiDB.
 * Layar gudang yang menyala 24 jam tidak perlu menanyakannya tiap 15 detik,
 * apalagi datanya sendiri hanya berubah tiap beberapa menit.
 */
let pollTimer = null;
function schedulePoll(serverless) {
  const ms = serverless ? 60000 : 15000;
  if (pollTimer?.ms === ms) return;
  clearInterval(pollTimer?.id);
  pollTimer = { ms, id: setInterval(pollStatus, ms) };
}

async function pollStatus() {
  try {
    const status = await api('/api/status');
    schedulePoll(!!status.serverless);
    renderSyncStatus(status);
    // Data baru masuk -> segarkan tampilan tanpa perlu tekan tombol.
    const stamp = status.lastSync?.finishedAt || null;
    if (stamp && stamp !== state.lastSyncStamp) {
      state.lastSyncStamp = stamp;
      if (state.tab === 'monitoring') {
        await loadDashboard();
        renderMonitoring();
      }
      if (slideshow.active) await slideshow.refresh();
    }
  } catch { /* diam saja; percobaan berikutnya menyusul */ }
}

// ---------------------------- Tab ----------------------------

function setTab(tab) {
  state.tab = tab;
  $$('.tabbar__item').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  render();
}

async function render() {
  const main = $('#main');
  main.innerHTML = `<div class="page"><p class="muted">Memuat…</p></div>`;
  try {
    if (state.tab === 'monitoring') {
      await loadDashboard();
      renderMonitoring();
    } else if (state.tab === 'pengaturan') {
      const r = await api('/api/settings');
      state.settings = r.settings;
      renderSettings(r.defaults);
    } else if (state.tab === 'ambang') {
      state.thresholds = await api('/api/thresholds');
      if (!state.settings) state.settings = (await api('/api/settings')).settings;
      renderThresholds();
    } else if (state.tab === 'riwayat') {
      state.syncLog = await api('/api/sync-log?limit=30');
      renderSyncLog();
    }
  } catch (err) {
    main.innerHTML = `<div class="page"></div>`;
    toast(err.message, 'error');
  }
}

// ---------------------------- Tab: Monitoring ----------------------------

function statusMeta(s) {
  switch (s) {
    case 'MINUS': return { label: 'Minus', icon: 'error', num: 'negative' };
    case 'HABIS': return { label: 'Habis', icon: 'error', num: 'negative' };
    case 'TIPIS': return { label: 'Tipis', icon: 'alert', num: 'critical' };
    default: return { label: 'Aman', icon: 'check', num: 'positive' };
  }
}

function tileHtml({ key, label, value, foot, tone }) {
  const active = state.filters.status === key;
  return `
    <button class="tile tile--${tone} ${active ? 'is-active' : ''}" data-status="${key}">
      <span class="tile__label">${esc(label)}</span>
      <span class="tile__value">${fmt(value)}</span>
      <span class="tile__foot">${esc(foot)}</span>
    </button>`;
}

function renderMonitoring() {
  const { summary, items, shops, scope, status } = state.data;
  const f = state.filters;

  const tiles = [
    { key: 'MINUS', label: 'Stok Minus', value: summary.minus, tone: 'negative', foot: 'Qty Rack di bawah nol' },
    { key: 'HABIS', label: 'Rak Kosong', value: summary.habis, tone: 'negative', foot: 'Qty Rack = 0' },
    { key: 'TIPIS', label: 'Stok Tipis', value: summary.tipis, tone: 'critical', foot: `Di bawah ambang` },
    { key: 'ACTIONABLE', label: 'Perlu Tindakan', value: summary.perluTindakan, tone: 'informative', foot: `${fmt(summary.bisaReplenish)} siap transfer` },
    { key: 'ALL', label: 'Total Dipantau', value: summary.total, tone: 'neutral', foot: `${fmt(summary.aman)} aman · ${fmt(summary.itemBaru)} baru` },
  ].map(tileHtml).join('');

  const shopOptions = ['ALL', ...shops]
    .map((s) => `<option value="${esc(s)}" ${f.shop === s ? 'selected' : ''}>${s === 'ALL' ? 'Semua Brand' : esc(s)}</option>`)
    .join('');

  const sorts = [
    ['urgency', 'Paling Mendesak'],
    ['qty_asc', 'Qty Rack Terkecil'],
    ['delta', 'Penurunan Terbesar'],
    ['sku', 'Kode SKU'],
    ['name', 'Nama Produk'],
  ].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('');

  $('#main').innerHTML = `
    <div class="page">
      ${staleWarningHtml(status?.staleness)}
      <div class="tiles">${tiles}</div>

      <section class="panel">
        <div class="toolbar">
          <div class="field">
            <label class="field__label" for="qSearch">Cari</label>
            <input class="input input--search" id="qSearch" type="search"
                   placeholder="Kode SKU, nama produk, atau kode SAP" value="${esc(f.search)}">
          </div>
          <div class="field">
            <label class="field__label" for="qShop">Brand</label>
            <select class="select" id="qShop">${shopOptions}</select>
          </div>
          <div class="field">
            <label class="field__label" for="qSort">Urutkan</label>
            <select class="select" id="qSort">${sorts}</select>
          </div>
          <div class="toolbar__spacer"></div>
          <label class="switch" title="Hanya tampilkan yang stoknya tersedia di Gudang Besar">
            <input type="checkbox" id="tReplenishable" ${scope.replenishableOnly ? 'checked' : ''}>
            <span class="switch__track"></span>
            <span class="switch__text"><span class="switch__title">Siap transfer saja</span></span>
          </label>
          <a class="btn" href="/api/export.csv?${dashboardQuery()}">${icon('download')} Ekspor CSV</a>
        </div>

        <div class="panel__head" style="border-bottom:none;padding-bottom:0.35rem">
          <p class="panel__hint" style="margin:0">
            Lingkup: <b>${scope.categories.map(esc).join(', ')}</b>
            · ${scope.includeInactive ? 'termasuk item non-aktif' : 'hanya item aktif'}
            · ${scope.includeClearance ? 'termasuk Clearance Sale' : 'tanpa Clearance Sale (CS-)'}
            · ambang default <b>${fmt(scope.defaultThreshold)}</b>
            · menampilkan <b>${fmt(items.length)}</b> baris
            ${status?.nextRunAt ? `· sinkron berikutnya ${fmtTime(status.nextRunAt)}` : ''}
          </p>
        </div>

        <div class="panel__body panel__body--flush">
          ${items.length ? tableHtml(items) : emptyHtml()}
        </div>
      </section>
    </div>`;

  wireMonitoring();
}

/**
 * Pada susunan hybrid, yang menarik data adalah worker di PC gudang sedangkan
 * dashboard tayang di Vercel. Kalau PC itu mati, halaman ini tetap tampil normal
 * dengan angka yang membeku — jadi kondisi tersebut harus dinyatakan terang-terangan.
 */
function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} menit`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam ${m % 60} menit`;
  return `${Math.floor(h / 24)} hari ${h % 24} jam`;
}

function staleWarningHtml(staleness) {
  if (!staleness?.stale) return '';
  const detail = staleness.ageMs
    ? `Sinkronisasi terakhir yang berhasil <b>${fmtDuration(staleness.ageMs)} lalu</b>.`
    : esc(staleness.reason || 'Belum pernah ada sinkronisasi berhasil.');
  return `
    <div class="strip strip--error">
      ${icon('error')}
      <span>
        <b>Data mungkin sudah tidak mutakhir.</b> ${detail}
        Periksa apakah worker penarik data di PC gudang masih berjalan
        (Services &rarr; <i>OCS Replenish Worker</i>), lalu lihat tab
        <b>Riwayat Sinkronisasi</b> untuk pesan galatnya.
      </span>
    </div>`;
}

function emptyHtml() {
  return `
    <div class="empty">
      ${icon('check', 'icon icon-lg')}
      <div class="empty__title">Tidak ada item yang perlu ditindak</div>
      <div>Semua stok rak berada di atas ambang untuk lingkup dan filter saat ini.</div>
    </div>`;
}

function rowHtml(i) {
  const m = statusMeta(i.status);
  const deltaCls = i.delta === null ? 'flat' : i.delta < 0 ? 'down' : i.delta > 0 ? 'up' : 'flat';
  const deltaTxt = i.delta === null ? '—'
    : i.delta === 0 ? '0'
    : `${i.delta > 0 ? '+' : ''}${fmt(i.delta)}`;

  const badges = [
    i.isNew ? '<span class="badge badge--new">BARU</span>' : '',
    i.hasOverride ? `<span class="badge badge--override" title="Ambang khusus item ini">AMBANG ${fmt(i.threshold)}</span>` : '',
    !i.isActive ? '<span class="badge badge--inactive">NON-AKTIF</span>' : '',
    i.category !== 'Sku' ? `<span class="badge">${esc(i.category).toUpperCase()}</span>` : '',
  ].join(' ');

  return `
    <tr class="${i.status === 'MINUS' ? 'row--minus' : ''}">
      <td>
        <div class="obj-id">
          <span class="obj-id__title">${esc(i.sku)} ${badges}</span>
          <span class="obj-id__text" title="${esc(i.name)}">${esc(i.name)}</span>
        </div>
      </td>
      <td class="col-optional">${i.shopCode ? `<span class="badge">${esc(i.shopCode)}</span>` : '<span class="muted">—</span>'}</td>
      <td><span class="status status--${i.status}">${icon(m.icon)} ${m.label}</span></td>
      <td class="num"><span class="obj-num obj-num--${m.num}">${fmt(i.qtyRack)}</span></td>
      <td class="num muted">${fmt(i.threshold)}</td>
      <td class="num"><b>${i.shortageQty > 0 ? fmt(i.shortageQty) : '—'}</b></td>
      <td class="num ${i.canReplenish ? '' : 'muted'}">${fmt(i.qtyBulk)}</td>
      <td class="num">
        ${i.canReplenish
          ? `<span class="badge badge--ready">Transfer ${fmt(i.suggestedQty)}</span>`
          : '<span class="badge badge--blocked">Stok besar habis</span>'}
      </td>
      <td class="num col-optional"><span class="delta delta--${deltaCls}">${deltaTxt}</span></td>
      <td class="num col-optional muted">${fmt(i.qtyOnHand)}</td>
      <td class="num">
        <button class="btn btn--sm btn--transparent" data-edit="${esc(i.sku)}" data-area="${esc(i.areaId)}"
                title="Atur ambang khusus untuk item ini">${icon('edit')}</button>
      </td>
    </tr>`;
}

function tableHtml(items) {
  return `
    <div class="table-wrap">
      <table class="ftable">
        <thead>
          <tr>
            <th>Produk</th>
            <th class="col-optional">Brand</th>
            <th>Status</th>
            <th class="num">Qty Rack</th>
            <th class="num">Ambang</th>
            <th class="num">Kurang</th>
            <th class="num">Gudang Besar</th>
            <th class="num">Saran</th>
            <th class="num col-optional">Δ</th>
            <th class="num col-optional">On Hand</th>
            <th class="num"></th>
          </tr>
        </thead>
        <tbody>${items.map(rowHtml).join('')}</tbody>
      </table>
    </div>`;
}

function wireMonitoring() {
  $$('[data-status]').forEach((btn) => {
    btn.onclick = async () => {
      state.filters.status = btn.dataset.status;
      await loadDashboard();
      renderMonitoring();
    };
  });

  const search = $('#qSearch');
  let debounce;
  search.oninput = () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      state.filters.search = search.value;
      await loadDashboard();
      renderMonitoring();
      const box = $('#qSearch');
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 300);
  };

  $('#qShop').onchange = async (e) => {
    state.filters.shop = e.target.value;
    await loadDashboard();
    renderMonitoring();
  };

  $('#qSort').onchange = async (e) => {
    state.filters.sort = e.target.value;
    await loadDashboard();
    renderMonitoring();
  };

  $('#tReplenishable').onchange = async (e) => {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ replenishable_only: e.target.checked ? 1 : 0 }),
    });
    await loadDashboard();
    renderMonitoring();
  };

  $$('[data-edit]').forEach((btn) => {
    btn.onclick = () => openThresholdDialog(btn.dataset.edit, btn.dataset.area);
  });
}

// ---------------------------- Tab: Pengaturan ----------------------------

function switchRow({ id, title, desc, checked }) {
  return `
    <div class="setting-row">
      <div class="setting-row__main">
        <div class="setting-row__title">${esc(title)}</div>
        <div class="setting-row__desc">${desc}</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
        <span class="switch__track"></span>
      </label>
    </div>`;
}

function numberRow({ id, title, desc, value, min, max, suffix }) {
  return `
    <div class="setting-row">
      <div class="setting-row__main">
        <div class="setting-row__title">${esc(title)}</div>
        <div class="setting-row__desc">${desc}</div>
      </div>
      <div class="row nowrap">
        <input class="input input--num" type="number" id="${id}" value="${value}" min="${min}" max="${max}">
        <span class="muted">${esc(suffix || '')}</span>
      </div>
    </div>`;
}

function renderSettings(defaults) {
  const s = state.settings;

  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">Pengaturan</h1>
      <p class="page__desc">Perubahan langsung tersimpan dan berlaku untuk dashboard maupun mode slide.</p>

      <div class="grid-2">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Pengambilan Data</h2>
          </div>
          <div class="panel__body">
            ${numberRow({
              id: 'sInterval', title: 'Interval sinkronisasi',
              desc: 'Setiap berapa menit data ditarik ulang dari OCS. Satu tarikan memakan ±2 detik.',
              value: s.poll_interval_minutes, min: 1, max: 1440, suffix: 'menit',
            })}
            ${switchRow({
              id: 'sAuto', title: 'Sinkronisasi otomatis',
              desc: 'Matikan bila ingin menarik data secara manual saja.',
              checked: s.auto_sync_enabled,
            })}
            ${numberRow({
              id: 'sNewDays', title: 'Masa tanda "BARU"',
              desc: 'Item yang pertama kali terlihat dalam rentang ini diberi label BARU.',
              value: s.new_item_days, min: 1, max: 365, suffix: 'hari',
            })}
            <div class="setting-row">
              <div class="setting-row__main">
                <div class="setting-row__title">Uji koneksi ke OCS</div>
                <div class="setting-row__desc" id="connResult">Memastikan kredensial dan endpoint masih valid.</div>
              </div>
              <button class="btn" id="btnTestConn">Uji Sekarang</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Ambang Stok Tipis</h2>
            <p class="panel__hint">Dihitung dari Qty Rack (stok gudang kecil).</p>
          </div>
          <div class="panel__body">
            ${numberRow({
              id: 'sThreshold', title: 'Ambang default global',
              desc: 'Dipakai semua item yang belum punya ambang khusus — termasuk material baru, sehingga langsung termonitor begitu muncul.',
              value: s.default_thin_threshold, min: 0, max: 1000000, suffix: 'pcs',
            })}
            <div class="setting-row">
              <div class="setting-row__main">
                <div class="setting-row__title">Ambang khusus per item</div>
                <div class="setting-row__desc">Item dengan karakter perputaran berbeda bisa diberi angka sendiri.</div>
              </div>
              <button class="btn" id="btnGoThreshold">Kelola</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Item yang Ditampilkan</h2>
            <p class="panel__hint">Menentukan lingkup data pada dashboard dan mode slide.</p>
          </div>
          <div class="panel__body">
            ${switchRow({
              id: 'sBundle', title: 'Tampilkan Bundle',
              desc: 'Bundle adalah SKU virtual hasil kalkulasi, bukan barang fisik di rak. Menyalakannya menambah ribuan baris yang tidak bisa di-replenish.',
              checked: s.show_bundle,
            })}
            ${switchRow({
              id: 'sGimmick', title: 'Tampilkan Gimmick',
              desc: 'Barang promo / hadiah. Nyalakan bila tim gudang juga menyiapkan gimmick di rak.',
              checked: s.show_gimmick,
            })}
            ${switchRow({
              id: 'sInactive', title: 'Tampilkan item non-aktif',
              desc: 'Item dengan status tidak aktif di OCS. Biasanya sudah tidak dijual.',
              checked: s.show_inactive,
            })}
            ${switchRow({
              id: 'sClearance', title: 'Tampilkan item Clearance Sale (CS-)',
              desc: 'Kategori Sku dengan kode berawalan <b>CS-</b>. Barang clearance sedang dihabiskan, bukan diisi ulang, sehingga secara bawaan tidak ikut dipantau.',
              checked: s.show_clearance,
            })}
            ${switchRow({
              id: 'sHideSafe', title: 'Sembunyikan item aman',
              desc: 'Hanya tampilkan yang minus, kosong, atau tipis. Matikan untuk melihat seluruh daftar.',
              checked: s.hide_safe,
            })}
            ${switchRow({
              id: 'sReplenishable', title: 'Hanya yang siap transfer',
              desc: 'Batasi ke item yang stok Gudang Besar-nya masih ada, sehingga daftar berisi pekerjaan yang bisa langsung dijalankan.',
              checked: s.replenishable_only,
            })}
          </div>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Mode Slide</h2>
            <p class="panel__hint">Untuk layar monitor di area gudang.</p>
          </div>
          <div class="panel__body">
            ${numberRow({
              id: 'sSlideRows', title: 'Baris per slide',
              desc: 'Makin sedikit baris, makin besar dan terbaca dari jauh.',
              value: s.slide_rows, min: 3, max: 60, suffix: 'baris',
            })}
            ${numberRow({
              id: 'sSlideSecs', title: 'Durasi tiap slide',
              desc: 'Waktu tampil sebelum berpindah ke halaman berikutnya.',
              value: s.slide_interval_seconds, min: 3, max: 300, suffix: 'detik',
            })}
            <div class="setting-row">
              <div class="setting-row__main">
                <div class="setting-row__title">Jalankan mode slide</div>
                <div class="setting-row__desc">Tekan <b>Esc</b> untuk keluar, <b>spasi</b> untuk jeda.</div>
              </div>
              <button class="btn btn--emphasized" id="btnStartSlide">${icon('play')} Mulai</button>
            </div>
          </div>
        </section>
      </div>

      <p class="muted" style="font-size:0.75rem">
        Nilai bawaan: interval ${defaults.poll_interval_minutes} menit, ambang ${defaults.default_thin_threshold} pcs.
      </p>
    </div>`;

  wireSettings();
}

function wireSettings() {
  const save = async (payload, label) => {
    try {
      const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      state.settings = r.settings;
      toast(`${label} tersimpan.`, 'success');
      return r;
    } catch (err) {
      toast(`Gagal menyimpan ${label}: ${err.message}`, 'error');
      throw err;
    }
  };

  const bindSwitch = (id, key, label) => {
    const el = $(`#${id}`);
    if (el) el.onchange = () => save({ [key]: el.checked ? 1 : 0 }, label);
  };

  bindSwitch('sAuto', 'auto_sync_enabled', 'Sinkronisasi otomatis');
  bindSwitch('sBundle', 'show_bundle', 'Tampilkan Bundle');
  bindSwitch('sGimmick', 'show_gimmick', 'Tampilkan Gimmick');
  bindSwitch('sInactive', 'show_inactive', 'Tampilkan item non-aktif');
  bindSwitch('sClearance', 'show_clearance', 'Tampilkan item Clearance Sale');
  bindSwitch('sHideSafe', 'hide_safe', 'Sembunyikan item aman');
  bindSwitch('sReplenishable', 'replenishable_only', 'Hanya yang siap transfer');

  const bindNumber = (id, key, label) => {
    const el = $(`#${id}`);
    if (!el) return;
    el.onchange = async () => {
      const r = await save({ [key]: Number(el.value) }, label);
      el.value = r.settings[key];   // tampilkan nilai setelah dibatasi server
    };
  };

  bindNumber('sInterval', 'poll_interval_minutes', 'Interval sinkronisasi');
  bindNumber('sThreshold', 'default_thin_threshold', 'Ambang default');
  bindNumber('sNewDays', 'new_item_days', 'Masa tanda BARU');
  bindNumber('sSlideRows', 'slide_rows', 'Baris per slide');
  bindNumber('sSlideSecs', 'slide_interval_seconds', 'Durasi slide');

  $('#btnGoThreshold').onclick = () => { location.hash = 'ambang'; };
  $('#btnStartSlide').onclick = () => { location.hash = 'slide'; };

  $('#btnTestConn').onclick = async (e) => {
    const btn = e.currentTarget;
    const out = $('#connResult');
    btn.disabled = true;
    out.textContent = 'Menghubungi OCS…';
    try {
      const r = await api('/api/connection-test', { method: 'POST' });
      out.innerHTML = `Terhubung sebagai <b>${esc(r.user)}</b> (${esc(r.role)}) pada database <b>${esc(r.companyDb)}</b> — ${r.durationMs} ms. Token berlaku sampai ${fmtTime(r.expiresAt)}.`;
    } catch (err) {
      out.innerHTML = `<span style="color:var(--sapNegativeColor)">Gagal: ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------------------------- Tab: Ambang per item ----------------------------

function renderThresholds() {
  const rows = state.thresholds;
  const def = state.settings?.default_thin_threshold ?? 0;

  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">Ambang per Item</h1>
      <p class="page__desc">
        Item yang tidak terdaftar di sini otomatis memakai ambang default global
        (<b>${fmt(def)}</b> pcs), termasuk material yang baru muncul.
      </p>

      <section class="panel">
        <div class="toolbar">
          <div class="field" style="flex:1 1 20rem">
            <label class="field__label" for="itemSearch">Cari item untuk diberi ambang khusus</label>
            <input class="input" id="itemSearch" type="search" placeholder="Ketik kode SKU atau nama produk…">
          </div>
          <div class="toolbar__spacer"></div>
        </div>
        <div id="searchResults"></div>
      </section>

      <section class="panel">
        <div class="panel__head">
          <h2 class="panel__title">Daftar ambang khusus</h2>
          <p class="panel__hint">${fmt(rows.length)} item</p>
        </div>
        <div class="panel__body panel__body--flush">
          ${rows.length ? `
          <div class="table-wrap">
            <table class="ftable">
              <thead>
                <tr>
                  <th>Produk</th><th class="num">Qty Rack</th><th class="num">Ambang</th>
                  <th>Catatan</th><th>Diubah</th><th class="num"></th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => `
                  <tr>
                    <td>
                      <div class="obj-id">
                        <span class="obj-id__title">${esc(r.sku)}</span>
                        <span class="obj-id__text">${esc(r.name || '(tidak ada di data terakhir)')}</span>
                      </div>
                    </td>
                    <td class="num mono">${r.qtyRack === null || r.qtyRack === undefined ? '—' : fmt(r.qtyRack)}</td>
                    <td class="num"><b>${fmt(r.threshold)}</b></td>
                    <td class="muted">${esc(r.note || '—')}</td>
                    <td class="muted nowrap">${fmtTime(r.updatedAt)}</td>
                    <td class="num nowrap">
                      <button class="btn btn--sm btn--transparent" data-edit="${esc(r.sku)}" data-area="${esc(r.areaId)}">${icon('edit')}</button>
                      <button class="btn btn--sm btn--transparent btn--negative" data-del="${esc(r.sku)}" data-area="${esc(r.areaId)}">${icon('close')}</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `
          <div class="empty">
            <div class="empty__title">Belum ada ambang khusus</div>
            <div>Seluruh item memakai ambang default global ${fmt(def)} pcs.</div>
          </div>`}
        </div>
      </section>
    </div>`;

  wireThresholds();
}

function wireThresholds() {
  const box = $('#itemSearch');
  const results = $('#searchResults');
  let debounce;

  box.oninput = () => {
    clearTimeout(debounce);
    const q = box.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    debounce = setTimeout(async () => {
      const items = await api(`/api/items/search?q=${encodeURIComponent(q)}`);
      results.innerHTML = items.length ? `
        <div class="table-wrap">
          <table class="ftable">
            <thead><tr><th>Produk</th><th>Kategori</th><th class="num">Qty Rack</th><th class="num">Gudang Besar</th><th class="num"></th></tr></thead>
            <tbody>
              ${items.map((i) => `
                <tr>
                  <td>
                    <div class="obj-id">
                      <span class="obj-id__title">${esc(i.sku)} ${i.isActive ? '' : '<span class="badge badge--inactive">NON-AKTIF</span>'}</span>
                      <span class="obj-id__text">${esc(i.name)}</span>
                    </div>
                  </td>
                  <td><span class="badge">${esc(i.category)}</span></td>
                  <td class="num mono">${fmt(i.qtyRack)}</td>
                  <td class="num mono">${fmt(i.qtyBulk)}</td>
                  <td class="num"><button class="btn btn--sm" data-edit="${esc(i.sku)}" data-area="${esc(i.areaId)}">Atur ambang</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : `<div class="empty">Tidak ada item yang cocok.</div>`;

      $$('[data-edit]', results).forEach((b) => {
        b.onclick = () => openThresholdDialog(b.dataset.edit, b.dataset.area);
      });
    }, 300);
  };

  $$('[data-edit]').forEach((b) => {
    if (b.closest('#searchResults')) return;
    b.onclick = () => openThresholdDialog(b.dataset.edit, b.dataset.area);
  });

  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const sku = b.dataset.del;
      if (!confirm(`Hapus ambang khusus untuk ${sku}? Item ini akan kembali memakai ambang default global.`)) return;
      await api(`/api/thresholds?sku=${encodeURIComponent(sku)}&areaId=${encodeURIComponent(b.dataset.area)}`, { method: 'DELETE' });
      toast(`Ambang khusus ${sku} dihapus.`, 'success');
      state.thresholds = await api('/api/thresholds');
      renderThresholds();
    };
  });
}

// ---------------------------- Dialog ambang ----------------------------

function openThresholdDialog(sku, areaId) {
  const current =
    state.data?.items.find((i) => i.sku === sku && i.areaId === areaId) ||
    state.thresholds.find((t) => t.sku === sku && t.areaId === areaId);

  const def = state.settings?.default_thin_threshold ?? 50;
  const value = current?.threshold ?? def;
  const hasOverride = current?.hasOverride ?? state.thresholds.some((t) => t.sku === sku);

  const host = $('#dialogHost');
  host.innerHTML = `
    <div class="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog__head">
          <h2 class="dialog__title">Ambang Stok Tipis</h2>
          <button class="btn btn--sm btn--transparent" style="margin-left:auto" id="dlgX">${icon('close')}</button>
        </div>
        <div class="dialog__body">
          <div class="obj-id" style="margin-bottom:1rem">
            <span class="obj-id__title">${esc(sku)}</span>
            <span class="obj-id__text">${esc(current?.name || '')}</span>
          </div>
          <div class="field" style="width:100%">
            <label class="field__label" for="dlgVal">Ambang tipis (pcs)</label>
            <input class="input" id="dlgVal" type="number" min="0" value="${value}">
          </div>
          <p class="muted" style="font-size:0.75rem;margin-top:0.5rem">
            Item dianggap <b>Tipis</b> bila Qty Rack berada di antara 1 dan angka ini.
            ${hasOverride ? '' : `Saat ini item memakai ambang default global (${fmt(def)} pcs).`}
          </p>
          <div class="field" style="width:100%;margin-top:0.75rem">
            <label class="field__label" for="dlgNote">Catatan (opsional)</label>
            <input class="input" id="dlgNote" type="text" maxlength="200"
                   placeholder="Alasan, misalnya: perputaran cepat" value="${esc(current?.note || '')}">
          </div>
        </div>
        <div class="dialog__foot">
          ${hasOverride ? `<button class="btn btn--negative" id="dlgReset">Kembalikan ke default</button>` : ''}
          <button class="btn" id="dlgCancel">Batal</button>
          <button class="btn btn--emphasized" id="dlgSave">Simpan</button>
        </div>
      </div>
    </div>`;

  const close = () => { host.innerHTML = ''; };
  $('#dlgX').onclick = close;
  $('#dlgCancel').onclick = close;
  host.querySelector('.dialog-backdrop').onclick = (e) => {
    if (e.target === e.currentTarget) close();
  };

  $('#dlgSave').onclick = async () => {
    const v = Number($('#dlgVal').value);
    if (!Number.isFinite(v) || v < 0) return toast('Ambang harus angka 0 atau lebih.', 'error');
    await api('/api/thresholds', {
      method: 'PUT',
      body: JSON.stringify({ sku, areaId, threshold: v, note: $('#dlgNote').value }),
    });
    close();
    toast(`Ambang ${sku} disetel ke ${fmt(v)} pcs.`, 'success');
    await refreshCurrentTab();
  };

  const reset = $('#dlgReset');
  if (reset) {
    reset.onclick = async () => {
      await api(`/api/thresholds?sku=${encodeURIComponent(sku)}&areaId=${encodeURIComponent(areaId)}`, { method: 'DELETE' });
      close();
      toast(`${sku} kembali memakai ambang default.`, 'success');
      await refreshCurrentTab();
    };
  }

  setTimeout(() => $('#dlgVal')?.select(), 50);
}

async function refreshCurrentTab() {
  if (state.tab === 'monitoring') {
    await loadDashboard();
    renderMonitoring();
  } else if (state.tab === 'ambang') {
    state.thresholds = await api('/api/thresholds');
    renderThresholds();
  }
}

// ---------------------------- Tab: Riwayat sinkronisasi ----------------------------

/**
 * Menerjemahkan pemicu sinkronisasi ke label yang mudah dibaca.
 * Berguna untuk memastikan penarikan otomatis benar-benar jalan: kalau seluruh
 * baris berlabel "Manual", berarti worker terjadwalnya tidak hidup.
 */
function triggerBadge(source) {
  const map = {
    worker:    ['Worker',   'badge--ready',  'Worker terjadwal di PC gudang'],
    scheduler: ['Terjadwal','badge--ready',  'Penjadwal internal server'],
    startup:   ['Startup',  '',              'Saat server dinyalakan'],
    manual:    ['Manual',   'badge--new',    'Tombol Sinkron di web'],
    cron:      ['Cron',     'badge--ready',  'Pemicu terjadwal dari luar'],
    cli:       ['CLI',      '',              'Dijalankan dari baris perintah'],
  };
  const [label, cls, title] = map[source] || [source || '—', '', ''];
  if (!source) return '<span class="muted">—</span>';
  return `<span class="badge ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

function renderSyncLog() {
  const rows = state.syncLog;
  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">Riwayat Sinkronisasi</h1>
      <p class="page__desc">30 penarikan data terakhir dari OCS.</p>
      <section class="panel">
        <div class="panel__body panel__body--flush">
          <div class="table-wrap">
            <table class="ftable">
              <thead>
                <tr>
                  <th>Mulai</th><th>Status</th><th>Pemicu</th><th class="num">Baris</th>
                  <th class="num">Item Baru</th><th class="num">Durasi</th><th>Keterangan</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => `
                  <tr>
                    <td class="nowrap">${fmtTime(r.started_at)}</td>
                    <td>
                      <span class="status status--${r.status === 'success' ? 'AMAN' : r.status === 'error' ? 'MINUS' : 'TIPIS'}">
                        ${icon(r.status === 'success' ? 'check' : r.status === 'error' ? 'error' : 'alert')}
                        ${r.status === 'success' ? 'Berhasil' : r.status === 'error' ? 'Gagal' : 'Berjalan'}
                      </span>
                    </td>
                    <td>${triggerBadge(r.trigger_source)}</td>
                    <td class="num mono">${r.row_count === null ? '—' : fmt(r.row_count)}</td>
                    <td class="num mono">${r.new_count === null ? '—' : fmt(r.new_count)}</td>
                    <td class="num mono">${r.duration_ms === null ? '—' : `${fmt(r.duration_ms)} ms`}</td>
                    <td class="muted">${esc(r.message || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>`;
}

// ---------------------------- Mode slide ----------------------------

const slideshow = {
  active: false,
  paused: false,
  page: 0,
  pages: [],
  timer: null,

  async start() {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    this.page = 0;
    document.body.style.overflow = 'hidden';
    await this.refresh();
    this.tick();
    document.addEventListener('keydown', this.onKey);
  },

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    document.removeEventListener('keydown', this.onKey);
    document.body.style.overflow = '';
    $('#slideHost').innerHTML = '';
    if (location.hash === '#slide') location.hash = 'monitoring';
  },

  onKey(e) {
    if (e.key === 'Escape') slideshow.stop();
    if (e.key === ' ') { e.preventDefault(); slideshow.togglePause(); }
    if (e.key === 'ArrowRight') slideshow.go(slideshow.page + 1);
    if (e.key === 'ArrowLeft') slideshow.go(slideshow.page - 1);
  },

  togglePause() {
    this.paused = !this.paused;
    if (this.paused) {
      clearTimeout(this.timer);
      const bar = $('#slideBar');
      if (bar) bar.style.animationPlayState = 'paused';
      this.paintFooter();
    } else {
      this.tick();
      this.paintFooter();
    }
  },

  /** Hanya perbarui teks bantuan di kaki layar saat status jeda berubah. */
  paintFooter() {
    const foot = $('#slideHint');
    if (foot) {
      foot.textContent = this.paused
        ? 'DIJEDA — spasi untuk lanjut'
        : 'Spasi: jeda · < > : pindah · Esc: keluar';
    }
  },

  /** Ambil data terbaru lalu potong menjadi beberapa slide. */
  async refresh() {
    const p = new URLSearchParams();
    p.set('sort', 'urgency');
    // Mode slide selalu fokus pada yang perlu ditindak.
    p.set('status', 'ACTIONABLE');
    const data = await api(`/api/dashboard?${p}`);
    this.data = data;

    const perPage = Math.max(3, Number(data.settings.slide_rows) || 12);
    this.pages = [];
    for (let i = 0; i < data.items.length; i += perPage) {
      this.pages.push(data.items.slice(i, i + perPage));
    }
    if (!this.pages.length) this.pages = [[]];
    if (this.page >= this.pages.length) this.page = 0;
    this.paint();
  },

  go(index) {
    if (!this.pages.length) return;
    this.page = (index + this.pages.length) % this.pages.length;
    this.paint();
    if (!this.paused) this.tick();
  },

  tick() {
    clearTimeout(this.timer);
    const secs = Math.max(3, Number(this.data?.settings?.slide_interval_seconds) || 15);
    this.startBar(secs);
    this.timer = setTimeout(async () => {
      // Setelah berputar satu putaran penuh, ambil data terbaru.
      if (this.page + 1 >= this.pages.length) await this.refresh();
      this.go(this.page + 1);
    }, secs * 1000);
  },

  /** Jalankan ulang bilah progres lewat animasi CSS. */
  startBar(seconds) {
    const bar = $('#slideBar');
    if (!bar) return;
    bar.classList.remove('is-running');
    void bar.offsetWidth;                 // paksa reflow agar animasi mulai dari nol
    bar.style.animationDuration = `${seconds}s`;
    bar.classList.add('is-running');
    bar.style.animationPlayState = this.paused ? 'paused' : 'running';
  },

  paint() {
    if (!this.active || !this.data) return;
    const { summary } = this.data;
    const items = this.pages[this.page] || [];
    const total = this.pages.length;

    $('#slideHost').innerHTML = `
      <div class="slideshow">
        <div class="slideshow__head">
          <div>
            <div class="slideshow__title">Replenish — Perlu Tindakan</div>
            <div class="slideshow__meta">
              Qty Rack (Gudang Kecil) · diperbarui ${fmtRelative(this.data.status?.lastSync?.finishedAt)}
              ${this.data.status?.staleness?.stale
                ? `<b style="color:#ffb0b0"> · DATA TIDAK MUTAKHIR (${fmtDuration(this.data.status.staleness.ageMs)} lalu)</b>`
                : ''}
            </div>
          </div>
          <div class="slideshow__counts">
            <div class="slideshow__count"><b style="color:#ffb0b0">${fmt(summary.minus)}</b><span>Minus</span></div>
            <div class="slideshow__count"><b style="color:#ffb0b0">${fmt(summary.habis)}</b><span>Kosong</span></div>
            <div class="slideshow__count"><b style="color:#f5c884">${fmt(summary.tipis)}</b><span>Tipis</span></div>
            <div class="slideshow__count"><b style="color:#abe2c2">${fmt(summary.bisaReplenish)}</b><span>Siap Transfer</span></div>
            <button class="shellbar__btn" id="slideClose" title="Keluar (Esc)">${icon('close', 'icon icon-lg')}</button>
          </div>
        </div>
        <div class="slideshow__progress"><div class="slideshow__bar" id="slideBar"></div></div>

        <div class="slideshow__body">
          ${items.length ? `
          <table class="stable">
            <thead>
              <tr>
                <th style="width:44%">Produk</th>
                <th>Status</th>
                <th class="num">Qty Rack</th>
                <th class="num">Ambang</th>
                <th class="num">Kurang</th>
                <th class="num">Gudang Besar</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((i) => {
                const m = statusMeta(i.status);
                return `
                <tr class="${i.status === 'MINUS' ? 'row--minus' : ''}">
                  <td>
                    <div class="obj-id">
                      <span class="obj-id__title">${esc(i.sku)}</span>
                      <span class="obj-id__text">${esc(i.name)}</span>
                    </div>
                  </td>
                  <td><span class="status status--${i.status}">${icon(m.icon, 'icon icon-lg')} ${m.label}</span></td>
                  <td class="num"><span class="obj-num obj-num--${m.num}">${fmt(i.qtyRack)}</span></td>
                  <td class="num muted">${fmt(i.threshold)}</td>
                  <td class="num"><b>${fmt(i.shortageQty)}</b></td>
                  <td class="num">${i.canReplenish
                    ? `<span style="color:var(--sapPositiveColor);font-weight:700">${fmt(i.qtyBulk)}</span>`
                    : `<span style="color:var(--sapNegativeColor);font-weight:700">0</span>`}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>` : `
          <div class="empty" style="padding-top:6rem">
            ${icon('check', 'icon icon-lg')}
            <div class="empty__title" style="font-size:1.75rem">Tidak ada item yang perlu ditindak</div>
            <div style="font-size:1.1rem">Semua stok rak berada di atas ambang.</div>
          </div>`}
        </div>

        <div class="slideshow__foot">
          <span>Slide ${this.page + 1} dari ${total} · ${fmt(this.data.items.length)} item</span>
          <div class="slideshow__dots">
            ${this.pages.map((_, idx) => `<span class="slideshow__dot ${idx === this.page ? 'is-active' : ''}"></span>`).join('')}
          </div>
          <span id="slideHint">${this.paused ? 'DIJEDA — spasi untuk lanjut' : 'Spasi: jeda · ← → : pindah · Esc: keluar'}</span>
        </div>
      </div>`;

    $('#slideClose').onclick = () => this.stop();
  },
};

// ---------------------------- Routing ----------------------------

const TABS = ['monitoring', 'pengaturan', 'ambang', 'riwayat'];

/**
 * Rute berbasis hash supaya tiap tab bisa di-bookmark.
 * `#slide` berguna untuk layar gudang: browser dibuka ke URL itu dan
 * langsung masuk mode presentasi tanpa perlu diklik siapa pun.
 */
async function applyHash() {
  const hash = (location.hash || '').replace(/^#/, '').toLowerCase();

  if (hash === 'slide') {
    if (state.tab !== 'monitoring') setTab('monitoring');
    if (!slideshow.active) await slideshow.start();
    return;
  }

  if (slideshow.active) slideshow.stop();

  const tab = TABS.includes(hash) ? hash : 'monitoring';
  if (tab !== state.tab || !state.data) setTab(tab);
}

window.addEventListener('hashchange', applyHash);

// ---------------------------- Boot ----------------------------

$$('.tabbar__item').forEach((btn) => {
  btn.onclick = () => { location.hash = btn.dataset.tab; };
});

$('#btnSync').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span><span>Menarik…</span>`;
  try {
    const r = await api('/api/sync', { method: 'POST' });
    toast(`Sinkronisasi selesai: ${fmt(r.rows)} baris, ${fmt(r.changedItems)} berubah, ${fmt(r.newItems)} item baru.`, 'success');
    await refreshCurrentTab();
  } catch (err) {
    toast(`Sinkronisasi gagal: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    pollStatus();
  }
};

$('#btnSlide').onclick = () => { location.hash = 'slide'; };

applyHash();
pollStatus();
schedulePoll(false);   // diperbarui sendiri begitu /api/status menjawab
