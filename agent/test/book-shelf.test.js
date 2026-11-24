// test/book-shelf.test.js — 公开书架：类目八选一、R2 缓存 + 写失效、?format=search 搜索索引。
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { onRequest } from "../../functions/voicedrop/books/[[path]].js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import {
  PUBLISHER, SHELF_CACHE_KEY, CATEGORY_ORDER, SHELF_BOOT_MAX, SHELF_SWEEP_BATCH, touchesShelf, invalidateShelf, patchShelf,
  bookJsonSlug, bookIndexSlug, markShelfDirty, markShelfDirtyIfLegacy, mutateShelf,
} from "../../functions/lib/books-shelf.js";

const OWNER_TOK = "anon_owner_token_abcdefghijklmnop";
const srcKey = (slug) => `${PUBLISHER}${slug}/_src/book.json`;

const newBook = (slug, extra = {}) => JSON.stringify({
  slug, title: `${slug} 的书`, createdAt: 1700000000000, author: "王建硕", introTeaser: `${slug} 的钩子`,
  chapters: [
    { no: 1, title: "第一章 · 洗牌", brief: "用洗牌讲无序", status: "done" },
    { no: 2, title: "第二章 · 小妖", brief: "麦克斯韦的小妖", status: "planned" },
  ],
  ...extra,
});

const legacyIndexHtml = `<!doctype html><html><body>
<h1>灯塔的作用</h1><p class="sub">海上的公共基础设施</p>
<a class="introcard" href="intro.html"><b>导读</b><p>先从一盏灯说起。</p></a>
<div class="toc"><a class="row done" href="01.html"><span class="no">01</span>
<span class="t"><b>第一章 · 一盏灯</b><p>灯塔为什么是公共品</p></span></a>
<a class="row done" href="02.html"><span class="no">02</span>
<span class="t"><b>第二章 · 谁来付钱</b><p>灯塔税与港口费</p></span></a></div>
</body></html>`;

async function shelfEnv() {
  const owner = await anonScopeFromToken(OWNER_TOK);
  return fakeEnv({
    [srcKey("entropy")]: newBook("entropy", { category: "科学" }),
    [srcKey("money")]: newBook("money", { category: "钱" }),            // 不在八个词里 → 当没写
    [srcKey("secret")]: newBook("secret", { category: "故事", hidden: true, owner }),
    [srcKey("lighthouse")]: JSON.stringify({ legacy: true, slug: "lighthouse", title: "灯塔的作用", createdAt: 1600000000000, chaptersCount: 2, author: "王建硕", category: "科学" }),
    [`${PUBLISHER}lighthouse/index.html`]: legacyIndexHtml,
  });
}

