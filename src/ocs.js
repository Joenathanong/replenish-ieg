import { config } from './config.js';

const { baseUrl, username, password, companyDb, stockEntity } = config.ocs;

let cachedToken = null;
let tokenExpiresAt = 0;
let inFlightLogin = null;

const UA = 'OCS-Replenish-Monitor/1.0';

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function requestJson(url, options = {}, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        Origin: baseUrl,
        ...options.headers,
      },
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Endpoint yang tidak dikenal akan mengembalikan shell HTML SPA, bukan JSON.
        if (text.trimStart().startsWith('<')) {
          throw new Error(`Endpoint tidak mengembalikan JSON (kemungkinan URL salah): ${url}`);
        }
        throw new Error(`Respons bukan JSON yang valid dari ${url}`);
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Daftar company database yang tersedia. Tidak butuh autentikasi. */
export async function fetchCompanyList() {
  const { ok, status, data } = await requestJson(`${baseUrl}/Auth/CompanyList`, { method: 'GET' }, 20_000);
  if (!ok) throw new Error(`Gagal mengambil CompanyList (HTTP ${status})`);
  return data;
}

async function doLogin() {
  const { ok, status, data } = await requestJson(
    `${baseUrl}/Auth/Login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(username),
        password: String(password),
        companydb: String(companyDb),
      }),
    },
    30_000,
  );

  if (!ok || !data?.Token) {
    const hint = status === 401 ? 'periksa OCS_USERNAME / OCS_PASSWORD / OCS_COMPANY_DB' : `HTTP ${status}`;
    throw new Error(`Login OCS gagal (${hint})`);
  }

  cachedToken = data.Token;
  const exp = decodeJwtExp(cachedToken);
  // Refresh 10 menit sebelum kedaluwarsa; fallback 12 jam bila exp tak terbaca.
  tokenExpiresAt = exp ? exp - 10 * 60_000 : Date.now() + 12 * 3600_000;
  return cachedToken;
}

export async function getToken(force = false) {
  if (!force && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (inFlightLogin) return inFlightLogin;          // hindari login paralel berganda
  inFlightLogin = doLogin().finally(() => { inFlightLogin = null; });
  return inFlightLogin;
}

/**
 * Status yang layak dicoba ulang: gangguan sesaat di sisi server atau gateway,
 * bukan kesalahan permintaan kita. 520-524 khas Cloudflare yang berada di depan OCS.
 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 502, 503, 504, 520, 521, 522, 523, 524]);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET terautentikasi.
 *
 * Dua lapis pemulihan:
 *   1. Kena 401  -> login ulang lalu coba lagi sekali.
 *   2. Kena gangguan sesaat (502/503/504, timeout, koneksi putus)
 *      -> coba lagi dengan jeda menaik.
 *
 * OCS terbukti kadang menjawab 502 atau baru merespons setelah 20 detik. Tanpa
 * percobaan ulang, satu gangguan sekejap membatalkan seluruh sinkronisasi dan
 * data baru diperbarui pada putaran berikutnya.
 */
async function authedGet(path, timeoutMs = 90_000, attempts = 3) {
  let lastMessage = 'tidak diketahui';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let transient = false;

    try {
      let token = await getToken();
      let res = await requestJson(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, timeoutMs);

      if (res.status === 401) {
        token = await getToken(true);
        res = await requestJson(`${baseUrl}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }, timeoutMs);
      }

      if (res.ok) return res.data;

      lastMessage = `HTTP ${res.status}`;
      transient = TRANSIENT_STATUS.has(res.status);
      if (!transient) throw new Error(`GET ${path} gagal (${lastMessage})`);
    } catch (err) {
      // Kegagalan jaringan dan timeout tidak punya status; keduanya sesaat.
      if (!transient && !/HTTP \d+/.test(err.message)) {
        lastMessage = err.message;
        transient = true;
      }
      if (!transient) throw err;
    }

    if (attempt === attempts) break;

    // Jeda menaik dengan sedikit acak, supaya beberapa proses tidak serentak
    // menghantam server yang sedang pulih.
    const wait = Math.round(2000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
    console.warn(`[ocs] ${path} ${lastMessage}; coba lagi ${attempt + 1}/${attempts} dalam ${wait} ms`);
    await delay(wait);
  }

  throw new Error(`GET ${path} gagal setelah ${attempts} percobaan (${lastMessage})`);
}

/**
 * Anggaran waktu berbeda menurut tempat berjalannya.
 *
 * Function Vercel dibatasi 120 detik, sehingga percobaan ulang harus muat di
 * dalamnya. Worker di PC gudang tidak punya batas itu dan boleh lebih sabar,
 * karena lebih baik menunggu daripada melewatkan satu putaran penuh.
 */
