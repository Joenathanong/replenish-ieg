import { handleApi, sendJson } from '../src/api.js';

/**
 * Titik masuk Vercel Cron.
 *
 * Ekspresi cron di vercel.json sengaja dipasang pada frekuensi terhalus yang
 * diizinkan plan Anda. Keputusan "sudah waktunya menarik data atau belum"
 * diambil di dalam aplikasi berdasarkan pengaturan interval di database,
 * sehingga interval tetap bisa diubah dari halaman Pengaturan tanpa deploy ulang.
 */
export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const url = new URL(req.url, `https://${host}`);
  url.pathname = '/api/cron';
  try {
    await handleApi(req, res, url);
  } catch (err) {
    console.error('[cron]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Kesalahan internal' });
  }
}
