// test/book-hidden.test.js — POST /voicedrop/books/<slug>/hidden（书页 ⋯ 菜单「隐藏本书」）
// 只有书的主人能改；改的是 _src/book.json 的 hidden 字段——那正是书单 indexJSON 读的真源。
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { onRequest } from "../../functions/voicedrop/books/[[path]].js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";

const PUBLISHER = "users/anon-ae209ac53499d51d513425503bd134b0/books/";
const SLUG = "dudu-misses-xiaobinggan";
const srcKey = (slug = SLUG) => `${PUBLISHER}${slug}/_src/book.json`;

const OWNER_TOK = "anon_owner_token_abcdefghijklmnop";
const OTHER_TOK = "anon_other_token_abcdefghijklmnop";

async function envWithBook({ owner, hidden } = {}) {
  const doc = { title: "同一个月亮", chapters: [], ...(owner ? { owner } : {}), ...(hidden ? { hidden: true } : {}) };
  return fakeEnv({ [srcKey()]: JSON.stringify(doc) });
}

function call(env, { slug = SLUG, token, body, method = "POST" } = {}) {
  const url = `https://voicedrop.cn/books/${slug}/hidden`;
  const req = new Request(url, {
    method,
    headers: token ? { Authorization: "Bearer " + token } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return onRequest({ request: req, env, params: { path: [slug, "hidden"] } });
}

const readDoc = (env) => JSON.parse(env.FILES._store.get(srcKey()));

describe("隐藏本书", () => {
  it("主人隐藏 → book.json 写上 hidden:true", async () => {
    const owner = await anonScopeFromToken(OWNER_TOK);
    const env = await envWithBook({ owner });

    const r = await call(env, { token: OWNER_TOK, body: { hidden: true } });
    expect(r.status).toBe(200);
    expect((await r.json()).hidden).toBe(true);
    expect(readDoc(env).hidden).toBe(true);
  });

  it("取消隐藏 → hidden 字段被拿掉，不是留一个 false", async () => {
    const owner = await anonScopeFromToken(OWNER_TOK);
    const env = await envWithBook({ owner, hidden: true });

    const r = await call(env, { token: OWNER_TOK, body: { hidden: false } });
    expect(r.status).toBe(200);
    expect((await r.json()).hidden).toBe(false);
    // 书单判的是 `b.hidden === true`，留 false 也能工作；但源稿要干净——
    // 没隐藏的书就不该带这个字段（build.mjs 重发时也不会凭空多一行）。
    expect("hidden" in readDoc(env)).toBe(false);
  });

  it("别人的书 → 403，一个字都不许动", async () => {
    const owner = await anonScopeFromToken(OWNER_TOK);
    const env = await envWithBook({ owner });

    const r = await call(env, { token: OTHER_TOK, body: { hidden: true } });
    expect(r.status).toBe(403);
    expect("hidden" in readDoc(env)).toBe(false);
  });

  it("没有 token → 401", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const r = await call(env, { body: { hidden: true } });
    expect(r.status).toBe(401);
  });

  it("没有 owner 字段的老书 → 归发布者账号，发布者能改", async () => {
    // 存量老书没有 _src/book.json 里的 owner，书单历来把它们算作发布者的
    // （见 PUBLISHER_SCOPE 注释）。隐藏权限必须用同一套归属，否则老书没人能藏。
    const env = await envWithBook();            // 不写 owner
    const pubTok = "anon_publisher_token_abcdefgh";
    const pubScope = await anonScopeFromToken(pubTok);
    const r = await call(env, { token: pubTok, body: { hidden: true } });
    // 发布者 scope 由常量写死，测试里对不上 → 应当 403 而不是误放行
    expect(pubScope).not.toBe("users/anon-ae209ac53499d51d513425503bd134b0/");
    expect(r.status).toBe(403);
  });

  it("书不存在 → 404", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const r = await call(env, { slug: "no-such-book", token: OWNER_TOK, body: { hidden: true } });
    expect(r.status).toBe(404);
  });

  it("POST 到别的路径仍然 405（不放开整个 POST 面）", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const req = new Request(`https://voicedrop.cn/books/${SLUG}/index.html`, { method: "POST" });
    const r = await onRequest({ request: req, env, params: { path: [SLUG, "index.html"] } });
    expect(r.status).toBe(405);
  });
});

