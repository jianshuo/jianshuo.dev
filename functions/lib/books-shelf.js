// lib/books-shelf.js — 公开书架的常量与缓存钥匙，books 路由、files API、agent worker 共用。
//
// 书架数据（每本书的 title/author/category/hidden/owner/章节目录…）以各书的
// `_src/book.json` 为真源。books 路由把整理好的清单缓存成 R2 里一份 JSON（SHELF_CACHE_KEY）。
//
// 增量维护（2026-11-25 起，取代「整架作废 → 全量重算」）：
//   - 清单里每本书一条，带 at（这条最后一次被改的时刻）和 seenAt（最后一次对着真源核过的时刻）。
//   - **写入方直接改那一条**：book.json 经 files API 上传、隐藏开关、转让，都调 patchShelf 把
//     这一本的新条目换进去——新书立刻上架、章节数立刻前进，零重算。
//   - **说不清改了什么就按书记脏**：markShelfDirty(slug) 只在 dirty 表里记一笔；下一次书架请求
//     只把脏的那几本对着真源重读（几次 R2 读），当场就是新的。
//   - **滚动巡检兜底**：路由每隔几分钟在后台挑 seenAt 最老的一小批重核（作者改了 profile 名、
//     有人绕过 API 直写 R2），外加每次列一页书文件夹找清单里没有的 slug。每次请求的 R2 操作数
//     是常数，和书架有多少本书无关。
//   全量重算只剩一种场合：缓存文件根本不存在（冷启动），见路由的 bootShelf。
//
// 起因：全量重算 = 列全部文件夹 + 逐本读 book.json，书架 420 本时要 20–40 秒、五百多次 R2 操作，
// 踩在 waitUntil 30 秒上限和 Worker 单次请求子请求上限的边上；而每发一章都作废一次。
//
// 并发：多个写入方（并行写书时十几个 build.mjs done 同时上传）读改写同一个缓存对象，
// 用 R2 条件写（etag）做乐观锁，冲突就重读重试——见 mutateShelf。
//
// 钥匙放在发布者 scope 下的 books-cache/ 而不是 books/ 里：books/ 是公开只读路由
// 的根，缓存里带 hidden 书和 owner，不能被 /voicedrop/books/_shelf.json 直接拿走。

export const PUBLISHER_SCOPE = 'users/anon-ae209ac53499d51d513425503bd134b0/';
export const PUBLISHER = PUBLISHER_SCOPE + 'books/';
export const SHELF_CACHE_KEY = PUBLISHER_SCOPE + 'books-cache/shelf.json';

// 一次请求最多当场刷新几本脏书（再多的留给下一次请求，脏标记不丢）。
export const SHELF_REFRESH_MAX = 40;
// 滚动巡检：隔多久一轮、一轮核几本。420 本 ≈ 9 轮 ≈ 有流量时 45 分钟核完一遍。
export const SHELF_SWEEP_EVERY_MS = 5 * 60 * 1000;
export const SHELF_SWEEP_BATCH = 50;
// 冷启动最多同步读几本（其余记脏，随后的请求分批补齐）——给子请求上限留余量。
export const SHELF_BOOT_MAX = 400;

// 类目（2026-09-15 定的八个词；2026-08-17 的六个 + 科学 + 生活）：书架导航顺序 +
// 每本书的标签。book.json 的 category 只认这八个，别的当没写。
export const CATEGORY_ORDER = ['商业', '投资', 'AI', '科学', '人文', '身心', '生活', '故事'];
export const normalizeCategory = (c) => {
  const s = String(c || '').trim();
  return CATEGORY_ORDER.includes(s) ? s : '';
};

/// 这个 key 的写入会不会影响书架？→ 是书文件夹下的任何东西（含 _src/ 与 cover.jpg）。
export const touchesShelf = (key) => typeof key === 'string' && key.startsWith(PUBLISHER) && key.length > PUBLISHER.length;

