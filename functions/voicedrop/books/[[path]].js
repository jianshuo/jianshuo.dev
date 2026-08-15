// 公开书架：voicedrop.cn/books/<name> → R2 (bucket jianshuo-dev-files)。
//
// EdgeOne 边缘函数把非 /files|/agent|/reco 路径补 /voicedrop 前缀送到 Pages
// （infra/voicedrop-cn-edgeone/edge-function.js），所以这个函数同时服务：
//   https://voicedrop.cn/books/<name>            （干净路径，对外分享用这个）
//   https://jianshuo.dev/voicedrop/books/<name>  （同一函数的原始路径）
//
// 唯一数据源是写书 cloud agent 的 scope（users/<PUBLISHER>/books/）：agent 用
// 自己的用户 token 走 PUT /files/api/upload/books/<slug>/<file>，upload 路由把
// key 锁进调用者 scope，agent 拿不到也不该拿 FILES_TOKEN，所以公开路由迁就写端。
// key 钉死在该 scope 的 books/ 尾段下，桶里其他东西（articles/、WECHAT.json…）
// 够不着，所以不需要 photo 那样的文件类型白名单。
//
// GET /books/        → 书架索引：与 iOS「写书」tab（BooksShelfView.swift）**完全同款**
//                      的实体书书架——两本一排 + 木搁板，第一格是「写书」入口（链到
//                      voicedrop.cn 落地页），有 cover.jpg 铺封面图，没有的用布面缺省
//                      封面（封面色按 slug 哈希稳定分配），书脊/页口/投影一比一复刻。
//                      改这边样式记得同步看 iOS 那份，两边保持一致。
// GET /books/?format=json → 同一份索引的 JSON 版（iOS「写书」tab 图书馆用）：
//                      {books:[{slug,title,main,sub,c,c2,author,cover,chapters,createdAt}]}。
//                      cover = 该书文件夹里有没有 cover.jpg；chapters = 顶层
//                      章节 html 数（排除 index/intro）。
// GET /books/<name>  → 文件本体，inline 展示；html/md/txt 只缓存 5 分钟（书会
//                      反复重发迭代），其余（pdf/图片等大文件）缓存一天。

const PUBLISHER = 'users/anon-ae209ac53499d51d513425503bd134b0/books/';

const TYPES = {
  pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip',
};
const SHORT_CACHE = new Set(['html', 'htm', 'md', 'txt']);

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  let rel = decodeURIComponent(segments.join('/'));
  if (rel.includes('..') || rel.startsWith('/')) return notFound();

  // 索引页：/books 或 /books/（?format=json 给 App 吃结构化数据）
  if (!rel) {
    const wantJSON = new URL(request.url).searchParams.get('format') === 'json';
    return wantJSON ? indexJSON(env) : index(env);
  }

  const fetchKey = (key) => (request.method === 'HEAD' ? env.FILES.head(key) : env.FILES.get(key));
  let obj = await fetchKey(PUBLISHER + rel);
  // 目录路径（/books/<slug> 或 /books/<slug>/，[[path]] 不保留尾斜杠）→ 补 index.html
  if (!obj && !rel.split('/').pop().includes('.')) {
    rel = rel.replace(/\/$/, '') + '/index.html';
    obj = await fetchKey(PUBLISHER + rel);
  }
  if (!obj) return notFound();

  const ext = (rel.split('.').pop() || '').toLowerCase();
  const leaf = rel.split('/').pop();
  const headers = {
    'Content-Type': obj.httpMetadata?.contentType || TYPES[ext] || 'application/octet-stream',
    'Content-Length': String(obj.size),
    // inline：PDF/图片/HTML 浏览器里直接打开；filename* 让「另存为」得到原名（含中文）。
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(leaf)}`,
    'Cache-Control': SHORT_CACHE.has(ext) ? 'public, max-age=300' : 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*',
  };

  // 章节页（<slug>/<非index/intro>.html）注入「听本章」播放器，
  // 音频端点见 functions/voicedrop/books/audiobook/[[path]].js。
  const ch = /^([^/]+)\/(?!index\.|intro\.)([^/]+)\.html?$/.exec(rel);
  if (ch && request.method === 'GET') {
    let html = await obj.text();
    const widget = audioWidget(ch[1], ch[2]);
    html = html.includes('</body>') ? html.replace('</body>', widget + '</body>') : html + widget;
    delete headers['Content-Length'];
    return new Response(html, { headers });
  }

  return new Response(request.method === 'HEAD' ? null : obj.body, { headers });
}

// 「听本章」浮动播放器。相对路径 ../audiobook/<slug>/<stem> 在两个域名下都成立
// （jianshuo.dev/voicedrop/books/... 与 voicedrop.cn/books/...）。
// 首播（R2 无缓存）走边合成边流：能播、不能拖；再播是 R2 mp3：可拖、可倍速。
function audioWidget(slug, stem) {
  const src = `../audiobook/${encodeURIComponent(slug)}/${encodeURIComponent(stem)}`;
  return `
