import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { config, ROOT } from './config.js';
import { getSettings } from './db.js';
import { handleApi, sendJson, sendText, ensureSchemaOnce } from './api.js';
import { startScheduler, getNextRunAt } from './sync.js';

/**
 * Server untuk mode proses panjang (laptop, VPS, atau Windows Service).
 * Di Vercel, berkas ini tidak dipakai — lihat api/index.js dan api/cron.js.
 */

const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) {
    return sendText(res, 403, 'Terlarang');
  }
  try {
    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    // SPA fallback: rute apa pun yang bukan berkas dikembalikan ke index.html.
    if (!extname(rel)) {
      try {
        const html = await readFile(join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return res.end(html);
      } catch { /* jatuh ke 404 */ }
    }
    sendText(res, 404, 'Tidak ditemukan');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Metode tidak diizinkan');
    }
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Kesalahan internal' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.server.port} sudah dipakai proses lain.`);
    console.error('  Kemungkinan aplikasi ini masih berjalan di jendela lain.');
    console.error(`  Hentikan dulu, atau jalankan dengan port berbeda: PORT=3001 node src/server.js\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n  Tidak punya izin memakai port ${config.server.port}. Coba port di atas 1024.\n`);
  } else {
    console.error('\n  Server gagal dijalankan:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(config.server.port, config.server.host, async () => {
  console.log('');
  console.log('  OCS Replenish Monitor');
  console.log(`  Web        : http://localhost:${config.server.port}`);
  console.log(`  Sumber     : ${config.ocs.baseUrl} (${config.ocs.companyDb})`);
  console.log(`  Database   : TiDB ${config.db.host}/${config.db.database}`);
  console.log(`  Basis      : Qty Rack / QtyGudangKecil`);

  try {
    await ensureSchemaOnce();
    const settings = await getSettings();
    console.log(`  Interval   : ${settings.poll_interval_minutes} menit`);
    console.log(`  Ambang     : ${settings.default_thin_threshold} (default global)`);
    console.log('');
    await startScheduler({ syncOnBoot: true });
    console.log(`[boot] siap. Sinkronisasi berikutnya: ${getNextRunAt() || 'nonaktif'}`);
  } catch (err) {
    console.error('\n  Gagal menyiapkan database:', err.message, '\n');
    process.exit(1);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[shutdown] menutup server...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
