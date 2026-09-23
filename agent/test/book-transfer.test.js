// test/book-transfer.test.js — POST /agent/book/transfer（MCP transfer_book 的后端）
//
// 书的产权真源是 R2 `books/<slug>/_src/book.json` 顶层 owner。转让 = 主人把它改成
// 别人的 scope。不扣算力、不要求实名（书是匿名账号下单写的，owner 不是钱），但
// 收件人必须是**已经存在**的账号——查而不建，写错一个字不能凭空造号。
import { vi, describe, it, expect, beforeEach } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
vi.mock("../src/push.js", () => ({ sendPush: vi.fn(async () => true) }));
import { sendPush } from "../src/push.js";

import { fakeEnv, fakeD1, usageSql } from "./fakes.js";
import { handleBookTransferRoute } from "../src/book-transfer.js";
import { resolveScope } from "../src/index.js";
import { ensureAccount } from "../src/usage_store.js";
import { anonScopeFromToken, hmacSign, b64url } from "../../functions/lib/auth.js";

const PUBLISHER = "users/anon-ae209ac53499d51d513425503bd134b0/";
const BOOKS = PUBLISHER + "books/";
const SHELF_CACHE = PUBLISHER + "books-cache/shelf.json";
const SLUG = "dudu-koala-quarrel";
const bookKey = (slug = SLUG) => `${BOOKS}${slug}/_src/book.json`;
const metaKey = (slug = SLUG) => `${BOOKS}${slug}/_src/bookmeta.json`;
const PATH = "/agent/book/transfer";
const SECRET = "test-secret";

const OWNER_TOK = "anon_owner_token_abcdefghijklmnop";
const OTHER_TOK = "anon_other_token_abcdefghijklmnop";
const JINZI = "users/anon-8daa69bf7d1ecf4ad1f7af665dab4cff/";

async function sessionToken(scope, extra = {}) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, ...extra }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

let env, owner, other;
beforeEach(async () => {
  vi.clearAllMocks();
  owner = await anonScopeFromToken(OWNER_TOK);
  other = await anonScopeFromToken(OTHER_TOK);
  env = {
    ...fakeEnv({
      [bookKey()]: JSON.stringify({ slug: SLUG, title: "两棵树之间", author: "王建硕", owner, chapters: [] }),
      [metaKey()]: JSON.stringify({ slug: SLUG, scope: owner, author: "王建硕", thread: [{ ts: 1, kind: "create" }] }),
      [SHELF_CACHE]: JSON.stringify({ books: [{ slug: SLUG }], builtAt: 1 }),
    }),
    USAGE: fakeD1(usageSql()),
    SESSION_SECRET: SECRET,
  };
  await ensureAccount(env.USAGE, JINZI, Date.now());
  await ensureAccount(env.USAGE, owner, Date.now());
});

