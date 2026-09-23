// 读取扫码上传的照片，返回给电脑端浏览器显示。
const { connectLambda, getStore } = require('@netlify/blobs');

const STORE_NAME = 'readvocab-sessions';

function error(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body, isBase64Encoded: false };
}
function binary(statusCode, base64, headers) {
  return { statusCode, headers: headers || {}, body: base64, isBase64Encoded: true };
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return error(405, 'method not allowed');
  const id = getId(event);
  if (!id) return error(400, 'bad id');

  connectLambda(event);
  const store = getStore({ name: STORE_NAME });
  const metaText = await store.get('meta:' + id, { type: 'text' });
  if (!metaText) return error(404, 'not found');

  let type = 'image/jpeg';
  try { type = JSON.parse(metaText).type || type; } catch (e) {}

  const buf = await store.get('photo:' + id, { type: 'arrayBuffer' });
  if (!buf) return error(404, 'not found');

  return binary(200, Buffer.from(buf).toString('base64'), {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
};
