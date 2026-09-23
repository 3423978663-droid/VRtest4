(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // 状态
  let collected = [];   // [{ word, phonetic, senses:[{partOfSpeech, definitionEn, definitionZh, example}] }]
  let exported = false;
  let images = [];      // [{ id, url, name, nat:{w,h}, words:[], ocr:'pending'|'queued'|'running'|'done'|'error' }]
  let activeId = null;
  let nat = { w: 0, h: 0 };
  let zoom = 1, fitZoom = 1, tx = 0, ty = 0;
  let panning = false, px = 0, py = 0;
  let ocrWorker = null, ocrRunning = false;
  let ocrQueue = [];
  let currentResult = null;
  let currentQuery = null;
  let qrPollTimer = null;
  let editImg = null;
  let editCanvas = null;
  let cropRect = null;
  let cropping = false;
  let cropStart = null;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('script load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  function ensureTesseract() {
    return window.Tesseract ? Promise.resolve() : loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
  }
  function ensureQR() {
    return window.QRCode ? Promise.resolve() : loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
  }

  // ---------- 本地词库（中考/高考/雅思）与后端能力检测 ----------
  let localDictPromise = null;
  let serverFeatures = { qrUpload: false, onlineDict: false };

  function loadLocalDict() {
    if (!localDictPromise) {
      localDictPromise = fetch('/data/dict-3500.json')
        .then((r) => { if (!r.ok) throw new Error('dict load failed'); return r.json(); })
        .then((obj) => obj || {})
        .catch(() => ({}));
    }
    return localDictPromise;
  }

  function normalizeWord(raw) {
    return String(raw || '').trim().toLowerCase();
  }

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

  function localLookupClient(key, dict) {
    let matchedKey = key;
    let entry = dict[key];
    if (!entry) {
      for (const cand of lemmaCandidates(key)) {
        if (dict[cand]) { matchedKey = cand; entry = dict[cand]; break; }
      }
    }
    if (!entry || !Array.isArray(entry.s) || entry.s.length === 0) return null;
    const senses = entry.s.map(([pos, zh]) => ({
      partOfSpeech: pos || '',
      definitionEn: '',
      definitionZh: zh || '',
      example: '',
    }));
    const result = { word: matchedKey, phonetic: entry.p || '', senses, source: 'local' };
    if (matchedKey !== key) result.queryWord = key;
    return result;
  }

  async function detectBackend() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch('/api/info', { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        serverFeatures = Object.assign(serverFeatures, d.features || {});
      }
    } catch (e) {}
    if (!serverFeatures.qrUpload) {
      const qrBtn = $('qrUploadBtn');
      if (qrBtn) qrBtn.style.display = 'none';
    }
  }

  // ---------- 视图切换 ----------
  function showViewer() { $('emptyState').hidden = true; $('viewer').hidden = false; }
  function showEmpty() { $('emptyState').hidden = false; $('viewer').hidden = true; }

  // ---------- 多图管理 ----------
  function activeImage() {
    return images.find((i) => i.id === activeId) || null;
  }

  function newImageId() {
    return 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (!files.length) return;
    const hadActive = activeId;
    const startIndex = images.length;
    files.forEach((f) => {
      const url = URL.createObjectURL(f);
      images.push({
        id: newImageId(),
        url,
        thumbUrl: url,
        name: f.name || '照片',
        nat: { w: 0, h: 0 },
        words: [],
        ocr: 'pending',
        confirmed: false,
      });
    });
    showViewer();
    const firstNew = images[startIndex].id;
    selectImage(hadActive || firstNew);
  }

  function removeImage(id) {
    const idx = images.findIndex((i) => i.id === id);
    if (idx < 0) return;
    for (const u of [images[idx].url, images[idx].thumbUrl]) {
      if (u && u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch (e) {} }
    }
    images.splice(idx, 1);
    if (!images.length) {
      activeId = null;
      showEmpty();
      renderThumbstrip();
      return;
    }
    if (activeId === id) activeId = images[Math.min(idx, images.length - 1)].id;
    selectImage(activeId);
  }

  function selectImage(id) {
    const img = images.find((i) => i.id === id);
    if (!img) return;
    activeId = id;
    showViewer();
    const el = $('image');
    el.onload = () => {
      img.nat = { w: el.naturalWidth || 0, h: el.naturalHeight || 0 };
      if (!img.nat.w || !img.nat.h) return;
      layoutActive();
      if (img.confirmed && img.ocr === 'pending' && !img._prepared) {
        img._prepared = true;
        enqueueOCR(img);
      }
    };
    if (el.src !== img.url) el.src = img.url;
    else if (img.nat && img.nat.w) layoutActive();

    renderWords();
    renderThumbstrip();
    updateOcrStatus();

    if (!img.confirmed) openImageEditor(img);
  }

  function layoutActive() {
    const img = activeImage();
    if (!img || !img.nat || !img.nat.w) return;
    nat.w = img.nat.w;
    nat.h = img.nat.h;
    $('stage').style.width = nat.w + 'px';
    $('stage').style.height = nat.h + 'px';
    $('imgWrap').style.width = nat.w + 'px';
    $('imgWrap').style.height = nat.h + 'px';
    $('image').style.width = nat.w + 'px';
    $('image').style.height = nat.h + 'px';
    fitView();
  }

  function renderThumbstrip() {
    const strip = $('thumbstrip');
    if (!strip) return;
    strip.innerHTML = '';
    images.forEach((img) => {
      const d = document.createElement('div');
      d.className = 'thumb' + (img.id === activeId ? ' active' : '');
      const im = document.createElement('img');
      im.src = img.thumbUrl || img.url;
      im.alt = img.name;
      const del = document.createElement('button');
      del.className = 'thumb-del';
      del.textContent = '×';
      del.title = '删除这张';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeImage(img.id); });
      d.appendChild(im);
      d.appendChild(del);
      d.addEventListener('click', () => selectImage(img.id));
      strip.appendChild(d);
    });
    const add = document.createElement('button');
    add.className = 'thumb-add';
    add.textContent = '＋';
    add.title = '添加图片';
    add.addEventListener('click', () => $('fileInput').click());
    strip.appendChild(add);
  }

  // ---------- 图片加载与压缩 ----------
  function loadImageToCanvas(url, maxDim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const w0 = img.naturalWidth || 1;
        const h0 = img.naturalHeight || 1;
        const scale = Math.min(1, maxDim / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, w, h);
        resolve(c);
      };
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
  }

  function canvasToBlobUrl(c) {
    return new Promise((resolve, reject) => {
      c.toBlob((b) => b ? resolve(URL.createObjectURL(b)) : reject(new Error('blob')), 'image/jpeg', 0.85);
    });
  }

  // ---------- 照片确认 / 旋转 / 裁剪 / 压缩 ----------
  function rotateCanvas90(src, dir) {
    const w = src.width, h = src.height;
    const c = document.createElement('canvas');
    c.width = h; c.height = w;
    const x = c.getContext('2d');
    x.translate(h / 2, w / 2);
    x.rotate(dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    x.drawImage(src, -w / 2, -h / 2);
    return c;
  }

  function drawEdit() {
    const cv = $('editCanvas');
    if (!cv || !editCanvas) return;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, cv.width, cv.height);
    x.drawImage(editCanvas, 0, 0);
    if (cropRect) {
      x.strokeStyle = '#2563eb';
      x.lineWidth = Math.max(2, Math.round(cv.width / 300));
      x.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    }
  }

  function setEditCanvas(c) {
    editCanvas = c;
    cropRect = null;
    cropping = false;
    cropStart = null;
    const cv = $('editCanvas');
    cv.width = c.width;
    cv.height = c.height;
    drawEdit();
  }

  function editPoint(e) {
    const cv = $('editCanvas');
    const r = cv.getBoundingClientRect();
    const cx = e.clientX != null ? e.clientX : e.touches[0].clientX;
    const cy = e.clientY != null ? e.clientY : e.touches[0].clientY;
    const x = Math.min(cv.width, Math.max(0, (cx - r.left) * (cv.width / r.width)));
    const y = Math.min(cv.height, Math.max(0, (cy - r.top) * (cv.height / r.height)));
    return { x, y };
  }

  async function openImageEditor(img) {
    editImg = img;
    $('editModal').hidden = false;
    $('editHint').textContent = '正在读取照片…';
    try {
      const c = await loadImageToCanvas(img.thumbUrl || img.url, 1600);
      setEditCanvas(c);
      $('editHint').textContent = '方向不对就点左转/右转；需要裁边就点“框选裁剪”，然后在图上拖动。';
    } catch (e) {
      $('editHint').textContent = '照片读取失败，请换一张。';
    }
  }

  function rotateEdit(dir) {
    if (!editCanvas) return;
    setEditCanvas(rotateCanvas90(editCanvas, dir));
  }

  function resetEdit() {
    if (!editImg) return;
    openImageEditor(editImg);
  }

  function applyCrop() {
    if (!editCanvas || !cropRect) return;
    const x = Math.round(cropRect.x), y = Math.round(cropRect.y);
    const w = Math.round(cropRect.w), h = Math.round(cropRect.h);
    if (w < 10 || h < 10) { cropRect = null; drawEdit(); return; }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(editCanvas, x, y, w, h, 0, 0, w, h);
    setEditCanvas(c);
    $('cropBtn').textContent = '框选裁剪';
    $('editHint').textContent = '已裁剪，确认没问题就点“确认使用这张照片”。';
  }

  function toggleCrop() {
    if (!editCanvas) return;
    if (cropRect) { applyCrop(); return; }
    cropping = true;
    cropStart = null;
    cropRect = null;
    drawEdit();
    $('cropBtn').textContent = '确认裁剪';
    $('editHint').textContent = '请在图片上拖拽框选要保留的区域。';
  }

  function onEditPointerDown(e) {
    if (!cropping || !editCanvas) return;
    cropStart = editPoint(e);
    cropRect = null;
    drawEdit();
  }

  function onEditPointerMove(e) {
    if (!cropping || !cropStart || !editCanvas) return;
    const p = editPoint(e);
    cropRect = {
      x: Math.min(cropStart.x, p.x),
      y: Math.min(cropStart.y, p.y),
      w: Math.abs(p.x - cropStart.x),
      h: Math.abs(p.y - cropStart.y),
    };
    drawEdit();
  }

  function onEditPointerUp() {
    if (!cropping) return;
    cropping = false;
    cropStart = null;
    if (cropRect && cropRect.w > 10 && cropRect.h > 10) {
      $('editHint').textContent = '已框选区域，点“确认裁剪”生效。';
    } else {
      cropRect = null;
      drawEdit();
      $('editHint').textContent = '框选太小，请重新拖拽。';
    }
  }

  async function confirmEdit() {
    const img = editImg;
    if (!img || !editCanvas) return;
    if (cropRect) applyCrop();
    try {
      const url = await canvasToBlobUrl(editCanvas);
      img.thumbUrl = img.thumbUrl || img.url;
      img.url = url;
      img.nat = { w: editCanvas.width, h: editCanvas.height };
      img.confirmed = true;
      img._prepared = true;
      $('editModal').hidden = true;
      if (img === activeImage()) {
        const el = $('image');
        el.onload = () => layoutActive();
        el.src = url;
      }
      editImg = null; editCanvas = null; cropRect = null; cropping = false;
      enqueueOCR(img);
    } catch (e) {}
  }

  // ---------- 图片缩放与平移 ----------
  function fitView() {
    const area = $('stageArea');
    if (!area) return;
    const availW = area.clientWidth;
    const availH = area.clientHeight;
    if (availW <= 0 || availH <= 0 || nat.w <= 0 || nat.h <= 0) return;
    fitZoom = Math.min(availW / nat.w, availH / nat.h);
    zoom = fitZoom;
    tx = (availW - nat.w * zoom) / 2;
    ty = (availH - nat.h * zoom) / 2;
    updateTransform();
  }

  function updateTransform() {
    $('stage').style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
  }

  function zoomBy(factor) {
    const old = zoom;
    zoom = Math.min(fitZoom * 8, Math.max(fitZoom * 0.4, zoom * factor));
    const area = $('stageArea');
    const cx = area.clientWidth / 2, cy = area.clientHeight / 2;
    const scale = zoom / old;
    tx = cx - (cx - tx) * scale;
    ty = cy - (cy - ty) * scale;
    updateTransform();
  }

  // ---------- OCR ----------
  function setStatus(text) {
    const el = $('ocrStatus');
    if (el) el.textContent = text;
  }

  function updateOcrStatus() {
    const img = activeImage();
    if (!img) return;
    if (img.ocr === 'done') setStatus('已识别 ' + img.words.length + ' 个词，点击单词查词');
    else if (img.ocr === 'running') setStatus('识别中…');
    else if (img.ocr === 'queued') setStatus('排队识别…');
    else if (img.ocr === 'error') setStatus('识别失败，可用手动查词');
    else setStatus('准备识别…');
  }

  async function getOCRWorker() {
    if (ocrWorker) return ocrWorker;
    await ensureTesseract();
    if (!window.Tesseract) throw new Error('tesseract unavailable');
    ocrWorker = await window.Tesseract.createWorker('eng');
    return ocrWorker;
  }

  async function runOCRFor(image) {
    if (!image) return;
    image.ocr = 'running';
    if (image === activeImage()) setStatus('识别中…');
    try {
      const worker = await getOCRWorker();
      const ret = await worker.recognize(image.url);
      image.words = (ret && ret.data && ret.data.words) || [];
      image.ocr = 'done';
      if (image === activeImage()) {
        renderWords();
        setStatus('已识别 ' + image.words.length + ' 个词，点击单词查词');
      }
    } catch (e) {
      image.ocr = 'error';
      if (image === activeImage()) setStatus('识别失败，可用手动查词');
      try { if (ocrWorker) await ocrWorker.terminate(); } catch (_) {}
      ocrWorker = null;
    }
  }

  function enqueueOCR(image) {
    if (!image) return;
    if (image.ocr === 'done' || image.ocr === 'running' || image.ocr === 'queued') return;
    image.ocr = 'queued';
    ocrQueue.push(image);
    pumpOCR();
  }

  async function pumpOCR() {
    if (ocrRunning) return;
    const img = ocrQueue.shift();
    if (!img) return;
    ocrRunning = true;
    await runOCRFor(img);
    ocrRunning = false;
    pumpOCR();
  }

  function renderWords() {
    const overlays = $('overlays');
    overlays.innerHTML = '';
    const img = activeImage();
    if (!img) return;
    for (const w of img.words || []) {
      const text = String(w.text || '').trim();
      if (!/^[A-Za-z][A-Za-z''-]*$/.test(text)) continue;
      if (text.length < 2) continue;
      const b = w.bbox;
      if (!b) continue;
      const d = document.createElement('div');
      d.className = 'word-box';
      d.style.left = b.x0 + 'px';
      d.style.top = b.y0 + 'px';
      d.style.width = (b.x1 - b.x0) + 'px';
      d.style.height = (b.y1 - b.y0) + 'px';
      d.title = text;
      d.addEventListener('click', () => openCard(text));
      overlays.appendChild(d);
    }
  }

  // ---------- 单词卡片 ----------
  async function openCard(word) {
    currentQuery = word;
    currentResult = null;
    $('cardModal').hidden = false;
    $('cardContent').innerHTML = '<div class="loading">正在本地查询…</div>';
    try {
      const dict = await loadLocalDict();
      const local = localLookupClient(normalizeWord(word), dict);
      if (local) {
        currentResult = local;
        renderCard(local);
      } else {
        renderMissingCard(word);
      }
    } catch (e) {
      renderMissingCard(word);
    }
  }

  function renderCard(data) {
    const already = collected.some((x) => x.word.toLowerCase() === data.word.toLowerCase());
    const senses = (data.senses || []).map((s) => `
      <div class="card-sense">
        ${s.partOfSpeech ? `<span class="pos">${esc(s.partOfSpeech)}</span>` : ''}
        <span class="zh">${esc(s.definitionZh || '')}</span>
      </div>`).join('');
    let notes = '';
    if (already) notes += '<div class="card-note">这个词已经在本次收获里了。</div>';
    $('cardContent').innerHTML = `
      <div class="card-head">
        <div class="card-word">${esc(data.word)}</div>
        <span class="card-source">本地词库</span>
      </div>
      ${data.phonetic ? `<div class="card-phonetic">${esc(data.phonetic)}</div>` : ''}
      ${data.queryWord ? `<div class="card-original">原词：${esc(data.queryWord)}</div>` : ''}
      ${senses}
      <div class="card-actions">
        <button class="btn btn-primary" id="addBtn" ${already ? 'disabled' : ''}>${already ? '已加入本次收获' : '加入本次收获'}</button>
      </div>
      ${notes}`;
    if (!already) $('addBtn').addEventListener('click', () => addWord(currentResult));
  }

  function renderMissingCard(word) {
    currentResult = null;
    $('cardContent').innerHTML = `
      <div class="card-head"><div class="card-word">${esc(word)}</div></div>
      <div class="card-note">本地词库里没有这个词。</div>
      <div class="card-actions">
        <button class="btn btn-primary" id="manualRecordBtn">手动记录这个词</button>
        <button class="btn" id="closeMissingBtn">关闭</button>
      </div>`;
    $('manualRecordBtn').addEventListener('click', () => {
      $('cardModal').hidden = true;
      openManualRecord(word);
    });
    $('closeMissingBtn').addEventListener('click', () => { $('cardModal').hidden = true; });
  }

  function openManualRecord(word) {
    $('mrWord').value = word || '';
    $('mrMeaning').value = '';
    $('mrPos').value = '';
    $('manualRecordModal').hidden = false;
    setTimeout(() => $('mrMeaning').focus(), 50);
  }

  function saveManualRecord() {
    const w = String($('mrWord').value || '').trim();
    const zh = String($('mrMeaning').value || '').trim();
    const pos = String($('mrPos').value || '');
    if (!w) { window.alert('请填写单词'); return; }
    if (!zh) { window.alert('请填写中文释义'); return; }
    if (collected.some((x) => x.word.toLowerCase() === w.toLowerCase())) {
      window.alert('这个词已经在本次收获里了。');
      return;
    }
    collected.push({
      word: w,
      phonetic: '',
      senses: [{ partOfSpeech: pos, definitionEn: '', definitionZh: zh, example: '' }],
    });
    renderList();
    $('manualRecordModal').hidden = true;
  }

  function addWord(data) {
    const d = data || currentResult;
    if (!d) return;
    if (collected.some((x) => x.word.toLowerCase() === d.word.toLowerCase())) return;
    collected.push({ word: d.word, phonetic: d.phonetic || '', senses: d.senses || [] });
    renderList();
    const btn = $('addBtn');
    if (btn) { btn.disabled = true; btn.textContent = '已加入本次收获'; }
  }

  // ---------- 本次收获列表 ----------
  function renderList() {
    const ul = $('wordList');
    ul.innerHTML = '';
    $('countBadge').textContent = '本次收获：' + collected.length;
    $('paneCount').textContent = collected.length + ' 个';
    $('exportBtn').disabled = collected.length === 0;
    $('paneEmpty').style.display = collected.length ? 'none' : 'block';

    collected.forEach((item, i) => {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'word-main';
      const senseLines = (item.senses || []).map((s) =>
        `<div class="s">${s.partOfSpeech ? `<span class="pos">${esc(s.partOfSpeech)}</span>` : ''}${esc(s.definitionZh || '')}</div>`
      ).join('');
      main.innerHTML = `<div><span class="w">${esc(item.word)}</span>${item.phonetic ? `<span class="p">${esc(item.phonetic)}</span>` : ''}</div>${senseLines}`;
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除';
      del.addEventListener('click', () => { collected.splice(i, 1); renderList(); });
      li.appendChild(main);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // ---------- PDF 导出（打印另存为 PDF） ----------
  function exportPDF() {
    if (!collected.length) return;
    buildPrintArea();
    window.print();
    exported = true;
  }

  function formatDateTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function buildPrintArea() {
    const area = $('printArea');
    const timeStr = formatDateTime(new Date());
    const rows = collected.map((item, i) => {
      const senseLines = (item.senses || []).map((s) =>
        `<div class="line"><span class="pos">${esc(s.partOfSpeech || '')}</span><span>${esc(s.definitionZh || '')}</span></div>`
      ).join('');
      return `<div class="entry">
        <div class="num">${i + 1}</div>
        <div class="body">
          <div class="head"><span class="word">${esc(item.word)}</span>${item.phonetic ? `<span class="ph">${esc(item.phonetic)}</span>` : ''}</div>
          ${senseLines}
        </div>
      </div>`;
    }).join('');
    area.innerHTML = `
      <div class="pdf-header">
        <span class="pdf-time">${esc(timeStr)}</span>
        <h1>本次收获单词</h1>
        <p>共 ${collected.length} 个</p>
      </div>
      <div class="pdf-list">${rows}</div>`;
  }

  // ---------- 二维码上传 ----------
  async function openQR() {
    if (!serverFeatures.qrUpload) {
      window.alert('当前页面暂不支持「扫码上传」，请直接上传照片，或部署完整版后重试。');
      return;
    }
    $('qrModal').hidden = false;
    const box = $('qrBox');
    box.innerHTML = '<p class="muted">生成中…</p>';
    try {
      await ensureQR();
      if (!window.QRCode) throw new Error('qr unavailable');
      const info = await (await fetch('/api/info')).json();
      const hint = $('qrHint');
      if (hint) {
        const o = String(info.origin || '');
        const isLan = /^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(o);
        hint.textContent = isLan
          ? '请让手机和电脑连同一个 Wi-Fi，再扫码上传。'
          : '手机扫码后拍照上传，电脑端会自动收到并识别。';
      }
      const ses = await (await fetch('/api/session', { method: 'POST' })).json();
      const url = info.origin + '/upload.html?session=' + encodeURIComponent(ses.sessionId);
      box.innerHTML = '';
      new window.QRCode(box, { text: url, width: 220, height: 220, colorDark: '#111827', colorLight: '#ffffff' });
      pollSession(ses.sessionId);
    } catch (e) {
      box.innerHTML = '<p class="muted">二维码生成失败，请刷新重试。</p>';
    }
  }

  function pollSession(id) {
    clearInterval(qrPollTimer);
    qrPollTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/session/' + id);
        const d = await r.json();
        if (d.status === 'ready') {
          clearInterval(qrPollTimer);
          $('qrModal').hidden = true;
          loadRemoteImage('/api/photo/' + id + '?t=' + Date.now());
        }
      } catch (e) {}
    }, 2000);
  }

  function loadRemoteImage(url) {
    const id = newImageId();
    images.push({ id, url, thumbUrl: url, name: '手机上传', nat: { w: 0, h: 0 }, words: [], ocr: 'pending', confirmed: false });
    showViewer();
    selectImage(id);
  }

  // ---------- 事件绑定 ----------
  $('directUploadBtn').addEventListener('click', () => $('fileInput').click());

  $('fileInput').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  $('manualBtn').addEventListener('click', () => {
    const w = $('manualInput').value.trim();
    if (w) openCard(w);
  });
  $('manualInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('manualBtn').click();
  });

  $('qrUploadBtn').addEventListener('click', openQR);
  $('exportBtn').addEventListener('click', exportPDF);
  $('mrSaveBtn').addEventListener('click', saveManualRecord);
  $('manualWordBtn').addEventListener('click', () => {
    const w = (window.prompt('输入要查询的英文单词') || '').trim();
    if (w) openCard(w);
  });

  $('newImageBtn').addEventListener('click', () => $('fileInput').click());

  // 照片确认/旋转/裁剪
  $('rotateLeftBtn').addEventListener('click', () => rotateEdit(-1));
  $('rotateRightBtn').addEventListener('click', () => rotateEdit(1));
  $('cropBtn').addEventListener('click', toggleCrop);
  $('editResetBtn').addEventListener('click', resetEdit);
  $('editConfirmBtn').addEventListener('click', confirmEdit);
  $('editCloseBtn').addEventListener('click', () => {
    $('editModal').hidden = true;
    editImg = null; editCanvas = null; cropRect = null; cropping = false;
  });
  const editCv = $('editCanvas');
  editCv.addEventListener('pointerdown', onEditPointerDown);
  editCv.addEventListener('pointermove', onEditPointerMove);
  editCv.addEventListener('pointerup', onEditPointerUp);
  editCv.addEventListener('pointercancel', onEditPointerUp);

  $('zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('zoomOut').addEventListener('click', () => zoomBy(0.8));
  $('zoomFit').addEventListener('click', fitView);

  $('viewer').addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
  }, { passive: false });

  $('stage').addEventListener('mousedown', (e) => {
    if (zoom <= fitZoom + 0.001) return;
    panning = true;
    px = e.clientX; py = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    tx += e.clientX - px;
    ty += e.clientY - py;
    px = e.clientX; py = e.clientY;
    updateTransform();
  });
  window.addEventListener('mouseup', () => { panning = false; });

  // 手机端拖动平移
  $('stage').addEventListener('touchstart', (e) => {
    if (zoom <= fitZoom + 0.001 || e.touches.length !== 1) return;
    panning = true;
    px = e.touches[0].clientX; py = e.touches[0].clientY;
    e.preventDefault();
  }, { passive: false });
  $('stage').addEventListener('touchmove', (e) => {
    if (!panning || e.touches.length !== 1) return;
    const t = e.touches[0];
    tx += t.clientX - px;
    ty += t.clientY - py;
    px = t.clientX; py = t.clientY;
    updateTransform();
    e.preventDefault();
  }, { passive: false });
  $('stage').addEventListener('touchend', () => { panning = false; });
  $('stage').addEventListener('touchcancel', () => { panning = false; });

  // 拖拽上传（桌面端）
  const pane = $('viewerPane');
  if (pane) {
    ['dragenter', 'dragover'].forEach((ev) => pane.addEventListener(ev, (e) => {
      e.preventDefault();
      pane.classList.add('dragover');
    }));
    ['dragleave', 'dragend'].forEach((ev) => pane.addEventListener(ev, () => pane.classList.remove('dragover')));
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      pane.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
  }

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const k = e.target.getAttribute('data-close');
      if (k === 'card') $('cardModal').hidden = true;
      if (k === 'qr') { $('qrModal').hidden = true; clearInterval(qrPollTimer); }
      if (k === 'manualRecord') $('manualRecordModal').hidden = true;
    });
  });

  window.addEventListener('resize', () => { if (activeImage()) fitView(); });

  window.addEventListener('beforeunload', (e) => {
    if (collected.length && !exported) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  renderThumbstrip();
  detectBackend();
  loadLocalDict(); // 提前加载词库，第一次点词也快
})();