function post(body, { token, method = "POST", path = PATH } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const request = new Request("https://voicedrop-agent.jianshuo.workers.dev" + path,
    { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  return handleBookTransferRoute(new URL(request.url), request, env, resolveScope);
}

const readJson = (key) => JSON.parse(env.FILES._store.get(key));

describe("POST /agent/book/transfer — 路由与鉴权", () => {
  it("别的路径 / 别的 method 不接（返回 null 让后面的路由继续）", async () => {
    expect(await post({}, { token: OWNER_TOK, path: "/agent/book/community" })).toBeNull();
    expect(await post({}, { token: OWNER_TOK, method: "GET" })).toBeNull();
  });

  it("没 token → 401", async () => {
    const r = await post({ slug: SLUG, to: JINZI });
    expect(r.status).toBe(401);
    expect(readJson(bookKey()).owner).toBe(owner);
  });

  it("不是主人 → 403 not_owner，book.json 一字不动", async () => {
    const r = await post({ slug: SLUG, to: JINZI }, { token: OTHER_TOK });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("not_owner");
    expect(readJson(bookKey()).owner).toBe(owner);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("老书（book.json 没 owner）算发布账号的：发布账号能转，别人不能", async () => {
    env.FILES._store.set(bookKey(), JSON.stringify({ slug: SLUG, title: "老书" }));
    const r1 = await post({ slug: SLUG, to: JINZI }, { token: OTHER_TOK });
    expect(r1.status).toBe(403);
    const r2 = await post({ slug: SLUG, to: JINZI }, { token: await sessionToken(PUBLISHER, { apple: true }) });
    expect(r2.status).toBe(200);
    expect(readJson(bookKey()).owner).toBe(JINZI);
  });
});

describe("POST /agent/book/transfer — 参数校验", () => {
  it("slug 不合法 → 400 bad_slug；书不存在 → 404 no_book", async () => {
    const r1 = await post({ slug: "../x", to: JINZI }, { token: OWNER_TOK });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe("bad_slug");
    const r2 = await post({ slug: "no-such-book", to: JINZI }, { token: OWNER_TOK });
    expect(r2.status).toBe(404);
    expect((await r2.json()).error).toBe("no_book");
  });

  it("to 缺失或不合法 → 400 bad_to", async () => {
    for (const to of [undefined, "", "users/", "bad scope!"]) {
      const r = await post({ slug: SLUG, to }, { token: OWNER_TOK });
      expect(r.status, `to=${to}`).toBe(400);
      expect((await r.json()).error).toBe("bad_to");
    }
  });

  it("转给自己 → 400 self_transfer（短形和全形都算同一个人）", async () => {
    const short = owner.replace(/^users\//, "").replace(/\/$/, "");
    for (const to of [owner, short]) {
      const r = await post({ slug: SLUG, to }, { token: OWNER_TOK });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("self_transfer");
    }
  });

  it("收件人账号不存在 → 404 no_such_user，且不会顺手把号建出来", async () => {
    const r = await post({ slug: SLUG, to: "anon-nobody-here" }, { token: OWNER_TOK });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("no_such_user");
    const row = await env.USAGE.prepare("SELECT 1 AS ok FROM account WHERE user_sub=?").bind("users/anon-nobody-here/").first();
    expect(row).toBeFalsy();
    expect(readJson(bookKey()).owner).toBe(owner);
  });

  it("USAGE 库不在 → 503 degraded（宁可拒绝也不能跳过收件人存在性检查）", async () => {
    delete env.USAGE;
    const r = await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    expect(r.status).toBe(503);
  });
});

describe("POST /agent/book/transfer — 转让落地", () => {
  it("主人转给金子：book.json owner + bookmeta.json scope 都改，其余字段原样", async () => {
    const r = await post({ slug: SLUG, to: "anon-8daa69bf7d1ecf4ad1f7af665dab4cff" }, { token: OWNER_TOK });
    expect(r.status).toBe(200);
    const out = await r.json();
    expect(out).toMatchObject({ ok: true, slug: SLUG, title: "两棵树之间", from: owner, to: JINZI });

    const book = readJson(bookKey());
    expect(book.owner).toBe(JINZI);
    expect(book).toMatchObject({ slug: SLUG, title: "两棵树之间", author: "王建硕", chapters: [] });

    const meta = readJson(metaKey());
    expect(meta.scope).toBe(JINZI);
    expect(meta.thread).toEqual([{ ts: 1, kind: "create" }]);
  });

  it("author 署名不动——用户只说转 owner", async () => {
    await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    expect(readJson(bookKey()).author).toBe("王建硕");
  });

  it("书架缓存被标 stale，下次刷新 mine 才会翻过来", async () => {
    await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    expect(readJson(SHELF_CACHE).staleAt).toBeGreaterThan(0);
  });

  it("bookmeta.json 不存在（登记簿上线前的老书）不算错：只改 book.json", async () => {
    env.FILES._store.delete(metaKey());
    const r = await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    expect(r.status).toBe(200);
    expect(readJson(bookKey()).owner).toBe(JINZI);
    expect(env.FILES._store.has(metaKey())).toBe(false);
  });

  it("给收件人推一条通知，带书名和链接", async () => {
    await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    expect(sendPush).toHaveBeenCalledTimes(1);
    const [, to, payload] = sendPush.mock.calls[0];
    expect(to).toBe(JINZI);
    expect(payload.body).toMatch(/两棵树之间/);
    expect(payload.link).toBe(`https://voicedrop.cn/books/${SLUG}/`);
    expect(payload.source).toBe("book-transfer");
  });

  it("推送失败不连累转让（产权已经落 R2）", async () => {
    sendPush.mockRejectedValueOnce(new Error("apns down"));
    const r = await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    expect(r.status).toBe(200);
    expect(readJson(bookKey()).owner).toBe(JINZI);
  });

  it("转出去以后原主人再转 → 403（不再是主人）；新主人能再转回来", async () => {
    await post({ slug: SLUG, to: JINZI }, { token: OWNER_TOK });
    const again = await post({ slug: SLUG, to: other }, { token: OWNER_TOK });
    expect(again.status).toBe(403);
    await ensureAccount(env.USAGE, other, Date.now());
    const back = await post({ slug: SLUG, to: other }, { token: await sessionToken(JINZI, { wechat: true }) });
    expect(back.status).toBe(200);
    expect(readJson(bookKey()).owner).toBe(other);
  });
});