<div id="abw" style="position:fixed;right:18px;bottom:18px;z-index:99">
  <button id="abbtn" style="display:flex;align-items:center;gap:8px;border:1px solid rgba(51,48,42,.18);
    background:#fcf9f1;color:#33302a;border-radius:24px;padding:10px 18px;font-size:14px;
    box-shadow:0 4px 14px rgba(60,45,30,.18);cursor:pointer">🎧 听本章</button>
</div>
<script>
(function(){
  var btn=document.getElementById('abbtn'),box=document.getElementById('abw'),src=${JSON.stringify(src)};
  btn.onclick=function(){
    btn.disabled=true;btn.textContent='准备中…';
    fetch(src,{method:'HEAD'}).then(function(r){return r.ok;}).catch(function(){return false;})
    .then(function(cached){
      box.innerHTML='<div style="background:#fcf9f1;border:1px solid rgba(51,48,42,.18);border-radius:14px;'+
        'padding:10px 14px;box-shadow:0 4px 14px rgba(60,45,30,.18);max-width:78vw">'+
        '<div id="abtip" style="font-size:12px;color:#7a7264;margin-bottom:6px"></div>'+
        '<audio id="abaudio" controls autoplay style="width:300px;max-width:72vw;display:block"></audio></div>';
      var a=document.getElementById('abaudio'),tip=document.getElementById('abtip');
      tip.textContent=cached?'已生成，可拖动进度':'首次播放：边合成边播（此次不能拖动，下次即可）';
      a.src=src;
      a.onerror=function(){tip.textContent='加载失败，刷新重试';};
    });
  };
})();
</script>`;
}

function notFound() {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// 书封样式：竖排题签（主标题）+ 竖排小字副题 + 「建硕」印章，
// 封面色从传统矿物色里按 slug 哈希稳定分配（同一本书永远同一个颜色）。
const PALETTE = [
  ['#33506B', '#263D54'], ['#A04A38', '#7E3626'], ['#3D6B57', '#2C5342'],
  ['#5A4157', '#463043'], ['#40403C', '#2F2F2C'], ['#A67F42', '#8A6730'],
  ['#2E4159', '#223146'], ['#7A4A2E', '#603921'], ['#8A3A4A', '#6E2C39'],
  ['#5A6B3D', '#47552E'], ['#35597E', '#284664'],
];
const colorOf = (slug) => {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.codePointAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
};
// 主副题拆分：在 ——／：／· 处断开，题签只放主题，副题竖排在封面右侧。
const splitTitle = (t) => {
  for (const sep of ['——', '—', '：', ':', ' · ', '·']) {
    const i = t.indexOf(sep);
    if (i > 1) return [t.slice(0, i).trim(), t.slice(i + sep.length).trim()];
  }
  return [t.trim(), ''];
};

/// 书架数据：一个 delimiter listing 拿书的文件夹（delimitedPrefixes），再逐本读
/// <slug>/index.html 的 <title> 当书名。必须 cursor 翻页：R2 的 delimited list 按
/// 「扫过的 key 数」截断，不是按返回的前缀数（admin/llm 页曾因此冻在 2026-07-13）。
async function collectBooks(env) {
  const slugs = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: PUBLISHER, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
    slugs.push(...(listed.delimitedPrefixes || []).map((p) => p.slice(PUBLISHER.length).replace(/\/$/, '')).filter(Boolean));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 书名 = <slug>/index.html 的 <title>；作者 = 同页 <meta name="author">（写书
  // skill 2026-08-11 起按提交者署名输出；没有此 meta 的存量书都是建硕的）。
  // 诞生时间 = 夹内最早的 uploaded（书会反复重发迭代，index.html 的 uploaded 会
  // 跟着刷新；最早的那个文件基本不动，当创建时间最稳）。同一次全量列举顺手数出
  // cover.jpg 有无 + 顶层章节 html 数（index/intro 不算章），HTML 和 JSON 共用。
  const books = await Promise.all(slugs.map(async (slug) => {
    let title = slug, author = '', createdAt = 0, cover = false, chapters = 0;
    try {
      const obj = await env.FILES.get(`${PUBLISHER}${slug}/index.html`);
      if (obj) {
        const html = await obj.text();
        const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        if (m && m[1].trim()) title = m[1].trim();
        const a = /<meta\s+name="author"\s+content="([^"]*)"/i.exec(html);
        if (a && a[1].trim()) author = a[1].trim().slice(0, 20);
      }
      let cursor;
      do {
        const listed = await env.FILES.list({ prefix: `${PUBLISHER}${slug}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const o of listed.objects || []) {
          const t = new Date(o.uploaded).getTime();
          if (t && (!createdAt || t < createdAt)) createdAt = t;
          const rel = o.key.slice(PUBLISHER.length + slug.length + 1);
          if (rel.includes('/')) continue;                     // 只看顶层文件
          const leaf = rel.toLowerCase();
          if (leaf === 'cover.jpg') cover = true;
          else if (/\.html?$/.test(leaf) && leaf !== 'index.html' && leaf !== 'intro.html') chapters++;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } catch {}
    const [main, sub] = splitTitle(title);
    const [c, c2] = colorOf(slug);
    return { slug, title, main, sub, c, c2, author, cover, chapters, createdAt };
  }));
  // 时间倒序：最新的书在最前面（同龄兜底按书名，保证顺序稳定）。
  books.sort((a, b) => (b.createdAt - a.createdAt) || String(a.title).localeCompare(String(b.title), 'zh'));
  return books;
}

