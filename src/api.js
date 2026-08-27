import { config, DEFAULT_SETTINGS } from './config.js';
import { getSettings, setSetting, setThreshold, clearThreshold, ensureSchema } from './db.js';
import {
  getDashboard,
  getItemHistory,
  listThresholds,
  searchItems,
  getSyncHistory,
} from './logic.js';
import {
  runSync,
  isSyncRunning,
  getLastSyncResult,
  getNextRunAt,
  restartScheduler,
  shouldSyncNow,
  estimateNextRunAt,
  getStaleness,
} from './sync.js';
import { testConnection } from './ocs.js';

/** Batas nilai yang boleh disimpan, supaya UI tidak bisa mengirim angka merusak. */
const SETTING_RULES = {
  poll_interval_minutes: { min: 1, max: 1440 },
  default_thin_threshold: { min: 0, max: 1_000_000 },
  show_bundle: { min: 0, max: 1 },
  show_gimmick: { min: 0, max: 1 },
  show_inactive: { min: 0, max: 1 },
  show_clearance: { min: 0, max: 1 },
  replenishable_only: { min: 0, max: 1 },
  hide_safe: { min: 0, max: 1 },
  slide_rows: { min: 3, max: 60 },
  slide_interval_seconds: { min: 3, max: 300 },
  new_item_days: { min: 1, max: 365 },
  auto_sync_enabled: { min: 0, max: 1 },
};

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(text);
}

async function readBody(req, limit = 1_000_000) {
  // Beberapa runtime (termasuk Vercel) sudah mengurai body lebih dulu.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return req.body ? JSON.parse(req.body) : {}; }
      catch { throw new Error('Body bukan JSON yang valid'); }
    }
    return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body terlalu besar');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Body bukan JSON yang valid');
  }
}

