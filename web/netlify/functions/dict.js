// Netlify Function：联网查词兜底。
// 仅在「本地词库没有该词」时被前端调用，返回结构与本地词库一致。
// 数据来源：Free Dictionary（音标/词性/英文释义/例句）+ MyMemory（中文翻译）。
const cache = new Map();

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  };
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
  const t = String(j && j.responseData && j.responseData.translatedText || '').trim();
  if (!t || t.toUpperCase().startsWith('MYMEMORY WARNING') || t.toUpperCase().startsWith('NO QUERY')) {
    throw new Error('translate_empty');
  }
  return t;
}

async function onlineLookup(key) {
  if (cache.has(key)) return cache.get(key);

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
  } catch (e) {}

  // 2) 中文翻译：MyMemory（整词翻译作为兜底，再对前 3 个词义逐条翻译）
  let wordZh = '';
  try {
    wordZh = await myMemoryTranslate(key);
  } catch (e) {}

  const targets = senses.slice(0, 3);
  await Promise.all(targets.map(async (s) => {
    try {
      s.definitionZh = await myMemoryTranslate(s.definitionEn);
    } catch (e) {
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
  cache.set(key, result);
  return result;
}

exports.handler = async (event) => {
  const word = String((event.queryStringParameters && event.queryStringParameters.word) || '').trim().toLowerCase();
  if (!word) return json(400, { error: 'empty word' });
  if (word.length > 60) return json(400, { error: 'word too long' });

  try {
    const result = await onlineLookup(word);
    return json(200, result);
  } catch (err) {
    const status = err && err.status ? err.status : 502;
    return json(status, { error: (err && err.message) || 'lookup failed' });
  }
};