const RETRY_BUDGET = config.isServerless
  ? { timeoutMs: 35_000, attempts: 2 }
  : { timeoutMs: 90_000, attempts: 3 };

/** Snapshot penuh stok. Dataset ~2.500 baris / 760 KB, jadi tidak perlu paging. */
export async function fetchStock() {
  const data = await authedGet(`/odata/${stockEntity}`, RETRY_BUDGET.timeoutMs, RETRY_BUDGET.attempts);
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Format respons OData tidak dikenali');
  return rows;
}

/** Master setting item; dipakai untuk memetakan SKU ke brand (ShopCode). */
export async function fetchItemSettings() {
  // Hanya pelengkap tampilan, jadi cukup satu percobaan agar tidak memakan
  // anggaran waktu yang dibutuhkan penarikan stok.
  const data = await authedGet('/Stock/WmsItemSettings', 30_000, 1);
  return Array.isArray(data) ? data : [];
}

// -------------------- riwayat replenish --------------------

/**
 * Log replenish per bin (DTO_HistoryReplenish).
 *
 * Tabel ini hanya bertambah dan Id-nya berurutan, jadi cukup mengambil baris
 * yang Id-nya lebih besar dari yang terakhir tersimpan. `sinceId` sengaja
 * diberi mundur sedikit oleh pemanggil: baris dengan Id lebih kecil bisa saja
 * baru selesai tersimpan setelah baris ber-Id besar, dan penulisan bersifat
 * upsert sehingga tumpang tindih tidak menimbulkan duplikat.
 */
export async function fetchReplenishLog(sinceId = 0) {
  const filter = sinceId > 0 ? `&$filter=Id gt ${Math.trunc(sinceId)}` : '';
  const data = await authedGet(
    `/odata/DTO_HistoryReplenish?$orderby=Id${filter}`,
    RETRY_BUDGET.timeoutMs,
    RETRY_BUDGET.attempts,
  );
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Format respons DTO_HistoryReplenish tidak dikenali');
  return rows;
}

/**
 * Dokumen Inventory Transfer (DTO_HistoryReplenishITHead).
 * Kuncinya GUID sehingga tidak bisa diurutkan menaik seperti Id; penyaringnya
 * memakai CreatedAt, juga dengan tenggang mundur dari pemanggil.
 */
export async function fetchReplenishDocs(sinceIso = null) {
  const filter = sinceIso ? `&$filter=CreatedAt gt ${sinceIso}` : '';
  const data = await authedGet(
    `/odata/DTO_HistoryReplenishITHead?$orderby=CreatedAt${filter}`,
    RETRY_BUDGET.timeoutMs,
    RETRY_BUDGET.attempts,
  );
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Format respons DTO_HistoryReplenishITHead tidak dikenali');
  return rows;
}

/**
 * Baris detail satu dokumen. Hanya tersedia satu per satu — tidak ada entity
 * OData untuk barisnya — sehingga pengambilan awal harus ditarik bertahap.
 */
export async function fetchReplenishDocDetail(id) {
  const data = await authedGet(`/Stock/ReplenishHistory/${encodeURIComponent(id)}`, 30_000, 2);
  return {
    head: data,
    lines: Array.isArray(data?.Details) ? data.Details : [],
  };
}

// -------------------- riwayat adjustment stok --------------------

/**
 * Header penyesuaian stok (DTO_HistoryStockAdjustment).
 * Sama seperti log replenish: hanya bertambah dan Id-nya berurutan, jadi bisa
 * ditarik inkremental.
 */
export async function fetchAdjustments(sinceId = 0) {
  const filter = sinceId > 0 ? `&$filter=Id gt ${Math.trunc(sinceId)}` : '';
  const data = await authedGet(
    `/odata/DTO_HistoryStockAdjustment?$orderby=Id${filter}`,
    RETRY_BUDGET.timeoutMs,
    RETRY_BUDGET.attempts,
  );
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Format respons DTO_HistoryStockAdjustment tidak dikenali');
  return rows;
}

/**
 * Baris detail beberapa transaksi sekaligus.
 *
 * Berbeda dengan riwayat replenish yang detailnya hanya bisa diambil satu per
 * satu, endpoint ini menerima kumpulan Id dalam satu permintaan — sehingga
 * seluruh riwayat bisa ditarik dalam hitungan detik tanpa perlu antrean.
 */
