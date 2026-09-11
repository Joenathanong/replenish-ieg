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
import {
  getReplenishSummary,
  searchBySku,
  listDocs,
  getDoc,
  suggestSku,
} from './replenish-query.js';
import { syncReplenish, countPendingDetails } from './replenish.js';
import {
  getAdjustmentSummary,
  getAdjustmentFilterOptions,
  searchAdjustment,
  getAdjustment,
} from './adjustment-query.js';
import { syncAdjustment, countPendingAdjustmentDetails } from './adjustment.js';
import {
  getSalesSummary,
  getSalesOrders,
  getSalesSku,
  getSalesDays,
} from './sales-query.js';
import { syncSalesRange, syncSalesRecent, syncSalesMissing, getSalesCoverage } from './sales.js';
import {
  getAtpDashboard,
  getAtpMaster,
  getBundleDetail,
  setOverride,
  setOverrideBulk,
  getAtpHistory,
} from './atp-query.js';
import {
  syncAtp,
  syncAtpMaster,
  simpanSnapshot,
  listBranches,
  addBranch,
  setBranchActive,
  setBranchGroup,
  deleteBranch,
} from './atp.js';

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
  sales_resync_days: { min: 1, max: 90 },
  atp_threshold: { min: 0, max: 100000 },
  atp_snapshot_hour: { min: 0, max: 23 },
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

