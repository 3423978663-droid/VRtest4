// 「阅读背词」本地服务 —— 零 npm 依赖，仅用 Node 内置模块。
// 功能：静态网页 + 二维码会话上传 + 本地词库优先查词 + 联网兜底词典。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const LOCAL_DICT_FILE = path.join(PUBLIC_DIR, 'data', 'dict-3500.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const dictCacheFile = path.join(DATA_DIR, 'dict-cache.json');
let dictCache = {};
try {
  dictCache = JSON.parse(fs.readFileSync(dictCacheFile, 'utf8'));
} catch {}

// 本地词库：中考 + 高考约 3900 词，含音标/词性/中文释义。
let localDict = {};
function loadLocalDict() {
  try {
    localDict = JSON.parse(fs.readFileSync(LOCAL_DICT_FILE, 'utf8'));
    console.log('  本地词库已加载：' + Object.keys(localDict).length + ' 个单词');
  } catch (e) {
    localDict = {};
    console.log('  未找到本地词库（public/data/dict-3500.json），查词将全部走联网。');
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function saveDictCache() {
  try {
    fs.writeFileSync(dictCacheFile, JSON.stringify(dictCache), 'utf8');
  } catch {}
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function getLanIP() {
  const ifaces = os.networkInterfaces();
  const names = Object.keys(ifaces);
  const preferred = names.filter((n) => /^(en|eth|wlan|wi-fi)/i.test(n)).sort();
  const order = preferred.concat(names.filter((n) => !preferred.includes(n)));
  for (const name of order) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !String(iface.address).startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return null;
}

function lanOrigin() {
  const ip = getLanIP();
  return ip ? `http://${ip}:${PORT}` : `http://localhost:${PORT}`;
}

async function fetchWithTimeout(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function myMemoryTranslate(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`;
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error('translate_status_' + r.status);
  const j = await r.json();
  const t = String(j?.responseData?.translatedText || '').trim();
  if (!t || t.toUpperCase().startsWith('MYMEMORY WARNING') || t.toUpperCase().startsWith('NO QUERY')) {
    throw new Error('translate_empty');
  }
  return t;
}

function normalizeWord(raw) {
  return String(raw || '').trim().toLowerCase();
}

// 常见的词形变化回退：点击 running / studies / played 等时，优先找回原形。
function lemmaCandidates(key) {
  const out = [];
  const push = (w) => { if (w && w.length > 1 && w !== key && !out.includes(w)) out.push(w); };
  if (key.endsWith('ies') && key.length > 4) push(key.slice(0, -3) + 'y');
  if (key.endsWith('ing') && key.length > 5) {
    const base = key.slice(0, -3);
    push(base);
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2]) push(base.slice(0, -1));
    push(base + 'e');
  }
  if (key.endsWith('ied') && key.length > 4) push(key.slice(0, -3) + 'y');
  if (key.endsWith('ed') && key.length > 4) {
    const base = key.slice(0, -2);
    push(base);
    push(base + 'e');
  }
  if (key.endsWith('ier') && key.length > 5) push(key.slice(0, -3) + 'y');
  if (key.endsWith('iest') && key.length > 6) push(key.slice(0, -4) + 'y');
  if (key.endsWith('es') && key.length > 3) push(key.slice(0, -2));
  if (key.endsWith('s') && key.length > 3) push(key.slice(0, -1));
  if (key.endsWith('er') && key.length > 4) push(key.slice(0, -2));
  if (key.endsWith('est') && key.length > 5) push(key.slice(0, -3));
  if (key.endsWith('ly') && key.length > 4) push(key.slice(0, -2));
  return out;
}

// 本地命中：把紧凑格式 { p, s:[[pos,zh],...] } 转成前端统一结构。
function localLookup(key) {
  let matchedKey = key;
  let entry = localDict[key];
  if (!entry) {
    for (const cand of lemmaCandidates(key)) {
      if (localDict[cand]) { matchedKey = cand; entry = localDict[cand]; break; }
    }
  }
  if (!entry || !Array.isArray(entry.s) || entry.s.length === 0) return null;
  const senses = entry.s.map(([partOfSpeech, definitionZh]) => ({
    partOfSpeech: partOfSpeech || '',
    definitionEn: '',
    definitionZh: definitionZh || '',
    example: '',
  }));
  const result = { word: matchedKey, phonetic: entry.p || '', senses, source: 'local' };
  if (matchedKey !== key) result.queryWord = key;
  return result;
}

// 联网查词：Free Dictionary（音标/英英释义/例句）+ MyMemory（中文翻译）。
async function onlineLookup(key) {
  if (dictCache[key]) return dictCache[key];

  let phonetic = '';
  let senses = [];

  // 1) 英英释义 / 音标 / 例句：Free Dictionary
  try {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`;
    const r = await fetchWithTimeout(url);
    if (r.ok) {
      const arr = await r.json();
      const entry = Array.isArray(arr) ? arr[0] : null;
      if (entry) {
        phonetic = ((entry.phonetics || []).find((p) => p && p.text) || {}).text || '';
        for (const m of entry.meanings || []) {
          for (const d of m.definitions || []) {
            senses.push({
              partOfSpeech: m.partOfSpeech || '',
              definitionEn: d.definition || '',
              definitionZh: '',
              example: d.example || '',
            });
          }
        }
      }
    }
  } catch {}

  // 2) 中文翻译：MyMemory（整词翻译作为兜底，再对前 3 个词义逐条翻译）
  let wordZh = '';
  try {
    wordZh = await myMemoryTranslate(key);
  } catch {}

  const targets = senses.slice(0, 3);
  await Promise.all(targets.map(async (s) => {
    try {
      s.definitionZh = await myMemoryTranslate(s.definitionEn);
    } catch {
      s.definitionZh = wordZh;
    }
  }));
  for (const s of senses.slice(3)) {
    s.definitionZh = s.definitionZh || wordZh;
  }

  if (senses.length === 0) {
    if (wordZh) {
      senses = [{ partOfSpeech: '', definitionEn: '', definitionZh: wordZh, example: '' }];
    } else {
      throw { status: 404, message: 'not found' };
    }
  }

  const result = { word: key, phonetic, senses, source: 'online' };
  dictCache[key] = result;
  saveDictCache();
  return result;
}

// 本地词库优先；forceOnline 时强制联网，联网失败则回退本地并标记 onlineFailed。
async function lookupWord(raw, opts = {}) {
  const key = normalizeWord(raw);
  if (!key) throw { status: 400, message: 'empty word' };
  if (key.length > 60) throw { status: 400, message: 'word too long' };

  const local = localLookup(key);
  if (!opts.forceOnline && local) return local;

  try {
    const online = await onlineLookup(key);
    if (local && !online.phonetic) online.phonetic = local.phonetic;
    return online;
  } catch (err) {
    if (opts.forceOnline && local) {
      return Object.assign({}, local, { onlineFailed: true });
    }
    throw err;
  }
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function findPhotoFile(sessionDir) {
  try {
    const files = fs.readdirSync(sessionDir);
    const photo = files.find((f) => /^photo\.(jpg|jpeg|png|webp)$/i.test(f));
    return photo || null;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // —— 会话：创建 ——
  if (req.method === 'POST' && pathname === '/api/session') {
    const sessionId = crypto.randomUUID();
    ensureDir(path.join(DATA_DIR, sessionId));
    sendJSON(res, 200, { sessionId });
    return;
  }

  // —— 会话：状态轮询 ——
  if (req.method === 'GET' && pathname.startsWith('/api/session/')) {
    const id = pathname.slice('/api/session/'.length);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { sendJSON(res, 400, { error: 'bad id' }); return; }
    const photo = findPhotoFile(path.join(DATA_DIR, id));
    sendJSON(res, 200, photo
      ? { status: 'ready', photoUrl: `/api/photo/${id}` }
      : { status: 'waiting' });
    return;
  }

  // —— 图片上传（raw 字节）——
  if (req.method === 'POST' && pathname.startsWith('/api/upload/')) {
    const id = pathname.slice('/api/upload/'.length);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { sendJSON(res, 400, { error: 'bad id' }); return; }
    const sessionDir = path.join(DATA_DIR, id);
    ensureDir(sessionDir);
    const contentType = req.headers['content-type'] || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : (contentType.includes('webp') ? 'webp' : 'jpg');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 30 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const old = findPhotoFile(sessionDir);
      if (old) {
        try { fs.unlinkSync(path.join(sessionDir, old)); } catch {}
      }
      const filename = `photo.${ext}`;
      fs.writeFile(path.join(sessionDir, filename), Buffer.concat(chunks), (err) => {
        if (err) { sendJSON(res, 500, { error: 'write failed' }); return; }
        sendJSON(res, 200, { ok: true });
      });
    });
    req.on('error', () => {});
    return;
  }

  // —— 图片读取 ——
  if (req.method === 'GET' && pathname.startsWith('/api/photo/')) {
    const id = pathname.slice('/api/photo/'.length);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { sendJSON(res, 400, { error: 'bad id' }); return; }
    const photo = findPhotoFile(path.join(DATA_DIR, id));
    if (!photo) { sendJSON(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(photo).toLowerCase();
    fs.readFile(path.join(DATA_DIR, id, photo), (err, data) => {
      if (err) { sendJSON(res, 404, { error: 'not found' }); return; }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'image/jpeg' });
      res.end(data);
    });
    return;
  }

  // —— 局域网信息（用于二维码）——
  if (req.method === 'GET' && pathname === '/api/info') {
    sendJSON(res, 200, {
      origin: lanOrigin(),
      features: { qrUpload: true, onlineDict: true },
    });
    return;
  }

  // —— 词典查询：本地优先，online=1 时强制联网 ——
  if (req.method === 'GET' && pathname === '/api/dict') {
    const word = url.searchParams.get('word') || '';
    const forceOnline = url.searchParams.get('online') === '1';
    lookupWord(word, { forceOnline })
      .then((result) => sendJSON(res, 200, result))
      .catch((err) => {
        const status = err && err.status ? err.status : 502;
        sendJSON(res, status, { error: (err && err.message) || 'lookup failed' });
      });
    return;
  }

  // —— 静态文件 ——
  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendJSON(res, 404, { error: 'not found' });
});

ensureDir(DATA_DIR);
loadLocalDict();
server.listen(PORT, () => {
  console.log('');
  console.log('  📖 阅读背词 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  const ip = getLanIP();
  if (ip) console.log('  局域网访问: http://' + ip + ':' + PORT + '   (手机扫码上传请用这个)');
  console.log('');
});