/** Ambil override filter dari query string dashboard. */
function dashboardOverrides(url) {
  const q = url.searchParams;
  const overrides = {};
  for (const key of ['status', 'search', 'shop', 'sort']) {
    const v = q.get(key);
    if (v !== null && v !== '') overrides[key] = v;
  }
  // Toggle boleh dipaksa lewat query untuk keperluan tautan/kiosk.
  for (const key of ['show_bundle', 'show_gimmick', 'show_inactive', 'show_clearance', 'replenishable_only', 'hide_safe']) {
    const v = q.get(key);
    if (v !== null && v !== '') overrides[key] = Number(v) ? 1 : 0;
  }
  return overrides;
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(items) {
  const head = [
    'SKU', 'Nama', 'Kategori', 'Brand', 'Status', 'Qty Rack', 'Ambang',
    'Kurang', 'Qty Gudang Besar', 'Saran Transfer', 'Bisa Replenish',
    'Qty On Hand', 'Available', 'Aktif', 'Diperbarui',
  ];
  const lines = [head.join(';')];
  for (const i of items) {
    lines.push([
      i.sku, i.name, i.category, i.shopCode, i.status, i.qtyRack, i.threshold,
      i.shortageQty, i.qtyBulk, i.suggestedQty, i.canReplenish ? 'Ya' : 'Tidak',
      i.qtyOnHand, i.availableQty, i.isActive ? 'Ya' : 'Tidak', i.updatedAt,
    ].map(csvEscape).join(';'));
  }
  return '﻿' + lines.join('\r\n'); // BOM agar Excel membaca UTF-8 dengan benar
}

/**
 * Skema dipastikan ada sekali per instance. Di serverless, invocation dingin
 * pertama yang menanggung biayanya; invocation berikutnya langsung lewat.
 */
let schemaReady = null;
export function ensureSchemaOnce() {
  if (!schemaReady) {
    schemaReady = ensureSchema().catch((err) => {
      schemaReady = null; // biarkan percobaan berikutnya mencoba lagi
      throw err;
    });
  }
  return schemaReady;
}

/** Apakah pemanggil berhak memicu cron. */
export function isAuthorizedCron(req) {
  if (!config.cronSecret) return true; // belum diatur: biarkan (mis. saat uji lokal)
  const header = req.headers?.authorization || '';
  if (header === `Bearer ${config.cronSecret}`) return true;
  const alt = req.headers?.['x-cron-secret'];
  return alt === config.cronSecret;
}

export async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  await ensureSchemaOnce();

  // ---------- status & sinkronisasi ----------

  if (pathname === '/api/status' && method === 'GET') {
    const settings = await getSettings();
    return sendJson(res, 200, {
      running: isSyncRunning(),
      lastSync: getLastSyncResult() ?? (await lastSyncFromLog()),
      // Tanpa penjadwal di proses ini, waktu berikutnya diperkirakan dari catatan database.
      nextRunAt: getNextRunAt() ?? (await estimateNextRunAt()),
      staleness: await getStaleness(),
      autoSync: !!settings.auto_sync_enabled,
      intervalMinutes: settings.poll_interval_minutes,
      serverless: config.isServerless,
      serverTime: new Date().toISOString(),
    });
  }

  if (pathname === '/api/sync' && method === 'POST') {
    const result = await runSync({ trigger: 'manual' });
    if (result.skipped) return sendJson(res, 409, result);
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  // Dipanggil oleh Vercel Cron. Interval sebenarnya diputuskan di sini,
  // bukan oleh ekspresi cron, agar tetap bisa diatur dari halaman Pengaturan.
  if (pathname === '/api/cron' && (method === 'GET' || method === 'POST')) {
    if (!isAuthorizedCron(req)) return sendJson(res, 401, { error: 'Tidak berwenang' });

    const force = url.searchParams.get('force') === '1';
    const gate = force ? { due: true, reason: 'Dipaksa lewat ?force=1' } : await shouldSyncNow();

    if (!gate.due) return sendJson(res, 200, { skipped: true, ...gate });

    const result = await runSync({ trigger: 'cron' });
    return sendJson(res, result.ok === false ? 502 : 200, { ...gate, result });
  }

  if (pathname === '/api/connection-test' && method === 'POST') {
    try {
      return sendJson(res, 200, await testConnection());
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/sync-log' && method === 'GET') {
    return sendJson(res, 200, await getSyncHistory(Number(url.searchParams.get('limit')) || 20));
  }

  // ---------- data dashboard ----------

  if (pathname === '/api/dashboard' && method === 'GET') {
    const data = await getDashboard(dashboardOverrides(url));
    return sendJson(res, 200, {
      ...data,
      status: {
        running: isSyncRunning(),
        lastSync: getLastSyncResult() ?? (await lastSyncFromLog()),
        nextRunAt: getNextRunAt() ?? (await estimateNextRunAt()),
        staleness: await getStaleness(),
      },
    });
  }

  if (pathname === '/api/export.csv' && method === 'GET') {
    const { items } = await getDashboard(dashboardOverrides(url));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return sendText(res, 200, buildCsv(items), 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="replenish-${stamp}.csv"`,
    });
  }

  if (pathname === '/api/history' && method === 'GET') {
    const sku = url.searchParams.get('sku');
    const areaId = url.searchParams.get('areaId') || 'Pusat';
    if (!sku) return sendJson(res, 400, { error: 'Parameter sku wajib diisi' });
    return sendJson(res, 200, await getItemHistory(sku, areaId));
  }

  if (pathname === '/api/items/search' && method === 'GET') {
    return sendJson(res, 200, await searchItems(url.searchParams.get('q') || ''));
  }

  // ---------- pengaturan ----------

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, 200, { settings: await getSettings(), defaults: DEFAULT_SETTINGS });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const applied = {};
    const rejected = [];

    for (const [key, raw] of Object.entries(body)) {
      const rule = SETTING_RULES[key];
      if (!rule) {
        rejected.push({ key, reason: 'Pengaturan tidak dikenal' });
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        rejected.push({ key, reason: 'Nilai harus berupa angka' });
        continue;
      }
      const value = Math.min(rule.max, Math.max(rule.min, Math.trunc(n)));
      await setSetting(key, value);
      applied[key] = value;
    }

    // Di mode proses panjang, interval baru harus dijadwalkan ulang.
    // Di serverless tidak ada penjadwal internal — gerbang di /api/cron yang membacanya.
    if (!config.isServerless && ('poll_interval_minutes' in applied || 'auto_sync_enabled' in applied)) {
      await restartScheduler();
    }

    return sendJson(res, 200, {
      settings: await getSettings(),
      applied,
      rejected,
      nextRunAt: getNextRunAt(),
    });
  }

  // ---------- ambang per item ----------

  if (pathname === '/api/thresholds' && method === 'GET') {
    return sendJson(res, 200, await listThresholds());
  }

  if (pathname === '/api/thresholds' && method === 'PUT') {
    const body = await readBody(req);
    const sku = String(body.sku || '').trim();
    const areaId = String(body.areaId || 'Pusat').trim();
    const value = Number(body.threshold);

    if (!sku) return sendJson(res, 400, { error: 'SKU wajib diisi' });
    if (!Number.isFinite(value) || value < 0) {
      return sendJson(res, 400, { error: 'Ambang harus angka >= 0' });
    }

    await setThreshold(sku, areaId, Math.trunc(value), body.note ? String(body.note).slice(0, 200) : null);
    return sendJson(res, 200, { ok: true, sku, areaId, threshold: Math.trunc(value) });
  }

  if (pathname === '/api/thresholds' && method === 'DELETE') {
    const sku = url.searchParams.get('sku');
    const areaId = url.searchParams.get('areaId') || 'Pusat';
    if (!sku) return sendJson(res, 400, { error: 'Parameter sku wajib diisi' });
    await clearThreshold(sku, areaId);
    return sendJson(res, 200, { ok: true, sku, areaId });
  }

  return sendJson(res, 404, { error: 'Endpoint tidak ditemukan' });
}

/**
 * Di serverless, memori proses tidak bertahan antar invocation, sehingga
 * hasil sinkronisasi terakhir harus dibaca dari tabel log.
 */
async function lastSyncFromLog() {
  const rows = await getSyncHistory(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ok: r.status === 'success',
    trigger: 'log',
    rows: r.row_count,
    newItems: r.new_count,
    durationMs: r.duration_ms,
    finishedAt: r.finished_at,
    ...(r.status === 'error' ? { error: r.message } : {}),
  };
}