// bg 收集 waitUntil 里的后台重算，测试里 `await Promise.all(bg)` 等它跑完。
function call(env, { format, token, bg } = {}) {
  const url = `https://voicedrop.cn/books/${format ? `?format=${format}` : ""}`;
  const req = new Request(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
  return onRequest({ request: req, env, params: { path: [] }, waitUntil: (p) => { if (bg) bg.push(p); } });
}
const titleOf = (books, slug) => books.find((b) => b.slug === slug).title;
const cacheDoc = (env) => JSON.parse(env.FILES._store.get(SHELF_CACHE_KEY));
// 数一数从现在起读了哪些 book.json（证明「只重读变动的那几本」）。
function countBookReads(env) {
  const get = env.FILES.get.bind(env.FILES);
  const seen = [];
  env.FILES.get = async (key) => { if (/\/_src\/book\.json$/.test(key)) seen.push(key); return get(key); };
  return () => seen;
}
function countLists(env) {
  const list = env.FILES.list.bind(env.FILES);
  let n = 0;
  env.FILES.list = async (o) => { n++; return list(o); };
  return () => n;
}
// 把上一轮巡检时刻拨回去，让下一次请求起一轮巡检。
const ageSweep = (env) => env.FILES._store.set(SHELF_CACHE_KEY, JSON.stringify({ ...cacheDoc(env), sweptAt: 0 }));

describe("书架类目", () => {
  it("category 只认八个词，别的当没写；导航按固定顺序只列有书的类目", async () => {
    const env = await shelfEnv();
    const { books } = await (await call(env, { format: "json" })).json();
    const cat = Object.fromEntries(books.map((b) => [b.slug, b.category]));
    expect(cat.entropy).toBe("科学");
    expect(cat.lighthouse).toBe("科学");
    expect(cat.money).toBe("");
    expect(CATEGORY_ORDER).toEqual(["商业", "投资", "AI", "科学", "人文", "身心", "生活", "故事"]);

    const html = await (await call(env)).text();
    const tabs = /<nav class="tabs">(.*?)<\/nav>/s.exec(html)[1];
    const names = [...tabs.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(names).toEqual(["全部", "科学"]);      // 故事那本是 hidden，匿名看不到 → 不列
  });
});

describe("书架动画版", () => {
  it("book.json 有 video.url 才算：JSON 带 video:true，封面叠播放键，导航出「视频」tab", async () => {
    const env = await shelfEnv();
    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { category: "科学", video: { url: "video/", chapters: 2 } }));
    env.FILES._store.set(srcKey("money"), newBook("money", { video: {} }));   // 没 url = 还没做成
    const { books } = await (await call(env, { format: "json" })).json();
    expect(books.filter((b) => b.video).map((b) => b.slug)).toEqual(["entropy"]);

    const html = await (await call(env)).text();
    const cells = [...html.matchAll(/<a class="cell"[^>]*data-slug="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
    const withPlay = cells.filter((m) => m[2].includes('class="play"')).map((m) => m[1]);
    expect(withPlay).toEqual(["entropy"]);
    const tabs = /<nav class="tabs">(.*?)<\/nav>/s.exec(html)[1];
    expect([...tabs.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual(["全部", "视频", "科学"]);
  });

  it("一本动画版都没有 → 不出「视频」tab", async () => {
    const html = await (await call(await shelfEnv())).text();
    expect(html).not.toContain('data-video="1">视频');
  });
});

describe("书架作者", () => {
  it("author 缺省回落主人 profile 名；显式 author: \"\" = 不署名，不回落", async () => {
    const owner = await anonScopeFromToken(OWNER_TOK);
    const env = fakeEnv({
      [srcKey("blank")]: newBook("blank", { author: "", owner }),
      [srcKey("nometa")]: JSON.stringify({ ...JSON.parse(newBook("nometa", { owner })), author: undefined }),
    });
    const { books } = await (await call(env, { format: "json" })).json();
    const au = Object.fromEntries(books.map((b) => [b.slug, b.author]));
    expect(au.blank).toBe("");
    expect(au.nometa).toBeTruthy();
  });
});

describe("书架缓存", () => {
  it("第一次请求同步现算并落 R2；book.json 偷偷改了但没失效 → 仍旧读缓存；删缓存 → 再同步现算", async () => {
    const env = await shelfEnv();
    expect(env.FILES._store.has(SHELF_CACHE_KEY)).toBe(false);
    let { books } = await (await call(env, { format: "json" })).json();
    expect(env.FILES._store.has(SHELF_CACHE_KEY)).toBe(true);
    expect(titleOf(books, "entropy")).toBe("entropy 的书");

    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "改过的书名", category: "科学" }));
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("entropy 的书");

    await env.FILES.delete(SHELF_CACHE_KEY);
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("改过的书名");
  });

  it("记脏 → 下一次请求当场就是新的，而且只重读脏的那一本", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "改过的书名", category: "科学" }));
    await markShelfDirty(env, "entropy");
    expect(cacheDoc(env).dirty.entropy).toBeTruthy();
    expect(cacheDoc(env).books.length).toBeGreaterThan(0);   // 清单还在，没被删

    const reads = countBookReads(env);
    const { books } = await (await call(env, { format: "json" })).json();
    expect(titleOf(books, "entropy")).toBe("改过的书名");     // 不再「先给旧的」
    expect(reads()).toEqual([srcKey("entropy")]);            // 整架四本，只读了脏的这一本
    expect(cacheDoc(env).dirty.entropy).toBeUndefined();
    expect(titleOf(cacheDoc(env).books, "entropy")).toBe("改过的书名");
  });

  it("记脏的书真源没了（book.json 删了 / 没盖 createdAt）→ 刷新时从清单摘掉", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await env.FILES.delete(srcKey("entropy"));
    await markShelfDirty(env, "entropy");
    const { books } = await (await call(env, { format: "json" })).json();
    expect(books.map((b) => b.slug)).not.toContain("entropy");
    expect(cacheDoc(env).dirty.entropy).toBeUndefined();
  });

  it("刷新读真源的当口又来了补丁：较新的条目不被旧读覆盖（2026-11-18 bad-mood 那类竞态）", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await markShelfDirty(env, "entropy");
    // 刷新读 entropy 的 book.json 时，另一个写入方把它 patch 成了更新的版本
    const get = env.FILES.get.bind(env.FILES);
    let hooked = false;
    env.FILES.get = async (key) => {
      const o = await get(key);
      if (key === srcKey("entropy") && !hooked) {
        hooked = true;
        await new Promise((r) => setTimeout(r, 3));   // 让补丁的 at 明确晚于刷新开工时刻
        await patchShelf(env, "entropy", newBook("entropy", { title: "补丁带来的新书名", category: "科学" }));
      }
      return o;
    };
    const { books } = await (await call(env, { format: "json" })).json();
    expect(titleOf(books, "entropy")).toBe("补丁带来的新书名");
    expect(titleOf(cacheDoc(env).books, "entropy")).toBe("补丁带来的新书名");
  });

  it("刷新读真源的当口同一本又被记了一笔脏：这笔脏标记留着，下一次请求再刷", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await markShelfDirty(env, "entropy");
    const get = env.FILES.get.bind(env.FILES);
    let hooked = false;
    env.FILES.get = async (key) => {
      const o = await get(key);
      if (key === srcKey("entropy") && !hooked) {
        hooked = true;
        env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "第二次改", category: "科学" }));
        await markShelfDirty(env, "entropy");
      }
      return o;
    };
    let { books } = await (await call(env, { format: "json" })).json();
    expect(titleOf(books, "entropy")).toBe("entropy 的书");       // 这次读到的还是改之前的
    expect(cacheDoc(env).dirty.entropy).toBeTruthy();              // 但脏标记没被吞
    ({ books } = await (await call(env, { format: "json" })).json());
    expect(titleOf(books, "entropy")).toBe("第二次改");
    expect(cacheDoc(env).dirty.entropy).toBeUndefined();
  });

  it("乐观锁：几个写入方同时读改写缓存，谁的修改都不丢", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await Promise.all([markShelfDirty(env, "entropy"), markShelfDirty(env, "money"), markShelfDirty(env, "secret")]);
    expect(Object.keys(cacheDoc(env).dirty).sort()).toEqual(["entropy", "money", "secret"]);
    // 缓存不存在时不凭空创建
    await env.FILES.delete(SHELF_CACHE_KEY);
    expect(await mutateShelf(env, (d) => d)).toBeNull();
    expect(env.FILES._store.has(SHELF_CACHE_KEY)).toBe(false);
  });

  it("滚动巡检：绕过 API 直写的改动、凭空多出来的书、被删掉的书，都由后台一轮巡检收敛", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    // 三种绕过 API 的变化，都没人记脏
    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "直写改的书名", category: "科学" }));
    env.FILES._store.set(srcKey("stowaway"), newBook("stowaway", { createdAt: 1800000000000 }));
    for (const k of [...env.FILES._store.keys()]) if (k.startsWith(`${PUBLISHER}money/`)) env.FILES._store.delete(k);

    // 巡检没到点：什么都不会发生
    let bg = [];
    let { books } = await (await call(env, { format: "json", bg })).json();
    expect(bg.length).toBe(0);
    expect(titleOf(books, "entropy")).toBe("entropy 的书");

    // 到点了（把上一轮巡检时刻拨回去）：后台起一轮
    ageSweep(env);
    bg = [];
    const lists = countLists(env);
    await Promise.all([call(env, { format: "json", bg }), call(env, { format: "json", bg })]);
    await Promise.all(bg);
    expect(lists()).toBe(1);                                   // 两个请求同时到，只有一轮真的干活
    const doc = cacheDoc(env);
    expect(titleOf(doc.books, "entropy")).toBe("直写改的书名");  // seenAt 最老的一批被重核
    expect(doc.dirty.stowaway).toBeTruthy();                    // 清单里没有的 slug → 记脏
    expect(doc.dirty.money).toBeUndefined();                    // 这一批里核到它、读不到 book.json → 直接摘掉
    expect(doc.books.map((b) => b.slug)).not.toContain("money");
    expect(doc.books.every((b) => b.seenAt > 0)).toBe(true);

    ({ books } = await (await call(env, { format: "json" })).json());
    expect(books[0].slug).toBe("stowaway");                     // 下一次请求：新书上架
  });

  it("巡检一轮只核 seenAt 最老的一批，R2 读数不随书架变大", async () => {
    const seed = {};
    const N = SHELF_SWEEP_BATCH + 30;
    for (let i = 0; i < N; i++) seed[srcKey(`b${i}`)] = newBook(`b${i}`, { createdAt: 1700000000000 + i });
    const env = fakeEnv(seed);
    await call(env, { format: "json" });
    ageSweep(env);
    const reads = countBookReads(env);
    const bg = [];
    await call(env, { format: "json", bg });
    await Promise.all(bg);
    expect(reads().length).toBe(SHELF_SWEEP_BATCH);
    const first = new Set(reads());
    // 下一轮接着核剩下的（seenAt 更老的排前面）
    ageSweep(env);
    const bg2 = [];
    await call(env, { format: "json", bg: bg2 });
    await Promise.all(bg2);
    const second = reads().slice(SHELF_SWEEP_BATCH);
    expect(second.filter((k) => !first.has(k)).length).toBe(30);
  });

  it("冷启动书太多：先同步读一批，其余记脏，同一次请求顺手补齐", async () => {
    const seed = {};
    const N = SHELF_BOOT_MAX + 5;
    for (let i = 0; i < N; i++) seed[srcKey(`b${String(i).padStart(4, "0")}`)] = newBook(`b${i}`, { createdAt: 1700000000000 + i });
    const env = fakeEnv(seed);
    const { books } = await (await call(env, { format: "json" })).json();
    expect(books.length).toBe(N);
    expect(Object.keys(cacheDoc(env).dirty).length).toBe(0);
    expect(cacheDoc(env).books.length).toBe(N);
  });

  it("旧形态的缓存文档（只有 books/builtAt/staleAt/gen）原样接过来用，不触发全量重算", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const old = cacheDoc(env);
    env.FILES._store.set(SHELF_CACHE_KEY, JSON.stringify({ builtAt: old.builtAt, staleAt: Date.now(), gen: 7,
      books: old.books.map(({ at, seenAt, ...b }) => b) }));
    const lists = countLists(env);
    const bg = [];
    const { books } = await (await call(env, { format: "json", bg })).json();
    expect(books.length).toBe(3);                               // 匿名看不到 hidden 的那本
    await Promise.all(bg);                                      // sweptAt 当 0 → 起一轮巡检，核的只是一批
    expect(lists()).toBe(1);
    expect(cacheDoc(env).v).toBe(2);
    expect(cacheDoc(env).books.length).toBe(4);
  });

  it("没有 waitUntil（本地/测试）也不会挂：巡检自己跑完", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    env.FILES._store.set(srcKey("entropy"), newBook("entropy", { title: "改过的书名", category: "科学" }));
    ageSweep(env);
    const r = await onRequest({ request: new Request("https://voicedrop.cn/books/?format=json"), env, params: { path: [] } });
    expect(r.status).toBe(200);
    for (let i = 0; i < 40 && titleOf(cacheDoc(env).books, "entropy") !== "改过的书名"; i++) await new Promise((res) => setTimeout(res, 5));
    expect(titleOf(cacheDoc(env).books, "entropy")).toBe("改过的书名");
  });

  it("invalidateShelf：给 slug 就记那一本脏；不给就把整架排到巡检队首（seenAt 清零），不重算", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await invalidateShelf(env, "money");
    expect(Object.keys(cacheDoc(env).dirty)).toEqual(["money"]);
    await invalidateShelf(env);
    const doc = cacheDoc(env);
    expect(doc.books.length).toBe(4);
    expect(doc.books.every((b) => b.seenAt === 0)).toBe(true);
    expect(doc.sweptAt).toBe(0);
  });

  it("缓存是全量（含 hidden 书），按请求者过滤：匿名看不到 hidden，主人看得到", async () => {
    const env = await shelfEnv();
    let { books } = await (await call(env, { format: "json" })).json();
    expect(books.map((b) => b.slug)).not.toContain("secret");
    ({ books } = await (await call(env, { format: "json", token: OWNER_TOK })).json());
    const s = books.find((b) => b.slug === "secret");
    expect(s.hidden).toBe(true);
    expect(s.mine).toBe(true);
  });

  it("隐藏开关写完 book.json，书架缓存里这一本当场跟着变（单本补丁）", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const before = JSON.stringify(cacheDoc(env));
    const req = new Request("https://voicedrop.cn/books/entropy/hidden", {
      method: "POST", headers: { Authorization: "Bearer " + OWNER_TOK }, body: JSON.stringify({ hidden: true }),
    });
    // entropy 没 owner → 归发布者，OWNER_TOK 不是主人 → 403，不该动缓存
    let r = await onRequest({ request: req, env, params: { path: ["entropy", "hidden"] } });
    expect(r.status).toBe(403);
    expect(JSON.stringify(cacheDoc(env))).toBe(before);
    // secret 是主人的 → 200，缓存里这一本立刻不再 hidden，匿名访客下一次请求就看得到
    const req2 = new Request("https://voicedrop.cn/books/secret/hidden", {
      method: "POST", headers: { Authorization: "Bearer " + OWNER_TOK }, body: JSON.stringify({ hidden: false }),
    });
    r = await onRequest({ request: req2, env, params: { path: ["secret", "hidden"] } });
    expect(r.status).toBe(200);
    expect(cacheDoc(env).books.find((b) => b.slug === "secret").hidden).toBe(false);
    const reads = countBookReads(env);
    const { books } = await (await call(env, { format: "json" })).json();
    expect(books.map((b) => b.slug)).toContain("secret");
    expect(reads()).toEqual([]);                                // 一次真源都不用读
  });

  it("touchesShelf：书文件夹下任何 key 都算，别的 scope / books 根本身不算", () => {
    expect(touchesShelf(`${PUBLISHER}entropy/_src/book.json`)).toBe(true);
    expect(touchesShelf(`${PUBLISHER}entropy/cover.jpg`)).toBe(true);
    expect(touchesShelf(PUBLISHER)).toBe(false);
    expect(touchesShelf("users/anon-other/books/x/index.html")).toBe(false);
    expect(touchesShelf(`${PUBLISHER.replace(/books\/$/, "")}articles/a.json`)).toBe(false);
  });
});

