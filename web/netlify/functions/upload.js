// 扫码上传：接收手机拍的照片字节，暂存到 Netlify Blobs。
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'readvocab-sessions';
const MAX_BYTES = 20 * 1024 * 1024;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
}

function getId(event) {
  const q = event.queryStringParameters || {};
  if (q.id && /^[A-Za-z0-9-]{1,64}$/.test(q.id)) return q.id;
  try {
    const u = new URL(event.rawUrl || '');
    const segs = u.pathname.split('/').filter(Boolean);
    const last = decodeURIComponent(segs[segs.length - 1] || '');
    if (last && /^[A-Za-z0-9-]{1,64}$/.test(last)) return last;
  } catch (e) {}
  const raw = decodeURIComponent(String(event.path || '').split('?')[0]);
  const segs = raw.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last && /^[A-Za-z0-9-]{1,64}$/.test(last)) return last;
  return null;
}

function decodeBody(event) {
  if (!event.body) return Buffer.alloc(0);
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64');
  return Buffer.from(event.body, 'utf8');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });
  const id = getId(event);
  if (!id) return json(400, { error: 'bad id' });

  const buf = decodeBody(event);
  if (!buf.length) return json(400, { error: 'empty body' });
  if (buf.length > MAX_BYTES) return json(413, { error: 'photo too large' });

  const rawType = String(event.headers['content-type'] || event.headers['Content-Type'] || 'image/jpeg').toLowerCase();
  const type = rawType.includes('png') ? 'image/png' : rawType.includes('webp') ? 'image/webp' : 'image/jpeg';

  const store = getStore({ name: STORE_NAME });
  await store.set('photo:' + id, buf);
  await store.set('meta:' + id, JSON.stringify({ type, createdAt: Date.now() }));

  return json(200, { ok: true });
};
