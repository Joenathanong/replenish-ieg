import { handleApi, sendJson } from '../src/api.js';

/**
 * Satu function untuk seluruh rute /api/*.
 * Vercel meneruskan permintaan ke sini lewat rewrite di vercel.json.
 */
export default async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const url = new URL(req.url, `https://${host}`);
  try {
    await handleApi(req, res, url);
  } catch (err) {
    console.error('[api]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Kesalahan internal' });
  }
}