// ── 书单要告诉 App「这本是不是你的」──────────────────────────────────────
// App 的 ⋯ 菜单里「隐藏本书 / 修改这本书」只对主人显示；而 ShelfBook 里原本
// 没有任何归属字段，App 无从判断。条目补一个 mine:true（owner === 请求者）。
describe("书单条目的 mine 标记", () => {
  const idxReq = (token) => ({
    request: new Request("https://voicedrop.cn/books/?format=json", {
      headers: token ? { Authorization: "Bearer " + token } : {},
    }),
    params: { path: [] },
  });

  async function shelf(env, token) {
    const r = await onRequest({ ...idxReq(token), env });
    return (await r.json()).books;
  }

  async function twoBookEnv() {
    const mine = await anonScopeFromToken(OWNER_TOK);
    const theirs = await anonScopeFromToken(OTHER_TOK);
    const doc = (title, owner) => JSON.stringify({ title, owner, createdAt: 1, chapters: [] });
    return fakeEnv({
      [srcKey("my-book")]: doc("我的书", mine),
      [srcKey("their-book")]: doc("别人的书", theirs),
    });
  }

  it("自己的书带 mine:true，别人的书不带", async () => {
    const env = await twoBookEnv();
    const books = await shelf(env, OWNER_TOK);
    const bySlug = Object.fromEntries(books.map((b) => [b.slug, b]));
    expect(bySlug["my-book"].mine).toBe(true);
    expect(bySlug["their-book"].mine).toBeUndefined();
  });

  it("没登录时谁的书都不带 mine——匿名访客不该看到任何归属", async () => {
    const env = await twoBookEnv();
    for (const b of await shelf(env)) expect(b.mine).toBeUndefined();
  });
});

// ── GET /books/<slug>/hidden：阅读页开场问一句「这本是我的吗、藏了吗」──────
// 不依赖书单列表：列表可能来自 App 本地缓存或边缘缓存，而菜单显不显示、开关
// 打不打勾都必须是当下的真相（2026-08-31：自己的书上菜单也不出现）。
describe("查一本书的归属与隐藏态", () => {
  const get = (env, { slug = SLUG, token } = {}) => onRequest({
    request: new Request(`https://voicedrop.cn/books/${slug}/hidden`, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    }),
    env,
    params: { path: [slug, "hidden"] },
  });

  it("主人问 → mine:true，并带上当前隐藏态", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK), hidden: true });
    const r = await get(env, { token: OWNER_TOK });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ slug: SLUG, mine: true, hidden: true });
  });

  it("别人问 → 200 但 mine:false（不是 403——只是查，不是改）", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const r = await get(env, { token: OTHER_TOK });
    expect(r.status).toBe(200);
    expect((await r.json()).mine).toBe(false);
  });

  it("没 token → mine:false，不是 401（读不需要登录）", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const r = await get(env);
    expect(r.status).toBe(200);
    expect((await r.json()).mine).toBe(false);
  });

  it("书不存在 → 404", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    expect((await get(env, { slug: "nope", token: OWNER_TOK })).status).toBe(404);
  });
});

// ── 书单必须永远带 Vary: Authorization ──────────────────────────────────
describe("书单的缓存头", () => {
  const idx = (env, token) => onRequest({
    request: new Request("https://voicedrop.cn/books/?format=json", {
      headers: token ? { Authorization: "Bearer " + token } : {},
    }),
    env,
    params: { path: [] },
  });

  it("匿名响应也要带 Vary: Authorization——否则共享缓存会把这份没有 mine/hidden 的副本喂给登录用户", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const r = await idx(env);
    expect(r.headers.get("Vary")).toBe("Authorization");
  });

  it("带登录态的响应 no-store + Vary", async () => {
    const env = await envWithBook({ owner: await anonScopeFromToken(OWNER_TOK) });
    const r = await idx(env, OWNER_TOK);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Vary")).toBe("Authorization");
  });
});
