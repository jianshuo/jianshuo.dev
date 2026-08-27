import { resolveScope } from "./auth.js";
import { recordEngagement, countsFor, likedBy, feedRows } from "./store.js";
import { rankPosts } from "./ranking.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

const ID_RE = /^[0-9A-Za-z_-]{1,32}$/;

// —— 书架进社区 feed（2026-08-27 预览彩蛋当天转正）：所有用户的 feed 都混入公开
// 书架的全部书（kind:"book"，shareId 是 "book-<slug>"）。新版 app 点书卡用站内
// 浏览器打开 voicedrop.cn/books/<slug>/；旧版 app 会当普通帖去取分享快照而失败，
// 属已知过渡代价。撤掉 = 删本段与 feed 分支里的调用，重新 deploy。
// 书列表来自公开 /voicedrop/books/?format=json——该函数无缓存、97 本书逐本读
// 标题，实测一次要 ~9s，绝不能让 feed 同步等它（会拖垮正常刷社区）。所以走
// stale-while-revalidate：feed 只取 isolate 缓存（可能为空/过期），缺了就
// ctx.waitUntil 后台预热（给足 20s）。冷启动第一刷没书、几秒后再刷就有。
// BOOKS_OWNER_SCOPE 只用来拼封面的 R2 key（书都发布在这个 scope 下）。
// isolate 内存缓存之外再垫一层 Cache API（同 colo 全部 isolate 共享，读毫秒级）：
// CF 不保证连续请求落同一 isolate，没有这层的话每个冷 isolate 都要自己熬 ~25s
// 预热，「刷两次」会退化成「刷 N 次」（2026-08-27 实测踩到）。
const BOOKS_OWNER_SCOPE = "users/anon-ae209ac53499d51d513425503bd134b0/";
const BOOKS_MIN_BUILD = 330;   // 书卡首发 build（1.13(330)）；X-VD-Build 低于它不混书
const BOOKS_TTL_MS = 10 * 60_000;
const BOOKS_CACHE_URL = "https://voicedrop-reco.cache/books-feed-posts";
let booksPreviewCache = { at: 0, posts: null, refreshing: false };
async function refreshBooksPreview() {
  if (booksPreviewCache.refreshing) return;
  booksPreviewCache.refreshing = true;
  try {
    const r = await fetch("https://jianshuo.dev/voicedrop/books/?format=json", { signal: AbortSignal.timeout(20000) });
    console.log("books-refresh: status", r.status);
    if (r.ok) {
      const j = await r.json();
      console.log("books-refresh: loaded", (j.books || []).length);
      booksPreviewCache = {
        at: Date.now(),
        refreshing: false,
        posts: (j.books || []).map((b) => ({
          shareId: "book-" + b.slug,
          author: b.author || "匿名",   // 作者名由上游 books JSON 按 owner 定（profile.name / id 前6位）；这里只做极端兜底，不再硬编码建硕

          title: b.title || b.slug,
          ...(b.sub ? { preview: b.sub } : {}),
          ...(b.cover ? { coverPhotoKey: `${BOOKS_OWNER_SCOPE}books/${b.slug}/cover.jpg` } : {}),
          hasPhoto: !!b.cover,
          count: b.chapters || 0,
          firstSharedAt: b.createdAt || 0,
          updatedAt: b.createdAt || 0,
          mine: false, likes: 0, replies: 0, liked: false,
          kind: "book",
        })),
      };
      try {
        await caches.default.put(BOOKS_CACHE_URL, new Response(JSON.stringify(booksPreviewCache.posts), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${BOOKS_TTL_MS / 1000}` },
        }));
      } catch {}   // Cache API 缺席（单测环境）→ 只有 isolate 内存缓存，无碍
      return;
    }
  } catch (e) { console.log("books-refresh: error", String(e && e.message || e)); }
  booksPreviewCache.refreshing = false;   // 失败保留旧值，下次请求再试
}
async function booksPreviewPosts(ctx) {
  if (booksPreviewCache.posts && Date.now() - booksPreviewCache.at <= BOOKS_TTL_MS) return booksPreviewCache.posts;
  try {
    const hit = await caches.default.match(BOOKS_CACHE_URL);   // 同 colo 共享，毫秒级
    if (hit) {
      const posts = await hit.json();
      booksPreviewCache = { at: Date.now(), posts, refreshing: booksPreviewCache.refreshing };
      return posts;
    }
  } catch {}   // Cache API 缺席（单测环境）→ 走预热路径
  const p = refreshBooksPreview();
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return booksPreviewCache.posts || [];
}

// 测试钩子：重置书架缓存（与 store.js 的 __resetStoreCaches 同款惯例）。
export function __resetBooksPreviewCache() {
  booksPreviewCache = { at: 0, posts: null, refreshing: false };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ['reco','engage','<id>'] | ['reco','rank']
    if (parts[0] !== "reco") return json({ error: "not found" }, 404);

    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const scope = await resolveScope(token, env.SESSION_SECRET);
    if (!scope) return json({ error: "unauthorized" }, 401);

    // POST /reco/engage/<shareId>
    if (request.method === "POST" && parts[1] === "engage" && parts[2]) {
      const shareId = parts[2];
      if (!ID_RE.test(shareId)) return json({ error: "bad id" }, 400);
      const body = await request.json().catch(() => ({}));
      const action = body.action;
      if (!["view", "finish", "like", "report"].includes(action)) return json({ error: "bad action" }, 400);
      if (!env.DB) return json({ ok: true });   // D1 缺失 → no-op,绝不崩
      await recordEngagement(env, shareId, scope, action, body.on, Date.now());
      return json(action === "like" ? { ok: true, liked: body.on !== false } : { ok: true });
    }

    // GET /reco/feed — 社区列表页的合一后台（2026-07-14）：D1 展示索引一次带回
    // 列表元数据 + 推荐序 + 每帖红心/回应数 + 我赞过的。app 的 load+rank+赞数
    // 三步并成这一步；R2 真源的 community/list 保留给老版本 app 与重建兜底。
    if (request.method === "GET" && parts[1] === "feed") {
      if (!env.DB) return json({ error: "feed unavailable" }, 503);
      const rows = await feedRows(env);
      const ids = rows.map((r) => r.share_id);
      const replyCounts = {};
      for (const r of rows) if (r.reply_to) replyCounts[r.reply_to] = (replyCounts[r.reply_to] || 0) + 1;
      const [engMap, likedSet] = await Promise.all([countsFor(env, ids), likedBy(env, scope, ids)]);
      const posts = rows.map((r) => ({
        shareId: r.share_id, author: r.author, title: r.title,
        ...(r.preview ? { preview: r.preview } : {}),
        ...(r.cover_photo_key ? { coverPhotoKey: r.cover_photo_key } : {}),
        hasPhoto: !!r.has_photo, count: r.article_count,
        firstSharedAt: r.first_shared_at, updatedAt: r.updated_at || r.first_shared_at,
        ...(r.reply_to ? { replyTo: r.reply_to } : {}),
        mine: r.owner === scope,
        likes: (engMap[r.share_id] || {}).like || 0,
        replies: replyCounts[r.share_id] || 0,
        liked: likedSet.has(r.share_id),
        kind: r.kind || "article",
      }));
      const rankInput = rows.map((r) => ({ shareId: r.share_id, firstSharedAt: r.first_shared_at,
                                           author: r.author, replyCount: replyCounts[r.share_id] || 0 }));
      // 书架进 feed：只发给认识书卡的客户端（见顶部 BOOKS_OWNER_SCOPE 注释）。
      // 客户端每个请求统一带 X-VD-Build（Networking.swift setBearer 收口，1.13(330) 起），
      // 通用版本门槛：build ≥ 330（书卡点开进书架阅读页的首发版）才混书；老版本不带
      // 此头 → parseInt NaN → 不混，feed 与从前一字不差，不存在点开失败。
      if (parseInt(request.headers.get("X-VD-Build"), 10) >= BOOKS_MIN_BUILD) {
        const books = await booksPreviewPosts(ctx);
        if (books.length) {
          posts.push(...books);
          posts.sort((a, b) => (b.firstSharedAt || 0) - (a.firstSharedAt || 0));
          rankInput.push(...books.map((b) => ({ shareId: b.shareId, firstSharedAt: b.firstSharedAt,
                                                author: b.author, replyCount: 0 })));
        }
      }
      const order = rankPosts(rankInput, engMap, Date.now());
      return json({ posts, order });
    }

    // POST /reco/rank
    // likes = 每帖被赞数（shareId → n，0 不下发）——瀑布流卡片的红心数从这里来，
    // 顺路从已经算好的 engMap 里取，不多一次查询。
    if (request.method === "POST" && parts[1] === "rank") {
      const body = await request.json().catch(() => ({}));
      const posts = Array.isArray(body.posts) ? body.posts : [];
      if (!posts.length) return json({ order: [], liked: [], likes: {} });
      if (!env.DB) return json({ order: posts.map((p) => p.shareId), liked: [], likes: {} }); // 回退:保持输入序
      const ids = posts.map((p) => p.shareId);
      const [engMap, likedSet] = await Promise.all([countsFor(env, ids), likedBy(env, scope, ids)]);
      const likes = {};
      for (const [id, eng] of Object.entries(engMap)) if (eng.like) likes[id] = eng.like;
      return json({ order: rankPosts(posts, engMap, Date.now()), liked: [...likedSet], likes });
    }

    return json({ error: "not found" }, 404);
  },
};