export async function fetchAdjustmentDetails(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];

  const token = await getToken();
  const post = async (auth) =>
    requestJson(`${baseUrl}/Stock/GetHistoryStockAdjustmentDetail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify(ids),
    }, RETRY_BUDGET.timeoutMs);

  let res = await post(token);
  if (res.status === 401) res = await post(await getToken(true));

  if (!res.ok) throw new Error(`Gagal mengambil detail adjustment (HTTP ${res.status})`);
  return Array.isArray(res.data) ? res.data : [];
}

// -------------------- laporan penjualan --------------------

/**
 * Endpoint report menerima rentang tanggal dan mengembalikan agregat harian.
 *
 * KEDUA batas bersifat inklusif. Sempat diperlakukan sebagai eksklusif dengan
 * memajukan `to` satu hari, dan akibatnya server mengembalikan satu hari ekstra
 * di luar rentang yang diminta — hari itu lalu tidak ikut terhapus saat
 * penulisan ulang dan menabrak kunci primer pada penarikan berikutnya.
 */
/**
 * Zona waktu data OCS. Cap waktunya berakhiran +07:00, dan pengelompokan
 * hariannya mengikuti hari kalender di zona itu — bukan UTC.
 */
const ZONA_OCS = process.env.OCS_TIMEZONE_OFFSET || '+07:00';

/**
 * Batas rentang tanggal untuk endpoint report.
 *
 * Batasnya HARUS dipatok ke awal dan akhir hari menurut zona waktu OCS.
 * Sebelumnya dipakai tengah malam UTC, yang jatuh pada pukul 07:00 waktu OCS —
 * akibatnya hari pertama dan terakhir setiap permintaan terpotong, dan hanya
 * hari di tengah rentang yang utuh.
 *
 * Terukur pada 15 Maret 2026: di tengah rentang 67.601 pcs, di awal rentang
 * 50.888, di akhir rentang 16.713 — dan dua angka terakhir berjumlah tepat
 * sama dengan yang pertama, memperlihatkan harinya terbelah di tengah malam UTC.
 */
function rentang(fromDate, toDate) {
  const from = `${fromDate}T00:00:00.000${ZONA_OCS}`;
  const to = `${toDate}T23:59:59.999${ZONA_OCS}`;
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/**
 * Anggaran waktu khusus laporan penjualan.
 *
 * OCS menyegarkan materialized view untuk data terkini, sehingga rentang
 * beberapa hari terakhir dijawab dalam hitungan detik. Rentang lama tampaknya
 * jatuh ke pemindaian tabel order yang berisi 19,6 juta baris dan bisa memakan
 * puluhan detik per hari — batas 90 detik sempat memutus permintaan seperti itu
 * di tengah jalan.
 */
const SALES_TIMEOUT_MS = config.isServerless ? 60_000 : 240_000;

/**
 * Order per shop: satu baris per tanggal x shop x area, berisi total order,
 * SOI/MOI, dan rincian per platform beserta jumlah order tiap kelompok status.
 */
export async function fetchSalesOrderReport(fromDate, toDate, { area = 'All', shop = 'All', platform = 'All' } = {}) {
  const data = await authedGet(
    `/Report/OrderPerShopReport?${rentang(fromDate, toDate)}&platform=${encodeURIComponent(platform)}` +
    `&shop=${encodeURIComponent(shop)}&area=${encodeURIComponent(area)}`,
    SALES_TIMEOUT_MS,
    RETRY_BUDGET.attempts,
  );
  return Array.isArray(data) ? data : [];
}

/** Order per SKU: satu baris per tanggal x SKU x area, dengan rincian platform. */
export async function fetchSalesSkuReport(fromDate, toDate, { area = 'All', shop = 'All', platform = 'All' } = {}) {
  const data = await authedGet(
    `/Report/OrderPerSkuReport?${rentang(fromDate, toDate)}&platform=${encodeURIComponent(platform)}` +
    `&shop=${encodeURIComponent(shop)}&area=${encodeURIComponent(area)}`,
    SALES_TIMEOUT_MS,
    RETRY_BUDGET.attempts,
  );
  return Array.isArray(data) ? data : [];
}

/** Daftar status resmi beserta kodenya. Dipakai halaman audit status. */
export async function fetchStatusList() {
  const data = await authedGet('/MasterData/GetStatusList', 30_000, 2);
  return Array.isArray(data) ? data : [];
}

/** Nilai filter yang disediakan OCS: area, shop, dan channel. */
export async function fetchReportFilterOptions() {
  const data = await authedGet('/Report/ReportFilterOptions', 30_000, 2);
  return data && typeof data === 'object' ? data : { Areas: [], Shops: [], Channels: [] };
}

// -------------------- ATP Monitoring --------------------

/*
 * ATP memakai akun tersendiri karena hak akses area melekat pada akun.
 * Akun utama hanya melihat area Pusat, sedangkan ATP butuh kelima cabang —
 * jadi tokennya disimpan terpisah, bukan menimpa token akun utama.
 */
let atpToken = null;
let atpExpiresAt = 0;
let atpLogin = null;

async function doAtpLogin() {
  /*
   * Tidak ada jalan mundur ke akun biasa.
   *
   * Sebelumnya fungsi ini diam-diam memakai akun monitoring ketika kredensial
   * ATP kosong. Akibatnya fatal dan tak terlihat: akun itu hanya punya akses
   * area Pusat, sehingga penarikan tetap "berhasil" tetapi hanya menyegarkan
   * satu cabang dan meninggalkan empat cabang lain dengan angka lama. Lebih
   * baik gagal terang-terangan.
   */
  const user = config.ocs.atpUsername;
  const pass = config.ocs.atpPassword;
  if (!user || !pass) {
    throw new Error(
      'Kredensial ATP belum diisi. Setel OCS_ATP_USERNAME dan OCS_ATP_PASSWORD — ' +
      'akun monitoring biasa tidak dipakai sebagai pengganti karena aksesnya hanya area Pusat.',
    );
  }

  const { ok, status, data } = await requestJson(
    `${baseUrl}/Auth/Login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(user),
        password: String(pass),
        companydb: String(companyDb),
      }),
    },
    30_000,
  );

  if (!ok || !data?.Token) {
    throw new Error(
      status === 401
        ? 'Login akun ATP gagal — periksa OCS_ATP_USERNAME / OCS_ATP_PASSWORD'
        : `Login akun ATP gagal (HTTP ${status})`,
    );
  }

  atpToken = data.Token;
  const exp = decodeJwtExp(atpToken);
  atpExpiresAt = exp ? exp - 10 * 60_000 : Date.now() + 12 * 3600_000;
  return atpToken;
}