describe("搜索索引 ?format=search", () => {
  it("新书从 book.json 取章节（只要 done 的），老书从 index.html 抠目录；hidden 匿名不出", async () => {
    const env = await shelfEnv();
    const r = await call(env, { format: "search" });
    expect(r.headers.get("Content-Type")).toContain("application/json");
    const { books } = await r.json();
    const by = Object.fromEntries(books.map((b) => [b.slug, b]));
    expect(by.secret).toBeUndefined();

    expect(by.entropy.intro).toBe("entropy 的钩子");
    expect(by.entropy.toc).toEqual([{ t: "第一章 · 洗牌", b: "用洗牌讲无序" }]);
    expect(by.entropy.category).toBe("科学");

    expect(by.lighthouse.sub).toBe("海上的公共基础设施");
    expect(by.lighthouse.intro).toBe("先从一盏灯说起。");
    expect(by.lighthouse.toc).toEqual([
      { t: "第一章 · 一盏灯", b: "灯塔为什么是公共品" },
      { t: "第二章 · 谁来付钱", b: "灯塔税与港口费" },
    ]);
  });

  it("主人带 token → 自己的 hidden 书也进搜索索引", async () => {
    const env = await shelfEnv();
    const { books } = await (await call(env, { format: "search", token: OWNER_TOK })).json();
    expect(books.map((b) => b.slug)).toContain("secret");
  });
});