/// `books/<slug>/_src/book.json` 这个 key → slug；别的 key → ''。
export const bookJsonSlug = (key) => {
  const m = typeof key === 'string' && key.startsWith(PUBLISHER) ? /^([^/]+)\/_src\/book\.json$/.exec(key.slice(PUBLISHER.length)) : null;
  return m ? m[1] : '';
};
/// `books/<slug>/index.html` 这个 key → slug（老书的目录要从目录页里抠）；别的 → ''。
export const bookIndexSlug = (key) => {
  const m = typeof key === 'string' && key.startsWith(PUBLISHER) ? /^([^/]+)\/index\.html$/.exec(key.slice(PUBLISHER.length)) : null;
  return m ? m[1] : '';
};

/// 一本书的 book.json → 书架清单条目（纯函数；冷启动、刷新、单本补丁共用，字段口径只此一处）。
/// author 由调用方解析好（自报 / profile 名）；legacy = 老书抠目录页的 {toc, sub, intro}
/// （新书有 chapters 数组，不需要）。没盖 createdAt 的不上架 → null。
export function shelfEntry(slug, b, author = '', legacy = null) {
  if (!b || !b.createdAt) return null;
  const list = Array.isArray(b.chapters) ? b.chapters.filter((x) => x && x.status === 'done') : null;
  let subtitle = String(b.subtitle || '').trim();
  let intro = String(b.introTeaser || '').trim();
  let toc;
  if (list) {
    toc = list.map((x) => ({ t: String(x.title || '').trim(), b: String(x.brief || '').trim() }));
  } else {
    toc = (legacy && legacy.toc) || []; subtitle = subtitle || (legacy && legacy.sub) || ''; intro = intro || (legacy && legacy.intro) || '';
  }
  return { slug, title: String(b.title || slug), author, category: normalizeCategory(b.category),
           hidden: b.hidden === true, owner: b.owner || PUBLISHER_SCOPE,
           cover: b.cover === true, coverAt: Number(b.coverAt) || 0,
           video: !!(b.video && b.video.url),
           chapters: list ? list.length : (Number(b.chaptersCount) || 0),
           createdAt: Number(b.createdAt) || 0, subtitle, intro, toc,
           ...(list ? {} : { legacy: true }) };   // legacy：目录来自目录页，index.html 重传时要重核
}
export const sortShelf = (books) =>
  books.sort((a, b) => (b.createdAt - a.createdAt) || String(a.title).localeCompare(String(b.title), 'zh'));

/// 缓存文档归一成当前形态：{ v:2, books, dirty:{slug:ts}, builtAt, sweptAt, discover }。
/// 旧形态（只有 books/builtAt/staleAt/gen）原样接过来：清单照用，条目没有 seenAt 就当 0，
/// 巡检会从它们开始核。坏文档 → null。
export function normalizeShelfDoc(c) {
  if (!c || !Array.isArray(c.books)) return null;
  return {
    v: 2,
    books: c.books,
    dirty: c.dirty && typeof c.dirty === 'object' && !Array.isArray(c.dirty) ? c.dirty : {},
    builtAt: Number(c.builtAt) || 0,
    sweptAt: Number(c.sweptAt) || 0,
    discover: c.discover && typeof c.discover === 'object' ? c.discover : null,
  };
}

const putShelf = (env, doc, opts = {}) =>
  env.FILES.put(SHELF_CACHE_KEY, JSON.stringify(doc), { httpMetadata: { contentType: 'application/json' }, ...opts });

/// 读缓存 → { doc, etag }；没有或坏了 → { doc: null }。
export async function loadShelf(env) {
  try {
    const o = await env.FILES.get(SHELF_CACHE_KEY);
    if (!o) return { doc: null };
    return { doc: normalizeShelfDoc(JSON.parse(await o.text())), etag: o.etag };
  } catch { return { doc: null }; }
}

