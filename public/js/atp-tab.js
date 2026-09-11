/* =========================================================================
   Tab "ATP Monitoring".

   ATP = persentase SKU aktif yang stoknya di atas ambang, per cabang.

   Catatan warna. Batang cabang memakai warna status karena maknanya memang
   baik/buruk, bukan peringkat — dan angka persennya selalu tertera, jadi warna
   tidak pernah menjadi satu-satunya penanda. Peta panas memakai satu hue biru
   terang-ke-gelap sebagaimana mestinya untuk besaran. Tren satu garis, satu
   warna, tanpa legenda.
   ========================================================================= */

const ATP = {
  tampilan: 'dashboard',   // dashboard | master | cabang | riwayat
  data: null,
  master: null,
  cabang: [],
  riwayat: [],
  brandFilter: 'ALL',
  massalSumber: null,    // cabang acuan untuk tombol "Samakan dengan"
  massalTujuan: 'grup:OXAR',  // rumpun, 'SELAIN', atau satu kode cabang
  jenisRiwayat: 'ALL',   // ALL | Sku | Bundle — pemecahan rekaman harian
  filterMaster: { search: '', shop: 'ALL', category: 'ALL', branch: 'ALL', status: 'ALL' },
};

/* Ambang kesehatan. Dipakai bersama oleh batang dan teksnya. */
function nadaAtp(pct) {
  if (pct >= 85) return 'good';
  if (pct >= 70) return 'warning';
  if (pct >= 50) return 'serious';
  return 'critical';
}

const LABEL_NADA = { good: 'Sehat', warning: 'Perlu perhatian', serious: 'Rendah', critical: 'Kritis' };

const pct1 = (v) => (Math.round(v * 10) / 10).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Enam langkah satu hue untuk peta panas. */
function warnaSeq(pct) {
  const i = pct >= 90 ? 6 : pct >= 80 ? 5 : pct >= 70 ? 4 : pct >= 55 ? 3 : pct >= 35 ? 2 : 1;
  return { bg: `var(--seq-${i})`, fg: i >= 4 ? '#fff' : '#1a2733' };
}

async function renderAtp() {
  const main = $('#main');
  main.innerHTML = `<div class="page"><p class="muted">Memuat…</p></div>`;
  try {
    ATP.data = await api(`/api/atp/dashboard?shop=${encodeURIComponent(ATP.brandFilter)}`);
  } catch (err) {
    main.innerHTML = `<div class="page"></div>`;
    return toast(err.message, 'error');
  }
  paintAtp();
}

