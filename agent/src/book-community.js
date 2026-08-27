// src/book-community.js — 书帖登记：书写完/修完那一刻，把书登记成社区一等帖
// （share_id = "book-<slug>"，kind:"book"），从此赞/回应/推荐排序与普通帖同权。
// 取代 reco worker 的「feed 读时混入 books JSON」旁路（9 秒慢源 + SWR 双层缓存
// + 冷 colo 首刷无书，2026-08-27 废除）。
//
// 真源：公开书架 JSON /voicedrop/books/?format=json（转发请求者 bearer——主人的
// hidden 书也会带出来，条目 hidden:true 照登记，feed 的 WHERE hidden=0 自然不出）。
// 单本登记就是「取列表 → 找 slug → upsert 一行」，零抓取逻辑复制；书架 JSON 慢
// （~9s）没关系——这是写书收尾/回填时的后台动作，不在任何用户请求路径上。
//
// 鉴权：请求者 scope == 书的 owner（books JSON 有登录态时带 owner 语义），或
// admin（FILES_TOKEN）。admin 可批量 {all:true} 回填全量书架。
//
// 路由：POST /agent/book/community  body {slug} | {slugs:[...]} | {all:true}
// 由 lab（VPS）在写书/修书收尾时调；回填也走这里。

import { bearerToken } from "../../functions/lib/auth.js";
import { upsertCommunityPost } from "../../functions/lib/community-index.js";

// 书都发布在这一个存储账号 scope 下（与 functions/voicedrop/books 的 PUBLISHER、
// 旧 reco 混入的 BOOKS_OWNER_SCOPE 同源）；只用来拼封面 R2 key。
const BOOKS_STORE_SCOPE = "users/anon-ae209ac53499d51d513425503bd134b0/";
const BOOKS_JSON_URL = "https://jianshuo.dev/voicedrop/books/?format=json";

const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// books JSON 条目 → community_posts 行。firstSharedAt 用书的诞生时间，社区时间线
// 与书架一致；updatedAt 用现在（修书重登记会把帖顶新）。
const rowOf = (b, owner) => ({
  shareId: "book-" + b.slug,
  owner: owner || BOOKS_STORE_SCOPE,
  author: b.author || "匿名",
  title: b.title || b.slug,
  preview: b.sub || null,
  coverPhotoKey: b.cover ? `${BOOKS_STORE_SCOPE}books/${b.slug}/cover.jpg` : null,
  hasPhoto: !!b.cover,
  articleCount: b.chapters || 0,
  firstSharedAt: b.createdAt || Date.now(),
  updatedAt: Date.now(),
  hidden: b.hidden === true,
  kind: "book",
});

// owner 从 _src/book.json 读（2026-08-23 起 build.mjs 写入顶层 owner；存量老书
// 没有 → 回落发布账号，行为与书架作者名兜底一致）。
async function ownerOf(env, slug) {
  try {
    const o = await env.FILES.get(`${BOOKS_STORE_SCOPE}books/${slug}/_src/book.json`);
    if (o) {
      const b = JSON.parse(await o.text());
      if (typeof b.owner === "string" && b.owner.startsWith("users/")) return b.owner;
    }
  } catch {}
  return BOOKS_STORE_SCOPE;
}

export async function handleBookCommunityRoute(url, request, env, resolveScope) {
  if (url.pathname !== "/agent/book/community" || request.method !== "POST") return null;
  const tok = bearerToken(request);
  const isAdmin = env.FILES_TOKEN && tok === env.FILES_TOKEN;
  const scope = isAdmin ? null : await resolveScope(tok, env);
  if (!isAdmin && !scope) return J({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));
  const wantAll = isAdmin && body.all === true;
  const slugs = wantAll ? null
    : [...new Set(([]).concat(body.slug || [], body.slugs || []))].filter((s) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(s));
  if (!wantAll && (!slugs || !slugs.length)) return J({ error: "bad-request", hint: "slug | slugs[] | all:true" }, 400);

  // 书架 JSON：转发请求者 bearer，主人的 hidden 书才在列表里。
  let books;
  try {
    const r = await fetch(BOOKS_JSON_URL, {
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return J({ error: "books-json " + r.status }, 502);
    books = (await r.json()).books || [];
  } catch (e) {
    return J({ error: "books-json " + String(e?.message || e).slice(0, 80) }, 502);
  }

  const targets = wantAll ? books : books.filter((b) => slugs.includes(b.slug));
  const done = [];
  for (const b of targets) {
    const owner = await ownerOf(env, b.slug);
    // 非 admin：只许书主人给自己的书登记/刷新。
    if (!isAdmin && owner !== scope) continue;
    await upsertCommunityPost(env.RECO_DB, rowOf(b, owner));
    done.push(b.slug);
  }
  const missing = wantAll ? [] : slugs.filter((s) => !done.includes(s));
  console.log(`[book-community] upserted ${done.length}${missing.length ? ` missing=${missing.join(",")}` : ""}`);
  return J({ ok: true, upserted: done.length, slugs: done, ...(missing.length ? { missing } : {}) });
}
