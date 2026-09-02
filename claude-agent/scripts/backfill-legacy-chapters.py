#!/usr/bin/env python3
"""
一次性迁移（2026-09-02）：给 legacy 老书补 book.json 的 chapters 数组。

背景：书架的 collectBooks 这样数章节——
    Array.isArray(b.chapters) ? b.chapters.filter(x => x.status === 'done').length
                              : (Number(b.chaptersCount) || 0)
2026-08-28 归口迁移时，老书只补录了元数据（legacy:true, chaptersCount:0），
于是四本内容完好的老书在书架上一直显示「0 章」。

「现代化」不需要重写内容——现代书（如 little-dragon-china）同样是单页，
差别只在 book.json 有没有 chapters 数组。本脚本从**已发布页面**提取章节
标题与摘要，原文一个字不动。

四本书三种形态，故提取器分三路：
  - why-did-he-sell / bazi : 单页，<section id="ch*">，h2 是章节名
  - tcm-analysis           : 单页，<section id="c1..c8">
  - jingangjing            : 多页书（32 品各一页），首页卡片链接 ./01/ …
                             品用 .t/.d，导读用 h2/p（漏了这条会少一章）

⚠️ legacy:true 必须保留：doPull 靠它硬拒，去掉会被误当成有源稿的书去拉取，
   而这些书的 _src 里除元数据外空无一物。

用法：先把各书首页存成 <slug>.html，跑本脚本得 chapters.json，
     再把 chapters 并进各自 book.json（保留 legacy），wrangler r2 object put 回去。
"""
import re, json

def clean(s):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', s)).strip()

def from_sections(html, id_re, first_fallback='引子'):
    out = []
    for m in re.finditer(r'<section[^>]*id="([^"]+)"[^>]*>(.*?)</section>', html, re.S):
        sid, body = m.group(1), m.group(2)
        if not re.match(id_re, sid):
            continue
        h2 = re.search(r'<h2[^>]*>(.*?)</h2>', body, re.S)
        title = clean(h2.group(1)) if h2 else ''
        ps = [clean(p) for p in re.findall(r'<p[^>]*>(.*?)</p>', body, re.S)]
        ps = [p for p in ps if len(p) > 10]
        brief = ps[0][:100] if ps else ''
        # 无 h2 的开篇段（bazi ch0）：给个「引子」，别留空标题
        if not title:
            title = first_fallback if not out else sid
        out.append({'title': title, 'brief': brief})
    return out

def from_cards(html):
    """多页书首页的卡片链接：.seal=序号 .t=品名 .d=提要；没有 .t 的是 CTA 按钮，跳过"""
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]*href="\./([^"/]+)/"[^>]*>(.*?)</a>', html, re.S):
        part, inner = m.group(1), m.group(2)
        if part in seen or not re.match(r'^(intro|\d+)$', part):
            continue
        # 卡片有两种写法：品用 .t/.d，导读用 h2/p。都不匹配的是 CTA 按钮，跳过。
        t = re.search(r'<div class="t">(.*?)</div>', inner, re.S) or \
            re.search(r'<h2[^>]*>(.*?)</h2>', inner, re.S)
        if not t:
            continue          # CTA「从总导读开始」既无 .t 也无 h2
        seen.add(part)
        seal = re.search(r'class="seal[^"]*">(.*?)</span>', inner, re.S)
        d = re.search(r'<div class="d">(.*?)</div>', inner, re.S) or \
            re.search(r'<p[^>]*>(.*?)</p>', inner, re.S)
        name = clean(t.group(1))
        num = clean(seal.group(1)) if seal else ''
        out.append({'title': f'{num} · {name}' if num else name,
                    'brief': clean(d.group(1))[:100] if d else ''})
    return out

CONF = {
    'why-did-he-sell': lambda h: from_sections(h, r'^ch'),
    'bazi':            lambda h: from_sections(h, r'^ch'),
    'tcm-analysis':    lambda h: from_sections(h, r'^c\d'),
    'jingangjing':     from_cards,
}

result = {}
for slug, fn in CONF.items():
    html = open(f'{slug}.html', encoding='utf-8').read()
    items = fn(html)
    chapters = [{'no': i, 'title': it['title'], 'brief': it['brief'], 'status': 'done'}
                for i, it in enumerate(items, 1)]
    result[slug] = chapters
    print(f'{slug:<18} {len(chapters):>2} 章  首={chapters[0]["title"][:26]!r}  末={chapters[-1]["title"][:26]!r}')

json.dump(result, open('chapters.json', 'w'), ensure_ascii=False, indent=2)
print('\n已写 chapters.json')