/// 读改写缓存（乐观锁）：fn(doc) 返回新文档，或返回 null 表示不用写。
/// R2 的条件写在 etag 不匹配时返回 null → 重读重试；试到最后一次不再带条件，直接写
/// （极端并发下宁可覆盖一次——脏标记丢了有滚动巡检兜底——也不能让上传方卡死）。
/// 缓存不存在 → 不创建、返回 null。返回写入后的文档（没写就是读到的那份）。
export async function mutateShelf(env, fn) {
  const TRIES = 5;
  for (let i = 0; i < TRIES; i++) {
    const { doc, etag } = await loadShelf(env);
    if (!doc) return null;
    const next = fn(doc);
    if (!next) return doc;
    const cond = etag && i < TRIES - 1 ? { onlyIf: { etagMatches: etag } } : {};
    const r = await putShelf(env, next, cond);
    if (r !== null) return next;   // 真 R2 条件不满足时返回 null；其余（含测试桩的 undefined）都是写成了
  }
  return null;
}

// 脏标记的值是「记这一笔的时刻」，同一本连着记两次必须能分出先后（刷新只清它开工时看到的那一笔）。
const bump = (old) => Math.max(Date.now(), (Number(old) || 0) + 1);

/// 这本书的条目可能过期了：记一笔，下一次书架请求把它对着真源重读。绝不 throw。
export async function markShelfDirty(env, slug) {
  if (!slug) return;
  try { await mutateShelf(env, (d) => ({ ...d, dirty: { ...d.dirty, [slug]: bump(d.dirty[slug]) } })); } catch {}
}

/// 老书的 index.html 被重传了 → 目录要重抠，记脏。新书的条目只看 book.json，目录页
/// 重传与它无关（每发一章都会重传一次目录页，不能每次都白读一遍）。绝不 throw。
export async function markShelfDirtyIfLegacy(env, slug) {
  if (!slug) return;
  try {
    await mutateShelf(env, (d) => {
      const e = d.books.find((x) => x.slug === slug);
      return e && e.legacy ? { ...d, dirty: { ...d.dirty, [slug]: bump(d.dirty[slug]) } } : null;
    });
  } catch {}
}

/// 兼容旧调用：给了 slug 就记这一本脏；没给（不知道是哪本）就把整架的 seenAt 清零，
/// 让滚动巡检从头核一遍——不再有「整架作废 → 全量重算」。
export async function invalidateShelf(env, slug) {
  if (slug) return markShelfDirty(env, slug);
  try { await mutateShelf(env, (d) => ({ ...d, sweptAt: 0, books: d.books.map((b) => ({ ...b, seenAt: 0 })) })); } catch {}
}

/// 单本补丁：手里正好有这本书最新的 book.json（files API 收到上传、隐藏开关、转让刚写完）
/// → 直接把它的条目换进清单。作者：自报优先；显式 author:"" = 不署名；没写的沿用旧条目的，
/// 连旧条目都没有（新书、没署名）就先空着并记脏——下一次请求会去读主人的 profile 名。
/// book.json 没盖 createdAt（还没发过目录页）→ 不上架，有旧条目也摘掉。
/// 绝不 throw；缓存不存在就什么都不做；JSON 坏了退回记脏。
export async function patchShelf(env, slug, bookText) {
  if (!slug) return;
  let b;
  try { b = typeof bookText === 'string' ? JSON.parse(bookText) : bookText; }
  catch { return markShelfDirty(env, slug); }
  try {
    await mutateShelf(env, (d) => {
      const now = Date.now();
      const old = d.books.find((x) => x.slug === slug);
      const own = String((b && b.author) || '').trim().slice(0, 20);
      const explicitBlank = !!b && b.author === '';
      const author = own || (explicitBlank ? '' : (old ? old.author : ''));
      const entry = shelfEntry(slug, b, author, old ? { toc: old.toc, sub: old.subtitle, intro: old.intro } : null);
      const books = d.books.filter((x) => x.slug !== slug);
      const dirty = { ...d.dirty };
      if (entry) {
        books.push({ ...entry, at: now, seenAt: old ? (Number(old.seenAt) || 0) : 0 });
        if (!own && !explicitBlank && !old) dirty[slug] = bump(dirty[slug]);
      }
      return { ...d, books: sortShelf(books), dirty, builtAt: now };
    });
  } catch {
    await markShelfDirty(env, slug);
  }
}
