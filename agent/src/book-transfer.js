// src/book-transfer.js — 把自己的书转给别人：POST /agent/book/transfer  body {slug, to}
//
// 书的产权真源是 R2 `books/<slug>/_src/book.json` 顶层 owner（书架 mine、隐藏开关、
// 修书/看历史、社区书帖都读它）。转让就是主人把这个字段改成别人的 scope，顺手把
// `_src/bookmeta.json` 的 scope（对话线登记，book.json 缺 owner 时的兜底）也改成
// 一致，再把书架缓存标 stale——三处口径与 functions/voicedrop/books 的 setHidden 一致。
//
// 与算力转账（transfer.js）的异同：
// - 收件人写法一样（anon-xxx 短形或 users/anon-xxx/ 全形），一样必须**已存在**——
//   查而不建，写错一个字不能凭空造号，也不能把书转进一个没人的黑洞。
// - 不要求实名：书是匿名账号下单写的，owner 不是钱；只要是这本书的主人就能转。
// - 不扣算力，不可撤回（新主人可以再转回来）。
// - author 署名不动：转的是产权，不是笔名。
//
// 为什么在 agent worker 而不是 Pages Function：收件人存在性要查 USAGE 的 account
// 表，Pages 没这个绑定；R2（FILES）两边都有。
import { bearerToken } from "../../functions/lib/auth.js";
import { normalizeScope } from "./transfer.js";
import { sendPush } from "./push.js";

// 书都发布在这一个存储账号 scope 下（与 book-community.js 的 BOOKS_STORE_SCOPE、
// functions/voicedrop/books 的 PUBLISHER 同源）。存量老书 book.json 没 owner → 算它的。
export const BOOKS_STORE_SCOPE = "users/anon-ae209ac53499d51d513425503bd134b0/";
const BOOKS = BOOKS_STORE_SCOPE + "books/";
// 与 functions/lib/books-shelf.js 的 SHELF_CACHE_KEY / invalidateShelf 同一把钥匙、同一种标法。
const SHELF_CACHE_KEY = BOOKS_STORE_SCOPE + "books-cache/shelf.json";
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const J = (x, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

const putJson = (env, key, doc) =>
  env.FILES.put(key, JSON.stringify(doc, null, 2), { httpMetadata: { contentType: "application/json" } });

async function readJson(env, key) {
  const o = await env.FILES.get(key);
  if (!o) return null;
  try { return JSON.parse(await o.text()); } catch { return undefined; }   // undefined = 有文件但坏了
}

// 直写 R2、不经 files API，得自己作废书架缓存（逻辑照抄 invalidateShelf：只标不删，
// 已标过就不重写）。失败不连累转让——缓存最多晚几分钟自己过期。
async function markShelfStale(env) {
  try {
    const c = await readJson(env, SHELF_CACHE_KEY);
    if (!c || !Array.isArray(c.books) || c.staleAt) return;
    await putJson(env, SHELF_CACHE_KEY, { ...c, staleAt: Date.now() });
  } catch {}
}

export async function handleBookTransferRoute(url, request, env, resolveScope) {
  if (url.pathname !== "/agent/book/transfer" || request.method !== "POST") return null;
  if (!env.USAGE || !env.FILES) return J({ error: "degraded" }, 503);

  const from = await resolveScope(bearerToken(request), env);
  if (!from) return J({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug ?? "").trim();
  if (!SLUG_RE.test(slug)) return J({ error: "bad_slug" }, 400);
  const to = normalizeScope(body.to);
  if (!to) return J({ error: "bad_to" }, 400);
  if (to === from) return J({ error: "self_transfer" }, 400);

  const bookKey = `${BOOKS}${slug}/_src/book.json`;
  const book = await readJson(env, bookKey);
  if (book === null) return J({ error: "no_book" }, 404);
  if (book === undefined) return J({ error: "bad_book_json" }, 500);
  const owner = (typeof book.owner === "string" && book.owner.startsWith("users/")) ? book.owner : BOOKS_STORE_SCOPE;
  if (owner !== from) return J({ error: "not_owner" }, 403);

  // 收件人必须已经存在——查而不建（ensureAccount 会发注册礼包）。
  const exists = await env.USAGE.prepare("SELECT 1 AS ok FROM account WHERE user_sub=?").bind(to).first();
  if (!exists) return J({ error: "no_such_user" }, 404);

  book.owner = to;
  await putJson(env, bookKey, book);

  // 对话线登记：有就同步，没有（登记簿上线前的老书）不补——它只是 book.json 缺 owner
  // 时的兜底，如今 owner 已经写实了。
  const metaKey = `${BOOKS}${slug}/_src/bookmeta.json`;
  try {
    const meta = await readJson(env, metaKey);
    if (meta && typeof meta === "object") { meta.scope = to; await putJson(env, metaKey, meta); }
  } catch (e) { console.log("[book-transfer] bookmeta sync failed", slug, String(e?.message || e)); }

  await markShelfStale(env);

  const title = String(book.title || book.main || slug);
  try {
    await sendPush(env, to, {
      title: "收到一本书",
      body: `有人把《${title}》转给了你，现在它是你的了`,
      threadId: "book-transfer", link: `https://voicedrop.cn/books/${slug}/`, source: "book-transfer",
    });
  } catch (e) { console.log("[book-transfer] push failed", slug, String(e?.message || e)); }

  return J({ ok: true, slug, title, from, to });
}