/// JSON 索引（iOS 图书馆）。cover / chapters / createdAt 已在 collectBooks 里
/// 随全量列举一并算好，这里直接吐。
async function indexJSON(env) {
  const books = await collectBooks(env);
  return new Response(JSON.stringify({ books }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 与 iOS BooksShelfView.swift 一比一：色值 / 圆角 / 间距 / 阴影都从那边抄，
// 改任何一边都要同步另一边。SwiftUI shadow(radius:r) ≈ CSS blur 2r。
async function index(env) {
  const books = await collectBooks(env);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const metaLine = (b) => (b.chapters > 0 ? `${b.chapters} 章` : (b.sub ? esc(b.sub) : '&nbsp;'));

  const bookCell = (b) => {
    const href = `/books/${encodeURI(b.slug)}/`;
    const face = b.cover
      ? `<img src="${href}cover.jpg" alt="" loading="lazy">`
      : `<span class="cloth"><b>${esc(b.main)}</b><i></i>${b.sub ? `<small>${esc(b.sub)}</small>` : ''}</span>`;
    return `<a class="cell" href="${href}" title="${esc(b.title)}">` +
      `<span class="cover" style="--c:${b.c};--c2:${b.c2}">${face}<i class="spine"></i><i class="edge"></i></span>` +
      `<span class="cap"><b>${esc(b.main)}</b><small>${metaLine(b)}</small></span></a>`;
  };
  // 第一格固定是「写书」入口（App 里开 BookWritingSheet，网页上进 VoiceDrop 落地页）。
  const writeCell = `<a class="cell" href="/">` +
    `<span class="coverW"><span class="plus">+</span><span class="wz">写书</span></span>` +
    `<span class="cap"><b>写一本新书</b><small>&nbsp;</small></span></a>`;

  const cells = [writeCell, ...books.map(bookCell)];
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<div class="row">${cells[i]}${cells[i + 1] || '<span></span>'}</div><div class="shelfbar"></div>`);
  }

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>书架 · VoiceDrop</title>
<style>
  /* 逐项对应 BooksShelfView.swift：appBG FAF6EF / ink 2A2521 / metaChrome A89E8E /
     recordRed E5392E / 奶油白 F7F1DF / 搁板 E3D7C2→C9B99E */
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{margin:0;background:#FAF6EF;color:#2A2521;
    font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:440px;margin:0 auto;padding:6px 20px 44px}
  /* minmax(0,1fr)：1fr 的隐式 min-content 下限会被 nowrap 长书名撑破列宽
     （封面按 0.7 比例跟着变高，同排两本高矮不一），钉死为 0 让 ellipsis 生效。 */
  .row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:22px;align-items:start}
  .cell{display:block;text-decoration:none;-webkit-tap-highlight-color:transparent}
  .cover,.coverW{position:relative;display:block;aspect-ratio:0.7;overflow:hidden;
    border-radius:2px 5px 5px 2px}
  .cover{background:linear-gradient(135deg,var(--c),var(--c2));
    box-shadow:0 7px 16px rgba(60,45,30,.35),0 2px 4px rgba(60,45,30,.20)}
  .cover::before{content:"";position:absolute;inset:0;pointer-events:none;
    background:radial-gradient(190px at 25% 15%,rgba(255,255,255,.10),transparent)}
  .cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .cloth{position:absolute;inset:0;padding:26px 16px 0 24px;display:block}
  .cloth b{display:block;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:22px;font-weight:700;letter-spacing:3px;line-height:1.36;color:#F7F1DF;
    text-shadow:0 1px 3px rgba(0,0,0,.35)}
  .cloth i{display:block;width:26px;height:1px;background:rgba(247,241,223,.55);margin:9px 0}
  .cloth small{display:block;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:11.5px;line-height:1.55;color:rgba(247,241,223,.72)}
  .spine{position:absolute;inset:0 auto 0 0;width:13px;pointer-events:none;
    background:linear-gradient(90deg,rgba(0,0,0,.36) 0,rgba(0,0,0,.10) 55%,rgba(255,255,255,.12) 100%)}
  .edge{position:absolute;inset:0 0 0 auto;width:3px;pointer-events:none;
    background:repeating-linear-gradient(180deg,rgba(255,255,255,.85) 0 1px,rgba(214,202,180,.9) 1px 2px)}
  .coverW{background:#F3ECE0;border:1.5px dashed #CFC0A6;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px}
  .plus{width:34px;height:34px;border-radius:50%;background:#E5392E;color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;
    line-height:1;box-shadow:0 3px 9px rgba(229,57,46,.30)}
  .wz{font-size:15px;font-weight:600;letter-spacing:1px;color:#6F685D}
  .cap{display:block;margin-top:9px}
  .cap b{display:block;font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:14.5px;font-weight:600;color:#2A2521;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cap small{display:block;margin-top:2px;font-size:12.5px;color:#A89E8E;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .shelfbar{height:6px;border-radius:1px;margin:8px -6px 14px;
    background:linear-gradient(#E3D7C2,#C9B99E);
    box-shadow:0 3px 7px rgba(120,95,60,.18)}
</style></head>
<body><main>
${rows.join('\n')}
</main></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