export async function getAtpToken(force = false) {
  if (!force && atpToken && Date.now() < atpExpiresAt) return atpToken;
  if (atpLogin) return atpLogin;
  atpLogin = doAtpLogin().finally(() => { atpLogin = null; });
  return atpLogin;
}

/** Area yang bisa dilihat akun ATP. Inilah daftar cabang yang tersedia. */
export async function fetchAtpAreas() {
  const token = await getAtpToken();
  const claims = decodeJwt(token) || {};
  if (Array.isArray(claims.AREAS) && claims.AREAS.length) return claims.AREAS;

  const { ok, data } = await requestJson(`${baseUrl}/MasterData/GetAreaList`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  }, 20_000);
  return ok && Array.isArray(data) ? data : [];
}

/** GET memakai token akun ATP, dengan percobaan ulang seperti permintaan lain. */
async function atpGet(path, timeoutMs = 120_000, attempts = 3) {
  let lastMessage = 'tidak diketahui';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let transient = false;
    try {
      let token = await getAtpToken();
      let res = await requestJson(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }, timeoutMs);

      if (res.status === 401) {
        token = await getAtpToken(true);
        res = await requestJson(`${baseUrl}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }, timeoutMs);
      }

      if (res.ok) return res.data;

      lastMessage = `HTTP ${res.status}`;
      transient = TRANSIENT_STATUS.has(res.status);
      if (!transient) throw new Error(`GET ${path} gagal (${lastMessage})`);
    } catch (err) {
      if (!transient && !/HTTP \d+/.test(err.message)) {
        lastMessage = err.message;
        transient = true;
      }
      if (!transient) throw err;
    }

    if (attempt === attempts) break;
    const wait = Math.round(2000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
    console.warn(`[ocs-atp] ${path} ${lastMessage}; coba lagi ${attempt + 1}/${attempts} dalam ${wait} ms`);
    await delay(wait);
  }

  throw new Error(`GET ${path} gagal setelah ${attempts} percobaan (${lastMessage})`);
}

/** Stok seluruh cabang: 2.525 SKU x 5 area. */
export async function fetchAtpStock() {
  const data = await atpGet(`/odata/${stockEntity}`);
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Format respons stok ATP tidak dikenali');
  return rows;
}

/** Master SKU beserta brand (ShopCode), bin, barcode, dan kode SAP. */
export async function fetchAtpSkuRack() {
  const data = await atpGet('/MasterData/GetSkuRack', 90_000);
  return Array.isArray(data) ? data : [];
}

/** Definisi bundle beserta komponen dan kuantitasnya. */
export async function fetchAtpBundles() {
  const data = await atpGet('/MasterData/GetBundle', 60_000);
  return Array.isArray(data) ? data : [];
}

export async function testConnection() {
  const started = Date.now();
  const token = await getToken(true);
  const claims = decodeJwt(token) || {};
  return {
    ok: true,
    durationMs: Date.now() - started,
    user: claims.USER_NAME || claims.USER_CODE || null,
    companyDb: claims.COMPANY_DB || null,
    role: claims.ROLE_CODE || null,
    expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
  };
}
