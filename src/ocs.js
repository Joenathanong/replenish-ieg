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
