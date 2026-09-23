#!/usr/bin/env python3
"""生成 web/public/data/dict-3500.json（中考 + 高考 + 雅思 + 专四 + 专八）。

数据来源（均为开源/公开词库）：
  1. 中考/高考：https://github.com/C3H3-AI/vocab-wordbank
  2. 雅思/专四/专八：https://github.com/kajweb/dict （有道词汇书）
"""
import base64
import io
import json
import os
import re
import ssl
import urllib.request
import zipfile

CTX = ssl._create_unverified_context()
GH_API = 'https://api.github.com/repos/C3H3-AI/vocab-wordbank/contents/wordbanks/'
IELTS_ZIP = 'https://raw.githubusercontent.com/kajweb/dict/master/book/1521164657744_IELTS_2.zip'
LEVEL4_ZIP = 'https://raw.githubusercontent.com/kajweb/dict/master/book/1521164625401_Level4luan_2.zip'
LEVEL8_ZIP = 'https://raw.githubusercontent.com/kajweb/dict/master/book/1521164650006_Level8luan_2.zip'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'dict-3500.json')

MARKERS = ['vt', 'vi', 'adj', 'adv', 'prep', 'conj', 'pron', 'num', 'art', 'int', 'aux', 'abbr', 'det', 'n', 'v', 'a']
POS_RE = re.compile(r'^\s*(%s)\.\s*' % '|'.join(MARKERS))
NEXT_RE = re.compile(r'\s+(?=(?:%s)\.\s+)' % '|'.join(MARKERS))


def http_get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'readvocab-build'})
    return urllib.request.urlopen(req, context=CTX, timeout=120).read()


def fetch_wordbank(name):
    meta = json.loads(http_get(GH_API + name).decode('utf-8'))
    return json.loads(base64.b64decode(meta['content']).decode('utf-8'))['words']


def clean(t):
    t = re.sub(r'\s+', ' ', t or '').strip()
    return re.sub(r'\s*([，。；：、])\s*', r'\1', t)


def preprocess(text):
    text = re.sub(r'\bindefinite\s+article\b', 'art', text or '', flags=re.I)
    text = re.sub(r'\bdefinite\s+article\b', 'art', text, flags=re.I)
    text = re.sub(r'\barticle\b', 'art', text, flags=re.I)
    text = re.sub(r'\[[^\]]*\]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def parse_def(text):
    rest = preprocess(text)
    segs = []
    while rest:
        m = POS_RE.match(rest)
        if not m:
            leftover = clean(rest)
            if leftover:
                if segs:
                    segs[-1][1] = clean(segs[-1][1] + ' ' + leftover)
                else:
                    segs.append(['', leftover])
            break
        pos = m.group(1)
        rest = rest[m.end():]
        nxt = NEXT_RE.search(rest)
        if nxt:
            zh = clean(rest[:nxt.start()])
            rest = rest[nxt.start():]
        else:
            zh = clean(rest)
            rest = ''
        if zh or pos:
            segs.append([pos, zh])
    return segs


def score(z):
    zz = re.sub(r'\s+', '', z)
    return zz.count('；') + zz.count('，') + zz.count('、') * 0.5 + len(zz) * 0.01


def best(variants):
    seen = []
    for v in variants:
        if v not in seen:
            seen.append(v)
    return max(seen, key=score) if seen else ''


def norm(w):
    return str(w or '').strip().lower()


def build_base():
    merged = {}
    order = []

    def add(w, pos, zh):
        w = norm(w)
        if not w:
            return
        if w not in merged:
            merged[w] = {}
            order.append(w)
        pos = (pos or '').strip()
        zh = clean(zh)
        if not pos and not zh:
            return
        merged[w].setdefault(pos, []).append(zh)

    for name in ['junior.json', 'senior.json']:
        for row in fetch_wordbank(name):
            if not isinstance(row, list) or len(row) < 4:
                continue
            w, pos, definition = norm(row[0]), str(row[2] or '').strip(), str(row[3] or '').strip()
            if not w or not definition:
                continue
            full = (pos + '. ' + definition) if pos else definition
            for p, z in parse_def(full):
                add(w, p, z)

    ph = {}
    for name in ['gaokao-3500.json', 'gaokao-michael.json', 'gaokao-24days.json', 'gaokao-core-20days.json', 'primary.json']:
        rows = fetch_wordbank(name)
        for i, row in enumerate(rows):
            if i == 0:
                continue
            if isinstance(row, list) and len(row) >= 2 and row[0] and row[1]:
                key = norm(row[0])
                if key and key not in ph:
                    ph[key] = str(row[1]).strip()

    pos_order = ['n', 'v', 'vt', 'vi', 'adj', 'adv', 'prep', 'conj', 'pron', 'num', 'art', 'int', 'aux', 'det', 'abbr', 'a', '']
    out = {}
    for w in order:
        senses = []
        for pos in pos_order:
            if pos in merged[w]:
                senses.append([pos, best(merged[w][pos])])
        for pos, vals in merged[w].items():
            if pos not in pos_order:
                senses.append([pos, best(vals)])
        out[w] = {'p': ph.get(w, ''), 's': senses}
    return out


def merge_youdao_zip(out, zip_url, inner_name):
    raw = http_get(zip_url)
    zf = zipfile.ZipFile(io.BytesIO(raw))
    data = zf.read(inner_name).decode('utf-8')
    added = 0
    for line in data.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except Exception:
            continue
        word = item.get('content', {}).get('word', {})
        head = norm(word.get('wordHead') or item.get('headWord'))
        if not head:
            continue
        c = word.get('content', {}) or {}
        ph = (c.get('ukphone') or c.get('usphone') or '').strip()
        if ph and not (ph.startswith('[') and ph.endswith(']')):
            ph = '[' + ph + ']'
        senses = []
        for t in c.get('trans') or []:
            pos = (t.get('pos') or '').strip()
            zh = (t.get('tranCn') or '').strip()
            if not pos and not zh:
                continue
            if not any(s[0] == pos for s in senses):
                senses.append([pos, zh])
        if not senses:
            continue
        if head in out:
            if ph and not out[head].get('p'):
                out[head]['p'] = ph
            for pos, zh in senses:
                if not any(s[0] == pos for s in out[head]['s']):
                    out[head]['s'].append([pos, zh])
        else:
            out[head] = {'p': ph, 's': senses}
            added += 1
    return added


def main():
    out = build_base()
    print('中考/高考词条：', len(out))
    print('新增雅思词条：', merge_youdao_zip(out, IELTS_ZIP, 'IELTS_2.json'))
    print('新增专四词条：', merge_youdao_zip(out, LEVEL4_ZIP, 'Level4luan_2.json'))
    print('新增专八词条：', merge_youdao_zip(out, LEVEL8_ZIP, 'Level8luan_2.json'))
    out = {k: out[k] for k in sorted(out)}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('总词条：', len(out), '，含音标：', sum(1 for v in out.values() if v.get('p')))
    print('已写入：', os.path.abspath(OUT))


if __name__ == '__main__':
    main()
