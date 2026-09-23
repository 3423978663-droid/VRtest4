// 扫码上传会话：创建会话 / 查询照片是否已上传。
const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const STORE_NAME = 'readvocab-sessions';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 照片最多保留 24 小时

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

async function cleanup(store) {
  try {
    let cursor;
    do {
      const res = await store.list({ prefix: 'meta:', cursor });
      const entries = res.entries || res.blobs || [];
      for (const en of entries) {
        try {
          const txt = await store.get(en.key, { type: 'text' });
          const m = JSON.parse(txt || '{}');
          if (Date.now() - (m.createdAt || 0) > MAX_AGE_MS) {
            const id = en.key.slice('meta:'.length);
            await store.delete('meta:' + id);
            await store.delete('photo:' + id);
          }
        } catch (e) {}
      }
      cursor = res.nextCursor || res.cursor;
    } while (cursor);
  } catch (e) {}
}

exports.handler = async (event) => {
  const store = getStore({ name: STORE_NAME });

  if (event.httpMethod === 'POST') {
    const id = crypto.randomUUID();
    await cleanup(store);
    return json(200, { sessionId: id });
  }

  if (event.httpMethod === 'GET') {
    const id = getId(event);
    if (!id) return json(400, { error: 'bad id' });
    const meta = await store.get('meta:' + id, { type: 'text' });
    return json(200, meta
      ? { status: 'ready', photoUrl: '/api/photo/' + encodeURIComponent(id) }
      : { status: 'waiting' });
  }

  return json(405, { error: 'method not allowed' });
};