function paintAtp() {
  const d = ATP.data || {};
  const cfg = d.config || {};

  const tabs = [
    ['dashboard', 'Dashboard'],
    ['master', 'Master Data'],
    ['cabang', 'Cabang'],
    ['riwayat', 'Riwayat'],
  ].map(([k, l]) => `<button data-atp-view="${k}" class="${ATP.tampilan === k ? 'is-active' : ''}">${l}</button>`).join('');

  $('#main').innerHTML = `
    <div class="page">
      <h1 class="page__title">ATP Monitoring</h1>
      <p class="page__desc">
        Available To Promise — berapa persen SKU aktif yang stoknya cukup untuk dijanjikan,
        dihitung per cabang dari stok OCS.
      </p>

      <div class="atp-dasar">
        <span class="atp-dasar__judul">${icon('settings')} Dasar perhitungan</span>
        <div class="field">
          <label class="field__label" for="atpKolom">Kolom stok</label>
          <select class="select" id="atpKolom" style="min-width:14rem">
            ${Object.entries(cfg.pilihanKolom || {}).map(([k, label]) =>
              `<option value="${esc(k)}" ${cfg.stockField === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field__label" for="atpAmbang">Tersedia bila lebih dari</label>
          <input class="input input--num" id="atpAmbang" type="number" min="0" max="100000"
                 style="width:6rem" value="${fmt(cfg.threshold || 0)}">
        </div>
        <span class="atp-dasar__ket">
          Setiap angka di halaman ini dihitung dari kolom tersebut. Mengubahnya menghitung
          ulang saat itu juga, tetapi rekaman harian yang lama tidak ditulis ulang.
        </span>
      </div>

      <section class="panel">
        <div class="toolbar">
          <div class="segmented">${tabs}</div>
          <div class="toolbar__spacer"></div>
          <span class="panel__hint">
            ${d.terakhirDitarik ? `ditarik ${fmtWaktu(d.terakhirDitarik)}` : ''}
          </span>
          <button class="btn" id="atpSync">${icon('refresh')} Tarik dari OCS</button>
        </div>
        <div id="atpBody"></div>
      </section>
    </div>`;

  $$('[data-atp-view]').forEach((b) => {
    b.onclick = () => { ATP.tampilan = b.dataset.atpView; paintAtp(); };
  });

  /*
   * Mengubah dasar stok atau ambangnya menghitung ulang ATP saat itu juga,
   * tetapi tidak menulis ulang rekaman lama: tiap baris rekaman menyimpan
   * kolom dan ambang yang berlaku ketika ia diambil, supaya tren tidak
   * berubah arti secara diam-diam.
   */
  async function simpanSetelanAtp(perubahan, pesan) {
    try {
      const r = await api('/api/settings', { method: 'PUT', body: JSON.stringify(perubahan) });
      if (r.rejected?.length) throw new Error(r.rejected[0].reason);
      toast(pesan, 'success');
      ATP.data = null;
      await renderAtp();
    } catch (err) {
      toast(err.message, 'error');
      await renderAtp();
    }
  }

  $('#atpKolom').onchange = (e) => {
    const label = e.target.options[e.target.selectedIndex].text;
    simpanSetelanAtp({ atp_stock_field: e.target.value }, `ATP kini dihitung dari ${label}.`);
  };

  $('#atpAmbang').onchange = (e) => {
    const n = Math.trunc(Number(e.target.value));
    if (!Number.isFinite(n) || n < 0) return toast('Ambang harus angka bulat tak negatif.', 'error');
    simpanSetelanAtp({ atp_threshold: n }, `Stok di atas ${n} pcs kini dihitung tersedia.`);
  };

  $('#atpSync').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const asli = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span><span>Menarik…</span>`;
    try {
      const r = await api('/api/atp/sync', { method: 'POST' });
      const m = r.master || r;
      toast(`Selesai: ${fmt(m.sku)} SKU, ${fmt(m.barisCabang)} baris cabang, ${fmt(m.komponen)} komponen bundle.`, 'success');
      await renderAtp();
    } catch (err) {
      toast(`Gagal menarik: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = asli;
    }
  };

  if (ATP.tampilan === 'dashboard') paintDashboard();
  else if (ATP.tampilan === 'master') paintMaster();
  else if (ATP.tampilan === 'cabang') paintCabang();
  else paintRiwayat();
}

/* ---------------------------- Dashboard ---------------------------- */

function paintDashboard() {
  const d = ATP.data;
  const t = d.total || { active: 0, ready: 0, pct: 0 };
  const nada = nadaAtp(t.pct);

  const opsiBrand = ['ALL', ...(d.brands || [])]
    .map((b) => `<option value="${esc(b)}" ${ATP.brandFilter === b ? 'selected' : ''}>${b === 'ALL' ? 'Semua brand' : esc(b)}</option>`)
    .join('');

  // Cabang terlemah lebih dulu — itu yang perlu ditindak.
  const terlemah = (d.perCabang || [])[0];

  $('#atpBody').innerHTML = `
    <div class="panel__body">
      <div class="toolbar" style="background:transparent;box-shadow:none;padding:0 0 1rem">
        <div class="field">
          <label class="field__label" for="atpBrand">Brand</label>
          <select class="select" id="atpBrand">${opsiBrand}</select>
        </div>
        <div class="toolbar__spacer"></div>
      </div>

      <div class="hero">
        <div>
          <div class="hero__label">ATP Keseluruhan</div>
          <div class="hero__angka">${pct1(t.pct)}<span class="hero__satuan">%</span></div>
        </div>
        <div class="hero__pisah"></div>
        <div>
          <div class="hero__label">SKU Siap</div>
          <div class="hero__detail" style="font-size:1.5rem;font-weight:600">${fmt(t.ready)} <span style="opacity:.7;font-size:1rem">dari ${fmt(t.active)} aktif</span></div>
        </div>
        ${terlemah ? `
        <div class="hero__pisah"></div>
        <div>
          <div class="hero__label">Cabang Terlemah</div>
          <div class="hero__detail" style="font-size:1.5rem;font-weight:600">${esc(terlemah.branch)}
            <span style="opacity:.7;font-size:1rem">${pct1(terlemah.total.pct)}%</span></div>
        </div>` : ''}
      </div>

      <div class="grid-2" style="align-items:start">
        <div>
          <div class="panel__head" style="padding:0 0 .75rem">
            <h2 class="panel__title">ATP per Cabang</h2>
            <p class="panel__hint" style="margin:0">Diurutkan dari yang paling perlu ditindak</p>
          </div>
          <div class="rank">${(d.perCabang || []).map(barisCabang).join('')}</div>
        </div>

        <div>
          <div class="panel__head" style="padding:0 0 .75rem">
            <h2 class="panel__title">ATP per Brand</h2>
            <p class="panel__hint" style="margin:0">Seluruh cabang digabung</p>
          </div>
          <div class="rank">${(d.perBrand || []).map((b) => {
            const n = nadaAtp(b.pct);
            return `
            <div class="rank__baris" title="${esc(b.shop)}: ${fmt(b.ready)} siap dari ${fmt(b.active)} SKU aktif">
              <div class="rank__nama">${esc(b.shop)}</div>
              <div class="rank__jalur"><div class="rank__isi is-${n}" style="width:${Math.max(1, b.pct).toFixed(1)}%"></div></div>
              <div class="rank__nilai teks-${n}">${pct1(b.pct)}%<div class="rank__sub">${fmt(b.ready)}/${fmt(b.active)}</div></div>
            </div>`;
          }).join('')}</div>
        </div>
      </div>

      <div class="panel__head" style="padding:1.5rem 0 .75rem">
        <h2 class="panel__title">Peta ATP — Cabang × Brand</h2>
        <div class="toolbar__spacer"></div>
        ${skalaLegenda()}
      </div>
      ${petaPanas(d)}

      <div class="panel__head" style="padding:1.5rem 0 .5rem">
        <h2 class="panel__title">Tren Harian</h2>
        <p class="panel__hint" style="margin:0">Dari rekaman jam ${fmt(d.config?.snapshotHour ?? 7)}:00 tiap hari</p>
      </div>
      ${grafikTren(d.tren || [])}
    </div>`;

  $('#atpBrand').onchange = async (e) => {
    ATP.brandFilter = e.target.value;
    await renderAtp();
  };

  pasangTrenHover();
}

function barisCabang(c) {
  const n = nadaAtp(c.total.pct);
  return `
    <div class="rank__baris" title="${esc(c.branch)} — ${LABEL_NADA[n]}: ${fmt(c.total.ready)} siap dari ${fmt(c.total.active)} SKU aktif (SKU tunggal ${pct1(c.sku.pct)}%, bundle ${pct1(c.bundle.pct)}%)">
      <div class="rank__nama">${esc(c.branch)}
        <div class="rank__sub">${LABEL_NADA[n]}</div>
      </div>
      <div class="rank__jalur"><div class="rank__isi is-${n}" style="width:${Math.max(1, c.total.pct).toFixed(1)}%"></div></div>
      <div class="rank__nilai teks-${n}">${pct1(c.total.pct)}%
        <div class="rank__sub">${fmt(c.total.ready)}/${fmt(c.total.active)}</div>
      </div>
    </div>`;
}

function skalaLegenda() {
  const langkah = [
    ['1', '<35%'], ['2', '35–55%'], ['3', '55–70%'],
    ['4', '70–80%'], ['5', '80–90%'], ['6', '≥90%'],
  ];
  return `<div class="skala">
    <span>Rendah</span>
    ${langkah.map(([i, l]) => `<span class="skala__kotak" style="background:var(--seq-${i})" title="${l}"></span>`).join('')}
    <span>Tinggi</span>
  </div>`;
}

function petaPanas(d) {
  const m = d.matriks || [];
  if (!m.length) return `<div class="empty"><div class="muted">Belum ada data.</div></div>`;
  const brands = (m[0].cells || []).map((c) => c.shop);

  return `
    <div class="table-wrap">
      <table class="heat">
        <thead>
          <tr><th class="kiri">Cabang</th>${brands.map((b) => `<th>${esc(b)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${m.map((row) => `
            <tr>
              <td class="heat__nama">${esc(row.branch)}</td>
              ${row.cells.map((c) => {
                if (!c.active) return `<td><span class="heat__sel" style="background:var(--neutral-bg);color:var(--text-subtle)" title="Tidak ada SKU aktif">—</span></td>`;
                const w = warnaSeq(c.pct);
                return `<td><span class="heat__sel" style="background:${w.bg};color:${w.fg}"
                  title="${esc(row.branch)} · ${esc(c.shop)} — ${fmt(c.ready)} siap dari ${fmt(c.active)} SKU aktif">
                  ${pct1(c.pct)}%<small>${fmt(c.ready)}/${fmt(c.active)}</small></span></td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ---- Grafik tren: satu seri, satu warna, dengan garis silang saat disorot ---- */

function grafikTren(tren) {
  if (tren.length < 2) {
    return `<div class="empty" style="padding:2rem">
      <div class="muted">Butuh minimal dua hari rekaman untuk menggambar tren.
      Rekaman diambil otomatis tiap jam ${fmt(ATP.data?.config?.snapshotHour ?? 7)}:00.</div></div>`;
  }

  const W = 1000, H = 220, L = 44, R = 12, T = 14, B = 28;
  const pw = W - L - R, ph = H - T - B;

  const nilai = tren.map((x) => x.pct);
  const maks = Math.min(100, Math.ceil(Math.max(...nilai) / 10) * 10 + 5);
  const min = Math.max(0, Math.floor(Math.min(...nilai) / 10) * 10 - 5);
  const rentang = maks - min || 1;

  const X = (i) => L + (tren.length === 1 ? pw / 2 : (i / (tren.length - 1)) * pw);
  const Y = (v) => T + ph - ((v - min) / rentang) * ph;

  const garis = tren.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(x.pct).toFixed(1)}`).join('');
  const area = `${garis}L${X(tren.length - 1).toFixed(1)},${T + ph}L${X(0).toFixed(1)},${T + ph}Z`;

  const tiks = [0, 1, 2, 3].map((k) => min + (rentang * k) / 3);
  const langkahLabel = Math.max(1, Math.ceil(tren.length / 8));

  return `
    <div class="tren" id="trenHost">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Tren ATP harian">
        ${tiks.map((v) => `
          <line class="tren__grid" x1="${L}" y1="${Y(v).toFixed(1)}" x2="${W - R}" y2="${Y(v).toFixed(1)}"/>
          <text class="tren__sumbu" x="${L - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}%</text>`).join('')}
        <path class="tren__area" d="${area}"/>
        <path class="tren__garis" d="${garis}"/>
        ${tren.map((x, i) => i % langkahLabel === 0 || i === tren.length - 1
          ? `<text class="tren__sumbu" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(x.tanggal.slice(5))}</text>`
          : '').join('')}
        <g id="trenSorot" style="display:none">
          <line class="tren__silang" y1="${T}" y2="${T + ph}"/>
          <circle class="tren__titik" r="5"/>
        </g>
        <rect id="trenArea" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" style="cursor:crosshair"/>
      </svg>
      <div class="tip" id="trenTip" style="display:none"></div>
    </div>`;
}

/** Sorot garis silang mengikuti titik data terdekat. */
function pasangTrenHover() {
  const host = $('#trenHost');
  const area = $('#trenArea');
  if (!host || !area) return;

  const tren = ATP.data.tren || [];
  const svg = host.querySelector('svg');
  const sorot = $('#trenSorot');
  const tip = $('#trenTip');
  const W = 1000, L = 44, R = 12, T = 14, B = 28, H = 220;
  const pw = W - L - R, ph = H - T - B;

  const nilai = tren.map((x) => x.pct);
  const maks = Math.min(100, Math.ceil(Math.max(...nilai) / 10) * 10 + 5);
  const min = Math.max(0, Math.floor(Math.min(...nilai) / 10) * 10 - 5);
  const rentang = maks - min || 1;
  const X = (i) => L + (i / (tren.length - 1)) * pw;
  const Y = (v) => T + ph - ((v - min) / rentang) * ph;

  area.onmousemove = (e) => {
    const kotak = svg.getBoundingClientRect();
    const xSvg = ((e.clientX - kotak.left) / kotak.width) * W;
    const i = Math.max(0, Math.min(tren.length - 1, Math.round(((xSvg - L) / pw) * (tren.length - 1))));
    const d = tren[i];

    sorot.style.display = '';
    sorot.querySelector('line').setAttribute('x1', X(i));
    sorot.querySelector('line').setAttribute('x2', X(i));
    sorot.querySelector('circle').setAttribute('cx', X(i));
    sorot.querySelector('circle').setAttribute('cy', Y(d.pct));

    tip.style.display = '';
    tip.innerHTML = `${esc(d.tanggal)}<br><b>${pct1(d.pct)}%</b> — ${fmt(d.ready)}/${fmt(d.active)} SKU`;
    tip.style.left = `${(X(i) / W) * kotak.width}px`;
    tip.style.top = `${(Y(d.pct) / H) * kotak.height}px`;
  };
  area.onmouseleave = () => { sorot.style.display = 'none'; tip.style.display = 'none'; };
}
