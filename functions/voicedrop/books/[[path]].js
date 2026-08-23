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
import { bearerToken, verifySession, anonScopeFromToken } from '../../lib/auth.js';
// key 钉死在该 scope 的 books/ 尾段下，桶里其他东西（articles/、WECHAT.json…）
// 够不着，所以不需要 photo 那样的文件类型白名单。
//
// GET /books/        → 书架索引：与 iOS「写书」tab（BooksShelfView.swift）**完全同款**
//                      的实体书书架——两本一排 + 木搁板，第一格是「写书」入口（链到
//                      voicedrop.cn 落地页），有 cover.jpg 铺封面图，没有的用布面缺省
//                      封面（封面色按 slug 哈希稳定分配），书脊/页口/投影一比一复刻。
//                      改这边样式记得同步看 iOS 那份，两边保持一致。
//                      网页版另加：顶部类目导航（六词：商业/身心/人文/投资/AI/故事，
//                      样式对齐社区 tabRow）+ 书名下类目小标签；iOS 暂无此导航。
// GET /books/?format=json → 同一份索引的 JSON 版（iOS「写书」tab 图书馆用）：
//                      {books:[{slug,title,main,sub,c,c2,author,cover,coverAt,chapters,createdAt}]}。
//                      coverAt = cover.jpg 的上传时间戳，书架 <img> 用它当 ?v= 破缓存。
//                      cover = 该书文件夹里有没有 cover.jpg；chapters = 顶层
//                      章节 html 数（排除 index/intro）。
// GET /books/<name>  → 文件本体，inline 展示；html/md/txt 只缓存 5 分钟（书会
//                      反复重发迭代），其余（pdf/图片等大文件）缓存一天。

const PUBLISHER = 'users/anon-ae209ac53499d51d513425503bd134b0/books/';

// 类目（2026-08-17 定的六个词）：书架导航 + 每本书的标签。
// 新书优先读自己 index.html 里的 <meta name="category" content="…">（写书 skill
// 以后可自报类目）；没有的落到这张手工映射表；两边都没有就不挂标签、只出现在「全部」。
const CATEGORY_ORDER = ['商业', '身心', '人文', '投资', 'AI', '故事'];
const CATEGORY_OF = (() => {
  const groups = {
    商业: ['who-actually-sees-your-post', 'us-tax-machine', 'zhu-rongji-the-engineer',
      'dragon-restaurant-as-a-system', 'beauty-store-growth-flywheel', 'the-memory-titan',
      'musk-slogan-or-cash', 'miners-neocloud-gambit', 'hynix-survivor-saga',
      'microsoft-buy-and-not-build', 'oracle-cloud-gamble', 'software-survivors-2000',
      'positive-marginal-cost', 'software-empires', 'us-software-history'],
    身心: ['dont-wait-for-retirement', 'sitting-still-mechanism', 'judgment', 'zhengji-xinfa',
      'yandu-jizhu', 'action-first', 'energy-thread', '400-gram-fast', 'walking-home',
      'the-god-you-build', 'sleep-drift', 'entropy'],
    人文: ['nordic-shaped-by-ice-and-sea', 'art-as-human-evidence',
      'higashino-keigo-engineering-mystery', 'homer-odyssey-for-moviegoers', 'nanfeng-xizhou',
      'secret-banquet-kitchen', 'troy-luoyang-order-collapse', 'japan-countryside-philosophy',
      'tcm-analysis', 'bazi', 'jingangjing'],
    投资: ['pm-edge-in-markets', 'reading-a-company-google-buffett', 'how-money-moves', 'jingzu',
      'stock-101', 'why-did-he-sell', 'options-trading', 'market-cap', 'money'],
    AI: ['the-line-ai-cant-cross', 'why-your-major-lied', 'pm-full-stack-ai', 'beyond-code',
      'dev-leverage', 'shoucuo-llm'],
    故事: ['meow-team-saves-the-moon', 'backflow-shanghai-flood', 'mountain-night-letters',
      'meow-squad-resilience', 'aetheria', 'tangmusan'],
  };
  const map = {};
  for (const [cat, slugs] of Object.entries(groups)) for (const s of slugs) map[s] = cat;
  return map;
})();

