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

/** GET terautentikasi dengan satu kali retry setelah re-login bila kena 401. */
async function authedGet(path, timeoutMs = 90_000) {
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

  if (!res.ok) throw new Error(`GET ${path} gagal (HTTP ${res.status})`);
  return res.data;
}

/** Snapshot penuh stok. Dataset ~2.500 baris / 760 KB, jadi tidak perlu paging. */
export async function fetchStock() {
  const data = await authedGet(`/odata/${stockEntity}`);
  const rows = Array.isArray(data) ? data : data?.value;
  if (!Array.isArray(rows)) throw new Error('Format respons OData tidak dikenali');
  return rows;
}

/** Master setting item; dipakai untuk memetakan SKU ke brand (ShopCode). */
export async function fetchItemSettings() {
  const data = await authedGet('/Stock/WmsItemSettings', 60_000);
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