/* Excel butuh BOM untuk membaca UTF-8, dan CRLF sebagai pemisah baris. */
const csvBom = '﻿';
const csvEol = '\r\n';

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
  return csvBom + lines.join(csvEol);
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

  // ---------- transaksi replenish ----------

  if (pathname === '/api/replenish/summary' && method === 'GET') {
    return sendJson(res, 200, await getReplenishSummary());
  }

  if (pathname === '/api/replenish/search' && method === 'GET') {
    const q = url.searchParams.get('sku') || '';
    if (!q.trim()) return sendJson(res, 400, { error: 'Parameter sku wajib diisi' });
    return sendJson(res, 200, await searchBySku(q, {
      limit: Number(url.searchParams.get('limit')) || 200,
      from: url.searchParams.get('from') || null,
      to: url.searchParams.get('to') || null,
      // Bawaan: cocok persis. 'contains' hanya bila diminta eksplisit.
      mode: url.searchParams.get('mode') === 'contains' ? 'contains' : 'exact',
    }));
  }

  if (pathname === '/api/replenish/suggest' && method === 'GET') {
    return sendJson(res, 200, await suggestSku(url.searchParams.get('q') || ''));
  }

  if (pathname === '/api/replenish/docs' && method === 'GET') {
    return sendJson(res, 200, await listDocs({
      status: url.searchParams.get('status'),
      search: url.searchParams.get('search'),
      limit: Number(url.searchParams.get('limit')) || 100,
    }));
  }

  if (pathname.startsWith('/api/replenish/doc/') && method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/replenish/doc/'.length));
    const doc = await getDoc(id);
    if (!doc) return sendJson(res, 404, { error: 'Dokumen tidak ditemukan' });
    return sendJson(res, 200, doc);
  }

  if (pathname === '/api/replenish/sync' && method === 'POST') {
    // Batas detail per pemanggilan dibuat kecil di serverless agar muat dalam
    // anggaran waktu function.
    const detailLimit = config.isServerless ? 40 : 300;
    const result = await syncReplenish({ detailLimit });
    return sendJson(res, 200, { ...result, sisaDetail: await countPendingDetails() });
  }

  // ---------- adjustment stok ----------

  if (pathname === '/api/adjustment/summary' && method === 'GET') {
    const [summary, filters] = await Promise.all([
      getAdjustmentSummary(),
      getAdjustmentFilterOptions(),
    ]);
    return sendJson(res, 200, { ...summary, filters });
  }

  if (pathname === '/api/adjustment/search' && method === 'GET') {
    const q = url.searchParams;
    return sendJson(res, 200, await searchAdjustment({
      sku: q.get('sku'),
      mode: q.get('mode') === 'contains' ? 'contains' : 'exact',
      type: q.get('type'),
      shop: q.get('shop'),
      user: q.get('user'),
      area: q.get('area'),
      from: q.get('from'),
      to: q.get('to'),
      remarks: q.get('remarks'),
      limit: Number(q.get('limit')) || 300,
    }));
  }

  if (pathname === '/api/adjustment/export.csv' && method === 'GET') {
    const q = url.searchParams;
    // Batas dinaikkan karena ekspor memang dimaksudkan untuk mengambil semuanya.
    const { rows } = await searchAdjustment({
      sku: q.get('sku'),
      mode: q.get('mode') === 'contains' ? 'contains' : 'exact',
      type: q.get('type'), shop: q.get('shop'), user: q.get('user'), area: q.get('area'),
      from: q.get('from'), to: q.get('to'), remarks: q.get('remarks'),
      limit: 20000,
    });
    const head = ['Waktu', 'No. Transaksi', 'Jenis', 'SKU', 'Qty', 'Keterangan', 'Brand', 'Area', 'Oleh'];
    const lines = [head.join(';')];
    for (const r of rows) {
      lines.push([
        r.created_at, r.transaction_id, r.adj_type, r.seller_sku, r.qty,
        r.remarks, r.shop_code, r.area_id, r.user_code,
      ].map(csvEscape).join(';'));
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    return sendText(res, 200, csvBom + lines.join(csvEol), 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="adjustment-${stamp}.csv"`,
    });
  }

  if (pathname.startsWith('/api/adjustment/trx/') && method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/adjustment/trx/'.length));
    const trx = await getAdjustment(id);
    if (!trx) return sendJson(res, 404, { error: 'Transaksi tidak ditemukan' });
    return sendJson(res, 200, trx);
  }

  if (pathname === '/api/adjustment/sync' && method === 'POST') {
    const detailLimit = config.isServerless ? 500 : 2000;
    const result = await syncAdjustment({ detailLimit });
    return sendJson(res, 200, { ...result, sisaDetail: await countPendingAdjustmentDetails() });
  }

  // ---------- penjualan ----------

  if (pathname === '/api/sales/summary' && method === 'GET') {
    const q = url.searchParams;
    const [ringkasan, cakupan] = await Promise.all([
      getSalesSummary({ from: q.get('from'), to: q.get('to') }),
      getSalesCoverage(),
    ]);
    return sendJson(res, 200, { ...ringkasan, coverage: cakupan });
  }

  if (pathname === '/api/sales/orders' && method === 'GET') {
    const q = url.searchParams;
    return sendJson(res, 200, await getSalesOrders({
      from: q.get('from'), to: q.get('to'),
      area: q.get('area'), platform: q.get('platform'), shop: q.get('shop'),
      status: q.get('status'), groupBy: q.get('groupBy') || 'date',
      limit: Number(q.get('limit')) || 1000,
    }));
  }

  if (pathname === '/api/sales/sku' && method === 'GET') {
    const q = url.searchParams;
    return sendJson(res, 200, await getSalesSku({
      from: q.get('from'), to: q.get('to'),
      area: q.get('area'), platform: q.get('platform'),
      sku: q.get('sku'), mode: q.get('mode') === 'contains' ? 'contains' : 'exact',
      groupBy: q.get('groupBy') || 'sku',
      limit: Number(q.get('limit')) || 500,
    }));
  }

  if (pathname === '/api/sales/days' && method === 'GET') {
    return sendJson(res, 200, await getSalesDays(Number(url.searchParams.get('limit')) || 400));
  }

  if (pathname === '/api/sales/pull' && method === 'POST') {
    const body = await readBody(req);
    const from = String(body.from || '').slice(0, 10);
    const to = String(body.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return sendJson(res, 400, { error: 'Tanggal harus berformat YYYY-MM-DD' });
    }
    if (from > to) return sendJson(res, 400, { error: 'Tanggal awal melewati tanggal akhir' });

    /*
     * Di serverless, rentang panjang tidak akan selesai dalam anggaran waktu
     * function. Dibatasi supaya kegagalannya jelas sejak awal, bukan berupa
     * timeout di tengah jalan yang menyisakan data separuh.
     */
    const hari = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const batas = config.isServerless ? 14 : 400;
    if (hari > batas) {
      return sendJson(res, 400, {
        error: `Rentang ${hari} hari terlalu panjang untuk sekali tarik (maksimum ${batas} hari di lingkungan ini). Pecah menjadi beberapa rentang.`,
      });
    }

    const hasil = await syncSalesRange(from, to);
    return sendJson(res, 200, { ...hasil, coverage: await getSalesCoverage() });
  }

  if (pathname === '/api/sales/fill' && method === 'POST') {
    const body = await readBody(req);
    const from = String(body.from || '').slice(0, 10);
    const to = String(body.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return sendJson(res, 400, { error: 'Tanggal harus berformat YYYY-MM-DD' });
    }
    const hasil = await syncSalesMissing(from, to);
    return sendJson(res, 200, { ...hasil, coverage: await getSalesCoverage() });
  }

  if (pathname === '/api/sales/refresh' && method === 'POST') {
    const hasil = await syncSalesRecent();
    return sendJson(res, 200, { ...hasil, coverage: await getSalesCoverage() });
  }

  // ---------- ATP Monitoring ----------

  if (pathname === '/api/atp/dashboard' && method === 'GET') {
    return sendJson(res, 200, await getAtpDashboard({ shop: url.searchParams.get('shop') || 'ALL' }));
  }

  if (pathname === '/api/atp/master' && method === 'GET') {
    const q = url.searchParams;
    return sendJson(res, 200, await getAtpMaster({
      search: q.get('search'), shop: q.get('shop'), category: q.get('category'),
      branch: q.get('branch'), status: q.get('status'),
      limit: Number(q.get('limit')) || 300,
    }));
  }

  if (pathname.startsWith('/api/atp/bundle/') && method === 'GET') {
    const sku = decodeURIComponent(pathname.slice('/api/atp/bundle/'.length));
    return sendJson(res, 200, await getBundleDetail(sku));
  }

  if (pathname === '/api/atp/override' && method === 'PUT') {
    const body = await readBody(req);
    const sku = String(body.sku || '').trim();
    const branch = String(body.branch || '').trim();
    if (!sku || !branch) return sendJson(res, 400, { error: 'SKU dan cabang wajib diisi' });
    // null mengembalikan keputusan ke OCS.
    const nilai = body.override === null || body.override === undefined ? null : !!body.override;
    return sendJson(res, 200, await setOverride(sku, branch, nilai));
  }

  if (pathname === '/api/atp/override/bulk' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await setOverrideBulk({
      mode: String(body.mode || '').trim(),
      targets: Array.isArray(body.targets) ? body.targets : [],
      source: body.source ? String(body.source).trim() : null,
      aktif: body.aktif === undefined ? null : !!body.aktif,
      filter: {
        search: body.search ?? null,
        shop: body.shop ?? 'ALL',
        category: body.category ?? 'ALL',
      },
    }));
  }

  if (pathname === '/api/atp/history' && method === 'GET') {
    const q = url.searchParams;
    return sendJson(res, 200, await getAtpHistory({
      days: Number(q.get('days')) || 60,
      branch: q.get('branch'), shop: q.get('shop'),
      category: q.get('category'),
    }));
  }

  if (pathname === '/api/atp/branches' && method === 'GET') {
    return sendJson(res, 200, await listBranches());
  }

  if (pathname === '/api/atp/branches' && method === 'POST') {
    const body = await readBody(req);
    if (!String(body.code || '').trim()) return sendJson(res, 400, { error: 'Kode cabang wajib diisi' });
    await addBranch(body);
    return sendJson(res, 200, { ok: true, branches: await listBranches() });
  }

  if (pathname === '/api/atp/branches' && method === 'PUT') {
    const body = await readBody(req);
    const kode = String(body.code || '');
    // Dua hal berbeda lewat satu rute: status aktif, atau pemindahan rumpun.
    if (Object.hasOwn(body, 'groupCode')) await setBranchGroup(kode, body.groupCode);
    if (Object.hasOwn(body, 'active')) await setBranchActive(kode, !!body.active);
    return sendJson(res, 200, { ok: true, branches: await listBranches() });
  }

  if (pathname === '/api/atp/branches' && method === 'DELETE') {
    const code = url.searchParams.get('code');
    if (!code) return sendJson(res, 400, { error: 'Parameter code wajib diisi' });
    try {
      await deleteBranch(code);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    return sendJson(res, 200, { ok: true, branches: await listBranches() });
  }

  if (pathname === '/api/atp/sync' && method === 'POST') {
    return sendJson(res, 200, await (url.searchParams.get('master') === '1' ? syncAtpMaster() : syncAtp()));
  }

  if (pathname === '/api/atp/snapshot' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await simpanSnapshot({ tanggal: body.tanggal || null }));
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