const TYPES = {
  pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip',
};

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
    return wantJSON ? indexJSON(env, request) : index(env);
  }

  // 整本书打印视图（/books/<slug>/print）：封面+导读+全部章节拼一页、分页 CSS、
  // 无导航件——worker 的 Browser Rendering 用它渲染 PDF（走 pages.dev 域名绕 1042）。
  const pr = /^([^/]+)\/print$/.exec(rel);
  if (pr) return printView(env, pr[1]);

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
    // 所有可被替换重传的文件（HTML/图片/cover）都走短缓存——曾因 1 天缓存把换错的封面钉在
    // 边缘一整天（2026-08-16），又因 1 天缓存让重画的绘本页图钉住旧版（2026-08-18），别改回长缓存。
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': '*',
  };

  // 目录页（<slug>/index.html）注入「下载 PDF」链接——端点在 agent worker
  // /agent/books/pdf/<slug>（没有就现生成，有了直接下载）。绝对地址：voicedrop.cn
  // 的 EdgeOne 反代不认 /agent 路径。
  const bi = /^([^/]+)\/index\.html$/.exec(rel);
  if (bi && request.method === 'GET') {
    let html = await obj.text();
    const pdfLink = `<div style="text-align:center;margin:26px 0 40px"><a href="https://jianshuo.dev/agent/books/pdf/${encodeURIComponent(bi[1])}" style="font-size:13px;color:#A89E8E;text-decoration:none;border:1px solid rgba(51,48,42,.18);border-radius:20px;padding:8px 18px">⬇ 下载 PDF 版（首次点击需生成约一分钟）</a></div>`;
    html = html.includes('</body>') ? html.replace('</body>', pdfLink + '</body>') : html + pdfLink;
    delete headers['Content-Length'];
    return new Response(html, { headers });
  }

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
// 已缓存：<audio> 直连 R2 mp3（可拖、可倍速）。
// 首播（边合成边流）：不能把 chunked 流直接塞给 <audio>.src——流结束、时长从未知
// 变已知的那一刻，浏览器会把播放位置重置回 0（实测「全部生成完就跳回最开始」）。
// 改用 (Managed)MediaSource：fetch 读流、SourceBuffer 逐块喂，收完 endOfStream()
// 定格时长，播放位置不动。不支持 MSE 的浏览器（老 iOS Safari）兜底为
// 「先生成显示进度、生成完直接播 R2 缓存」，同样没有跳回问题。
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

  function panel(tipText){
    box.innerHTML='<div style="background:#fcf9f1;border:1px solid rgba(51,48,42,.18);border-radius:14px;'+
      'padding:10px 14px;box-shadow:0 4px 14px rgba(60,45,30,.18);max-width:78vw">'+
      '<div id="abtip" style="font-size:12px;color:#7a7264;margin-bottom:6px"></div>'+
      '<audio id="abaudio" controls style="width:300px;max-width:72vw;display:block"></audio></div>';
    document.getElementById('abtip').textContent=tipText;
    var a=document.getElementById('abaudio');
    a.onerror=function(){document.getElementById('abtip').textContent='加载失败，刷新重试';};
    return a;
  }

  // 边合成边播：fetch 流 → SourceBuffer 逐块 append，结束 endOfStream 定格时长。
  // 背压（2026-08-24 修「首播尾部错乱」）：合成远快于播放，整章一股脑 append 会把
  // SourceBuffer 配额撑爆（Chromium 实测 ~7.7MB、iOS 更小），appendBuffer 抛
  // QuotaExceededError——旧代码把已出队的块静默扔掉，尾部就缺块跳接。现在：
  // ①失败不出队（append 成功才 shift）；②超前播放点 60 秒就停喂，数据留在 JS
  // 内存队列（无配额），靠 timeupdate 续喂；③配额仍满时清掉已播段再等重试。
  function playStreaming(MS){
    var a=panel('首次播放：边合成边播（此次不能拖动，下次即可）');
    var ms=new MS();
    if('disableRemotePlayback' in a) a.disableRemotePlayback=true;  // ManagedMediaSource 要求
    a.src=URL.createObjectURL(ms);
    ms.addEventListener('sourceopen',function(){
      var sb=ms.addSourceBuffer('audio/mpeg');
      var queue=[],done=false,busy=false,AHEAD=60;
      function ahead(){
        try{if(sb.buffered.length) return sb.buffered.end(sb.buffered.length-1)-a.currentTime;}catch(e){}
        return 0;
      }
      function pump(){
        if(busy||sb.updating) return;
        if(queue.length){
          if(ahead()>AHEAD) return;                       // 缓冲够超前了，等 timeupdate 再喂
          busy=true;
          try{sb.appendBuffer(queue[0]);queue.shift();}   // 成功才出队，失败块不丢
          catch(e){
            busy=false;
            // 配额满：清掉已播过的段腾地方，updateend 后自动重试
            try{if(a.currentTime>30){busy=true;sb.remove(0,a.currentTime-15);}}catch(e2){}
          }
        }
        else if(done&&ms.readyState==='open'){try{ms.endOfStream();}catch(e){}}
      }
      sb.addEventListener('updateend',function(){busy=false;pump();});
      a.addEventListener('timeupdate',pump);
      fetch(src).then(function(r){
        if(!r.ok) throw 0;
        var rd=r.body.getReader();
        (function step(){rd.read().then(function(x){
          if(x.done){done=true;pump();return;}
          queue.push(x.value);pump();step();
        }).catch(function(){done=true;pump();});})();
      }).catch(function(){document.getElementById('abtip').textContent='生成失败，刷新重试';});
    },{once:true});
    a.play().catch(function(){});
  }

  // 无 MSE 兜底：先拉完整个流（显示生成进度），生成完直接播 R2 缓存版。
  function generateThenPlay(){
    var a=panel('正在生成本章音频…');
    var tip=document.getElementById('abtip');
    fetch(src).then(function(r){
      if(!r.ok) throw 0;
      var rd=r.body.getReader(),got=0;
      function step(){return rd.read().then(function(x){
        if(x.done) return;
        got+=x.value.length;
        tip.textContent='正在生成 '+Math.round(got/1024)+' KB…';
        return step();
      });}
      return step();
    }).then(function(){
      tip.textContent='已生成，可拖动进度';
      a.src=src;a.play().catch(function(){});
    }).catch(function(){tip.textContent='生成失败，刷新重试';});
  }

  btn.onclick=function(){
    btn.disabled=true;btn.textContent='准备中…';
    fetch(src,{method:'HEAD'}).then(function(r){return r.ok;}).catch(function(){return false;})
    .then(function(cached){
      if(cached){
        var a=panel('已生成，可拖动进度');
        a.src=src;a.play().catch(function(){});
        return;
      }
      var MS=window.ManagedMediaSource||window.MediaSource;
      if(MS&&MS.isTypeSupported&&MS.isTypeSupported('audio/mpeg')) playStreaming(MS);
      else generateThenPlay();
    });
  };
})();
</script>`;
}

// ---------- 整本书打印视图（PDF 渲染源）----------
// 保真原则（2026-08-23 v2）：**原样复用章节页自带的 <style>**（build.mjs 那套淡雅
// 界面——纸底、衬线标题、accent 色、引用块），PDF 和网页同一套字体颜色；只叠加
// 分页规则。每章取「meta 行 + 标题 + <article> 正文」，导航件/播放器/页脚不进。
// <base> 指向 pages.dev：相对图片路径在 Browser Rendering 里可加载（1042 规避）。
async function printView(env, slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return notFound();
  let book = null;
  try {
    const o = await env.FILES.get(`${PUBLISHER}${slug}/_src/book.json`);
    if (o) book = JSON.parse(await o.text());
  } catch {}

  const page = async (file) => {
    const o = await env.FILES.get(`${PUBLISHER}${slug}/${file}`);
    return o ? await o.text() : null;
  };
  const pick = (html, re) => (re.exec(html) || [])[0] || '';
  const grabArticle = (html) => pick(html, /<article[^>]*>[\s\S]*?<\/article>/i);

  // 章节清单：book.json 优先；老书（无 _src）扫 R2 里的 NN.html
  let files = [];
  let title = String(book?.title ?? '');
  if (book?.chapters?.length) {
    files = book.chapters.filter((c) => c.status === 'done').map((c) => `${String(c.no).padStart(2, '0')}.html`);
  } else {
    const listed = await env.FILES.list({ prefix: `${PUBLISHER}${slug}/`, limit: 200 });
    files = (listed.objects || [])
      .map((o) => o.key.slice(`${PUBLISHER}${slug}/`.length))
      .filter((f) => /^\d\d\.html$/.test(f))
      .sort();
  }
  if (!files.length) return notFound();

  // 逐章取原页面片段；站点 CSS 从第一张有效章节页原样搬来
  let siteCss = '';
  const sections = [];
  for (const f of files) {
    const html = await page(f);
    if (!html) continue;
    if (!siteCss) siteCss = pick(html, /<style>[\s\S]*?<\/style>/i);
    const body = pick(html, /<p class="meta">[\s\S]*?<\/p>/i) + pick(html, /<h1[^>]*>[\s\S]*?<\/h1>/i) + grabArticle(html);
    if (body) sections.push(`<section class="chapter">${body}</section>`);
  }
  if (!sections.length) return notFound();
  const introHtml = await page('intro.html');
  const intro = introHtml
    ? pick(introHtml, /<h1[^>]*>[\s\S]*?<\/h1>/i) + pick(introHtml, /<p class="sub">[\s\S]*?<\/p>/i) + grabArticle(introHtml)
    : '';
  if (!title) {
    const idx = await page('index.html');
    if (idx) title = ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(idx) || [])[1] || slug).split('·')[0].trim();
  }
  if (!siteCss) siteCss = '<style>body{font-family:-apple-system,"PingFang SC",sans-serif;color:#2A2521;line-height:1.85}</style>';

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<base href="https://jianshuo-dev.pages.dev/voicedrop/books/${encodeURIComponent(slug)}/">
<title>${esc(title || slug)}</title>
${siteCss}
<style>
  /* 打印叠加：只管分页与纸面，观感全部沿用上面的站点样式 */
  @page { size: A4; margin: 16mm 14mm; }
  body { background: var(--paper, #FAF6EF); min-height: auto; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 0; }
  .chapter { page-break-before: always; }
  .cover { page-break-after: always; text-align: center; padding-top: 290px; min-height: 900px; }
  .cover h1 { font-size: 40px; }
  .cover .sub { font-size: 17px; margin-top: 14px; }
  .cover .author { margin-top: 34px; color: var(--ink-soft, #7a7264); font-size: 15px; }
  .cover .tag { margin-top: 120px; color: var(--ink-soft, #7a7264); font-size: 12.5px; }
  h1, h2, h3 { page-break-after: avoid; }
  article img, article figure, article blockquote, .plain { page-break-inside: avoid; }
</style></head><body><div class="wrap">
<div class="cover">
  <h1>${esc(title || slug)}</h1>
  ${book?.subtitle ? `<p class="sub">${esc(book.subtitle)}</p>` : ''}
  ${book?.author ? `<p class="author">${esc(book.author)}</p>` : ''}
  ${book?.tagline || book?.meta ? `<p class="tag">${esc(book.tagline || book.meta)}</p>` : ''}
</div>
${intro ? `<section class="chapter">${intro}</section>` : ''}
${sections.join('\n')}
<div class="foot">${esc(title || slug)}${book?.author ? ' · ' + esc(book.author) : ''}</div>
</div></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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
async function collectBooks(env, viewerScope = '') {
  const slugs = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: PUBLISHER, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
    slugs.push(...(listed.delimitedPrefixes || []).map((p) => p.slice(PUBLISHER.length).replace(/\/$/, '')).filter(Boolean));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 不上架的书：book.json 里写 "hidden": true（build.mjs 会镜像到 _src/book.json），
  // 文件仍在 R2（直链可开），公开书架不出。**主人例外（2026-08-23）**：JSON 接口
  // 带登录态且 book.json 的 owner == 请求者 scope 时仍列出、条目标 hidden——App
  // 书架给自己的隐藏书贴「隐藏」角标；别人依旧看不见。
  const visible = await Promise.all(slugs.map(async (slug) => {
    try {
      const o = await env.FILES.get(`${PUBLISHER}${slug}/_src/book.json`);
      if (o) {
        const b = JSON.parse(await o.text());
        if (b.hidden === true)
          return viewerScope && b.owner === viewerScope ? { slug, hidden: true } : null;
      }
    } catch {}
    return { slug, hidden: false };
  }));
  const shown = visible.filter(Boolean);

  // 书名 = <slug>/index.html 的 <title>；作者 = 同页 <meta name="author">（写书
  // skill 2026-08-11 起按提交者署名输出；没有此 meta 的存量书都是建硕的）。
  // 诞生时间 = 夹内最早的 uploaded（书会反复重发迭代，index.html 的 uploaded 会
  // 跟着刷新；最早的那个文件基本不动，当创建时间最稳）。同一次全量列举顺手数出
  // cover.jpg 有无 + 顶层章节 html 数（index/intro 不算章），HTML 和 JSON 共用。
  const books = await Promise.all(shown.map(async ({ slug, hidden }) => {
    let title = slug, author = '', category = CATEGORY_OF[slug] || '', createdAt = 0, cover = false, coverAt = 0, chapters = 0;
    try {
      const obj = await env.FILES.get(`${PUBLISHER}${slug}/index.html`);
      if (obj) {
        const html = await obj.text();
        const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        if (m && m[1].trim()) title = m[1].trim();
        const a = /<meta\s+name="author"\s+content="([^"]*)"/i.exec(html);
        if (a && a[1].trim()) author = a[1].trim().slice(0, 20);
        const c = /<meta\s+name="category"\s+content="([^"]*)"/i.exec(html);
        if (c && c[1].trim()) category = c[1].trim().slice(0, 8);
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
          if (leaf === 'cover.jpg') { cover = true; coverAt = t; }
          else if (/\.html?$/.test(leaf) && leaf !== 'index.html' && leaf !== 'intro.html') chapters++;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } catch {}
    const [main, sub] = splitTitle(title);
    const [c, c2] = colorOf(slug);
    return { slug, title, main, sub, c, c2, author, category, cover, coverAt, chapters, createdAt,
             ...(hidden ? { hidden: true } : {}) };
  }));
  // 时间倒序：最新的书在最前面（同龄兜底按书名，保证顺序稳定）。
  books.sort((a, b) => (b.createdAt - a.createdAt) || String(a.title).localeCompare(String(b.title), 'zh'));
  return books;
}

/// JSON 索引（iOS 图书馆）。cover / chapters / createdAt 已在 collectBooks 里
/// 随全量列举一并算好，这里直接吐。
async function indexJSON(env, request) {
  // 登录态（可选）：带 bearer 时把「自己的 hidden 书」也列出（条目带 hidden:true），
  // App 书架据此贴「隐藏」角标。带个人内容的响应 no-store——绝不进共享缓存
  // （CF 边缘 / EdgeOne 都不许把带登录态的书单缓存到别人头上）。
  let scope = '';
  const tok = bearerToken(request);
  if (tok) {
    try {
      if (env.SESSION_SECRET) {
        const s = await verifySession(tok, env.SESSION_SECRET);
        if (s) scope = s.scope;
      }
      if (!scope) scope = (await anonScopeFromToken(tok)) || '';
    } catch {}
  }
  const books = await collectBooks(env, scope);
  return new Response(JSON.stringify({ books }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': scope ? 'no-store' : 'public, max-age=60',
      ...(scope ? { Vary: 'Authorization' } : {}),
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 与 iOS BooksShelfView.swift 一比一：色值 / 圆角 / 间距 / 阴影都从那边抄，
// 改任何一边都要同步另一边。SwiftUI shadow(radius:r) ≈ CSS blur 2r。
async function index(env) {
  const books = await collectBooks(env);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const metaLine = (b) => {
    const base = b.chapters > 0 ? `${b.chapters} 章` : (b.sub ? esc(b.sub) : '');
    const tag = b.category ? `<span class="tag">${esc(b.category)}</span>` : '';
    return (base || tag) ? `${base}${base && tag ? ' ' : ''}${tag}` : '&nbsp;';
  };

  const bookCell = (b) => {
    const href = `/books/${encodeURI(b.slug)}/`;
    const face = b.cover
      ? `<img src="${href}cover.jpg?v=${b.coverAt}" alt="" loading="lazy">`
      : `<span class="cloth"><b>${esc(b.main)}</b><i></i>${b.sub ? `<small>${esc(b.sub)}</small>` : ''}</span>`;
    return `<a class="cell" href="${href}" title="${esc(b.title)}" data-cat="${esc(b.category)}">` +
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

  // 分类导航：与社区 tab 同款（选中墨色加粗，未选中 metaChrome），只列实际有书的类目。
  const present = CATEGORY_ORDER.filter((c) => books.some((b) => b.category === c));
  const tabs = ['全部', ...present]
    .map((c, i) => `<a href="#" data-cat="${c === '全部' ? '' : esc(c)}"${i === 0 ? ' class="on"' : ''}>${esc(c)}</a>`)
    .join('');

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
  /* 分类导航（对齐社区 tabRow：15px，选中 ink 600、未选中 metaChrome）。 */
  .tabs{display:flex;gap:18px;overflow-x:auto;-webkit-overflow-scrolling:touch;
    scrollbar-width:none;padding:10px 2px 14px;white-space:nowrap}
  .tabs::-webkit-scrollbar{display:none}
  .tabs a{font-size:15px;color:#A89E8E;text-decoration:none;flex:none;
    -webkit-tap-highlight-color:transparent}
  .tabs a.on{color:#2A2521;font-weight:600}
  /* 书名下的小类目标签：随 cap small 一行，浅棕描边小胶囊。 */
  .tag{display:inline-block;font-size:10.5px;line-height:1;color:#8A7F6C;
    border:1px solid #D8CCB6;border-radius:8px;padding:2.5px 6px;vertical-align:1px}
</style></head>
<body><main>
<nav class="tabs">${tabs}</nav>
<div id="shelf">
${rows.join('\n')}
</div>
</main>
<script>
(function(){
  var tabs=document.querySelectorAll('.tabs a');
  var shelf=document.getElementById('shelf');
  var all=[].slice.call(shelf.querySelectorAll('a.cell'));
  var write=all.shift();                       // 第一格「写书」入口，任何类目下都在
  function render(cat){
    var list=all.filter(function(c){return !cat||c.getAttribute('data-cat')===cat;});
    var cells=[write].concat(list);
    shelf.textContent='';
    for(var i=0;i<cells.length;i+=2){
      var row=document.createElement('div');row.className='row';
      row.appendChild(cells[i]);
      if(cells[i+1])row.appendChild(cells[i+1]);else row.appendChild(document.createElement('span'));
      shelf.appendChild(row);
      var bar=document.createElement('div');bar.className='shelfbar';
      shelf.appendChild(bar);
    }
  }
  [].forEach.call(tabs,function(t){
    t.addEventListener('click',function(e){
      e.preventDefault();
      [].forEach.call(tabs,function(x){x.classList.remove('on');});
      t.classList.add('on');
      render(t.getAttribute('data-cat'));
    });
  });
})();
</script>
</body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
