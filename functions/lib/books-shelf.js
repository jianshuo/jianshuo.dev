// lib/books-shelf.js — 公开书架的常量与缓存钥匙，books 路由和 files API 共用。
//
// 书架数据（每本书的 title/author/category/hidden/owner/章节目录…）以各书的
// `_src/book.json` 为真源，但每刷一次书架就把两百多本逐个读一遍不划算，且搜索
// 还要老书的目录页（41 本没有 book.json 章节清单、得抠 index.html）。所以 books
// 路由把整理好的全量清单缓存成 R2 里一份 JSON（SHELF_CACHE_KEY），带 builtAt。
//
// 失效是 stale-while-revalidate，不是删：全量重算实测 15 秒（两百多次 R2 读 + 41 本
// 老书抠目录页），而每发一章都会失效一次，删掉的话发书后第一个访客要干等 15 秒。
// 所以任何一次写进 books/<slug>/ 的上传（files API upload、setHidden、build.mjs 发布、
// 类目回填）只在缓存上盖一个 staleAt；下一次请求先用旧清单立刻响应，同时 waitUntil
// 后台重算写回，再下一次就是新的。1 小时 TTL 同样走这条路（作者改了 profile 名而书
// 没动时最迟一小时收敛）。只有缓存根本不存在时才同步现算。
//
// 钥匙放在发布者 scope 下的 books-cache/ 而不是 books/ 里：books/ 是公开只读路由
// 的根，缓存里带 hidden 书和 owner，不能被 /voicedrop/books/_shelf.json 直接拿走。

export const PUBLISHER_SCOPE = 'users/anon-ae209ac53499d51d513425503bd134b0/';
export const PUBLISHER = PUBLISHER_SCOPE + 'books/';
export const SHELF_CACHE_KEY = PUBLISHER_SCOPE + 'books-cache/shelf.json';
export const SHELF_CACHE_TTL_MS = 60 * 60 * 1000;

// 类目（2026-09-15 定的八个词；2026-08-17 的六个 + 科学 + 生活）：书架导航顺序 +
// 每本书的标签。book.json 的 category 只认这八个，别的当没写。
export const CATEGORY_ORDER = ['商业', '投资', 'AI', '科学', '人文', '身心', '生活', '故事'];
export const normalizeCategory = (c) => {
  const s = String(c || '').trim();
  return CATEGORY_ORDER.includes(s) ? s : '';
};

/// 这个 key 的写入会不会影响书架？→ 是书文件夹下的任何东西（含 _src/ 与 cover.jpg）。
export const touchesShelf = (key) => typeof key === 'string' && key.startsWith(PUBLISHER) && key.length > PUBLISHER.length;

/// 标记缓存过期（保留旧清单供下一次请求先用）。绝不 throw——失效失败最多让书架
/// 多陈旧一小时，不能把上传打挂。缓存还不存在就什么都不做。
export async function invalidateShelf(env) {
  try {
    const o = await env.FILES.get(SHELF_CACHE_KEY);
    if (!o) return;
    const c = JSON.parse(await o.text());
    if (!c || !Array.isArray(c.books)) return;
    // 已经标过就别为每一章上传都重写一遍——但正在重算（rebuildingAt）时必须再记一笔：重算读的是
    // 开工那一刻的快照，这次上传可能没赶上。gen 每次作废 +1，重算写回前比对开工时的 gen，
    // 变了就保持 stale（2026-11-18 bad-mood 的最后几个文件落在重算窗口里，作废被吞，书架缓存
    // 「新鲜」地缺了它一小时）。用计数不用时间戳：同一毫秒里的先后分不清。
    if (c.staleAt && !c.rebuildingAt) return;
    await env.FILES.put(SHELF_CACHE_KEY, JSON.stringify({ ...c, staleAt: Date.now(), gen: (Number(c.gen) || 0) + 1 }),
      { httpMetadata: { contentType: 'application/json' } });
  } catch {}
}

/// 缓存文档 → 状态：'fresh' 直接用；'stale' 先用旧的、后台重算；null 没有/坏了。
export function shelfCacheState(c) {
  if (!c || !Array.isArray(c.books)) return null;
  const age = Date.now() - (Number(c.builtAt) || 0);
  return (c.staleAt || age >= SHELF_CACHE_TTL_MS) ? 'stale' : 'fresh';
}

/// 一本书的 book.json → 书架清单条目（纯函数；buildShelf 全量重算和 patchShelf 单本补丁共用，
/// 字段口径只此一处）。author 由调用方解析好（自报 / profile 名）；legacy = 老书抠目录页的
/// {toc, sub, intro}（新书有 chapters 数组，不需要）。没盖 createdAt 的不上架 → null。
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
           createdAt: Number(b.createdAt) || 0, subtitle, intro, toc };
}
export const sortShelf = (books) =>
  books.sort((a, b) => (b.createdAt - a.createdAt) || String(a.title).localeCompare(String(b.title), 'zh'));

/// `books/<slug>/_src/book.json` 这个 key → slug；别的 key → ''。
export const bookJsonSlug = (key) => {
  const m = typeof key === 'string' && key.startsWith(PUBLISHER) ? /^([^/]+)\/_src\/book\.json$/.exec(key.slice(PUBLISHER.length)) : null;
  return m ? m[1] : '';
};

/// 单本补丁（2026-11-24）：build.mjs 每次发布都会重传 `_src/book.json`，这时直接把这一本
/// 的条目换进缓存清单——新书立刻上架、章节数立刻前进，不必等「下一个访客触发后台全量重算
/// 再下一个访客才看到」。起因：全量重算随书架涨到四百多本已要 20–40 秒，卡在 waitUntil 的
/// 30 秒上限边上；《一个代码的十二次追问》写完半小时书架上还没有。
/// 补丁同时照常盖 staleAt + gen：全量重算仍会跑一遍兜底（作者 profile 名、并发补丁互相
/// 覆盖都靠它收敛）。作者：自报优先；不署名（author:""）就是空；没写的沿用缓存里旧条目的
/// （新书先空着，全量重算补 profile 名）。绝不 throw。缓存不存在就什么都不做。
export async function patchShelf(env, slug, bookText) {
  try {
    const b = JSON.parse(bookText);
    const o = await env.FILES.get(SHELF_CACHE_KEY);
    if (!o) return;
    const c = JSON.parse(await o.text());
    if (!c || !Array.isArray(c.books)) return;
    const old = c.books.find((x) => x.slug === slug);
    const own = String(b.author || '').trim().slice(0, 20);
    const entry = shelfEntry(slug, b, own || (b.author === '' ? '' : (old ? old.author : '')), old ? { toc: old.toc, sub: old.subtitle, intro: old.intro } : null);
    const books = c.books.filter((x) => x.slug !== slug);
    if (entry) books.push(entry);
    await env.FILES.put(SHELF_CACHE_KEY, JSON.stringify({ ...c, books: sortShelf(books), staleAt: Date.now(), gen: (Number(c.gen) || 0) + 1 }),
      { httpMetadata: { contentType: 'application/json' } });
  } catch {
    await invalidateShelf(env);
  }
}