describe("书架单本补丁（上传 _src/book.json 时新书立刻上架）", () => {
  it("bookJsonSlug 只认 books/<slug>/_src/book.json", () => {
    expect(bookJsonSlug(srcKey("entropy"))).toBe("entropy");
    expect(bookJsonSlug(`${PUBLISHER}entropy/01.html`)).toBe("");
    expect(bookJsonSlug(`${PUBLISHER}entropy/_src/01.html`)).toBe("");
    expect(bookJsonSlug("users/x/books/entropy/_src/book.json")).toBe("");
  });

  it("bookIndexSlug 只认 books/<slug>/index.html", () => {
    expect(bookIndexSlug(`${PUBLISHER}lighthouse/index.html`)).toBe("lighthouse");
    expect(bookIndexSlug(`${PUBLISHER}lighthouse/01.html`)).toBe("");
    expect(bookIndexSlug(`${PUBLISHER}lighthouse/_src/index.html`)).toBe("");
  });

  it("新书（显式不署名）：补丁后第一次请求就在清单最前面，一次真源都不用读", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const text = newBook("fresh", { createdAt: 1800000000000, category: "投资", author: "" });
    env.FILES._store.set(srcKey("fresh"), text);
    await patchShelf(env, "fresh", text);
    expect(cacheDoc(env).dirty.fresh).toBeUndefined();

    const reads = countBookReads(env);
    const bg = [];
    const { books } = await (await call(env, { format: "json", bg })).json();
    expect(books[0].slug).toBe("fresh");
    expect(books[0].chapters).toBe(1);
    expect(books[0].author).toBe("");
    expect(reads()).toEqual([]);
    expect(bg.length).toBe(0);
  });

  it("新书没写 author：先空着上架并记脏，下一次请求补上主人的 profile 名", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const b = JSON.parse(newBook("nameless", { createdAt: 1800000000000 }));
    delete b.author;
    env.FILES._store.set(srcKey("nameless"), JSON.stringify(b));
    await patchShelf(env, "nameless", JSON.stringify(b));
    expect(cacheDoc(env).books[0].slug).toBe("nameless");
    expect(cacheDoc(env).dirty.nameless).toBeTruthy();
    const { books } = await (await call(env, { format: "json" })).json();
    expect(books[0].slug).toBe("nameless");
    expect(books[0].author).toBeTruthy();                       // 回落到主人 profile 名 / id
    expect(cacheDoc(env).dirty.nameless).toBeUndefined();
  });

  it("老条目：章节数前进、书名跟着改、作者沿用；没盖 createdAt 的不上架；坏 JSON 退回记脏", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    const b = JSON.parse(newBook("entropy", { title: "改过的书名", category: "科学" }));
    b.chapters[1].status = "done";
    await patchShelf(env, "entropy", JSON.stringify(b));
    const e = cacheDoc(env).books.find((x) => x.slug === "entropy");
    expect(e.title).toBe("改过的书名");
    expect(e.chapters).toBe(2);
    expect(e.author).toBe("王建硕");

    await patchShelf(env, "ghost", JSON.stringify({ slug: "ghost", title: "没盖章" }));
    expect(cacheDoc(env).books.some((x) => x.slug === "ghost")).toBe(false);

    const n = cacheDoc(env).books.length;
    await patchShelf(env, "entropy", "{not json");
    expect(cacheDoc(env).books.length).toBe(n);
    expect(cacheDoc(env).dirty.entropy).toBeTruthy();
  });

  it("老书的 index.html 重传 → 记脏重抠目录；新书的目录页重传与条目无关，不记", async () => {
    const env = await shelfEnv();
    await call(env, { format: "json" });
    await markShelfDirtyIfLegacy(env, "entropy");
    expect(cacheDoc(env).dirty.entropy).toBeUndefined();
    env.FILES._store.set(`${PUBLISHER}lighthouse/index.html`, legacyIndexHtml.replace("第一章 · 一盏灯", "第一章 · 换了章名"));
    await markShelfDirtyIfLegacy(env, "lighthouse");
    expect(cacheDoc(env).dirty.lighthouse).toBeTruthy();
    const { books } = await (await call(env, { format: "search" })).json();
    expect(books.find((b) => b.slug === "lighthouse").toc[0].t).toBe("第一章 · 换了章名");
  });

  it("缓存还不存在：什么都不做（下一次请求冷启动现算）", async () => {
    const env = await shelfEnv();
    await patchShelf(env, "entropy", newBook("entropy"));
    expect(env.FILES._store.has(SHELF_CACHE_KEY)).toBe(false);
  });
});
