// test/transfer_route.test.js — POST /agent/usage/transfer（MCP transfer_credit 的后端）
//
// 花自己的钱可以匿名，把钱给别人不行：转出方必须是可追责身份（Apple / 微信实名
// session，或绑过实名的匿名 scope）。闸门口径与投币（mint.js）逐字一致——同一条
// 规则出现两处，行为必须完全一样，否则「哪些操作需要实名」会变成一笔糊涂账。
import { vi, describe, it, expect, beforeEach } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
vi.mock("../src/push.js", () => ({ sendPush: vi.fn(async () => true) }));
import { sendPush } from "../src/push.js";

import { fakeD1, usageSql, coreSql } from "./fakes.js";
import { handleUsageRoute } from "../src/index.js";
import { ensureAccount, balanceUY } from "../src/usage_store.js";
import { coreUpsertProfile } from "../../functions/lib/core-db.js";
import { hmacSign, b64url, anonScopeFromToken } from "../../functions/lib/auth.js";
import { SIGNUP_GRANT_UY, suanliToUY, uyToSuanli, TRANSFER_MAX_SUANLI, TRANSFER_DAILY_SUANLI } from "../src/usage.js";

const SQL = usageSql();
const SECRET = "test-secret";
const PATH = "/agent/usage/transfer";

const ANON_TOK = "anon_sendertoken_abcdefghijklmnop";
const BOB = "users/anon-bob222/";

async function sessionToken(scope, extra = { apple: true }) {
  const h = b64url(JSON.stringify({ alg: "HS256" }));
  const p = b64url(JSON.stringify({ scope, ...extra }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

// 注册桶按发放时刻起算一年有效，而路由用的是真实 Date.now()——夹具必须用同一条
// 时间轴建号，否则余额一上来就是「已过期」。
let env, db, T0;
beforeEach(async () => {
  vi.clearAllMocks();
  db = fakeD1(SQL);
  T0 = Date.now();
  env = { USAGE: db, CORE: fakeD1(coreSql()), SESSION_SECRET: SECRET };
  await ensureAccount(db, BOB, T0);
});

function post(body, { token, platform } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (platform) headers["X-VD-Platform"] = platform;
  const request = new Request("https://jianshuo.dev" + PATH, { method: "POST", headers, body: JSON.stringify(body) });
  return handleUsageRoute(new URL("https://jianshuo.dev" + PATH), request, env);
}

describe("POST /agent/usage/transfer — 实名闸门", () => {
  it("从没绑过实名的匿名 token → 403 引导登录，且分文未动", async () => {
    const from = await anonScopeFromToken(ANON_TOK);
    await ensureAccount(db, from, T0);
    const r = await post({ to: "anon-bob222", suanli: 10 }, { token: ANON_TOK });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("needs_apple_signin");
    expect(await balanceUY(db, from, T0)).toBe(SIGNUP_GRANT_UY);
    expect(await balanceUY(db, BOB, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it("安卓端拿到的是微信登录引导", async () => {
    const from = await anonScopeFromToken(ANON_TOK);
    await ensureAccount(db, from, T0);
    const r = await post({ to: "anon-bob222", suanli: 10 }, { token: ANON_TOK, platform: "android" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("needs_wechat_signin");
  });

  it("session 有 scope 但没实名（既非 apple 也非 wechat）→ 403", async () => {
    const from = "users/anon-alice1/";
    await ensureAccount(db, from, T0);
    const tok = await sessionToken(from, {});
    const r = await post({ to: "anon-bob222", suanli: 10 }, { token: tok });
    expect(r.status).toBe(403);
    expect(await balanceUY(db, from, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it("绑过实名的匿名 scope 放行（MCP 配对 token 走这条）", async () => {
    const from = await anonScopeFromToken(ANON_TOK);
    await ensureAccount(db, from, T0);
    await coreUpsertProfile(env, from, { apple_sub: "apple-123" });
    const r = await post({ to: "anon-bob222", suanli: 23 }, { token: ANON_TOK });
    expect(r.status).toBe(200);
    expect(await balanceUY(db, from, T0)).toBe(SIGNUP_GRANT_UY - suanliToUY(23));
    expect(await balanceUY(db, BOB, T0)).toBe(SIGNUP_GRANT_UY + suanliToUY(23));
  });
});

describe("POST /agent/usage/transfer — 转账本身", () => {
  const ALICE = "users/anon-alice1/";
  let tok;
  beforeEach(async () => {
    await ensureAccount(db, ALICE, T0);
    tok = await sessionToken(ALICE, { apple: true });
  });

  it("实名用户转账成功：两边余额各自加减，返回体给出这一笔和转出方新余额", async () => {
    const r = await post({ to: "anon-bob222", suanli: 23, note: "谢谢" }, { token: tok });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.transferred_suanli).toBe(23);
    expect(body.to).toBe(BOB);
    expect(Math.round(body.suanli)).toBe(Math.round(uyToSuanli(SIGNUP_GRANT_UY - suanliToUY(23))));
    expect(typeof body.transfer_id).toBe("string");
    expect(await balanceUY(db, BOB, T0)).toBe(SIGNUP_GRANT_UY + suanliToUY(23));
  });

  it("收款人写完整 scope 也行（users/anon-xxx/ 与 anon-xxx 等价）", async () => {
    const r = await post({ to: "users/anon-bob222/", suanli: 23 }, { token: tok });
    expect(r.status).toBe(200);
    expect(await balanceUY(db, BOB, T0)).toBe(SIGNUP_GRANT_UY + suanliToUY(23));
  });

  it("收款人不存在 → 404，而且绝不能顺手把号建出来", async () => {
    const r = await post({ to: "anon-ghost99", suanli: 23 }, { token: tok });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("no_such_user");
    // ensureAccount 会给新号发 200 算力注册礼包——打错一个字就凭空造钱，必须查而不建。
    const ghost = db.prepare("SELECT 1 AS ok FROM account WHERE user_sub=?").bind("users/anon-ghost99/").first();
    expect(ghost).toBe(null);
    expect(await balanceUY(db, ALICE, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it("转给自己 → 400，钱不动", async () => {
    const r = await post({ to: "anon-alice1", suanli: 23 }, { token: tok });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("self_transfer");
    expect(await balanceUY(db, ALICE, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it("余额不足 → 402，带上还差多少，两边分文未动", async () => {
    const r = await post({ to: "anon-bob222", suanli: 5000 }, { token: tok });
    expect(r.status).toBe(402);
    const b = await r.json();
    expect(b.error).toBe("insufficient");
    expect(b.need_suanli).toBe(5000);
    expect(Math.round(b.suanli)).toBe(200);
    expect(await balanceUY(db, ALICE, T0)).toBe(SIGNUP_GRANT_UY);
    expect(await balanceUY(db, BOB, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it.each([
    ["零", 0], ["负数", -5], ["小数", 1.5], ["超单笔上限", TRANSFER_MAX_SUANLI + 1], ["不是数", "abc"],
  ])("金额%s → 400", async (_label, suanli) => {
    const r = await post({ to: "anon-bob222", suanli }, { token: tok });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bad_amount");
    expect(await balanceUY(db, ALICE, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it("收款人 id 格式非法 → 400", async () => {
    const r = await post({ to: "../../etc/passwd", suanli: 23 }, { token: tok });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bad_to");
  });

  it("同一个幂等键重复提交只动一次钱", async () => {
    const args = { to: "anon-bob222", suanli: 23, idempotency_key: "k1" };
    expect((await post(args, { token: tok })).status).toBe(200);
    const second = await post(args, { token: tok });
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    expect(await balanceUY(db, ALICE, T0)).toBe(SIGNUP_GRANT_UY - suanliToUY(23));
    expect(await balanceUY(db, BOB, T0)).toBe(SIGNUP_GRANT_UY + suanliToUY(23));
  });

  it("超出单日累计上限 → 429（按 transfer 表近 24 小时统计，不是按单笔）", async () => {
    // 先塞满当日额度（直接写 transfer 表：这里要测的是限额判定，不是转账本身）
    db.prepare("INSERT INTO transfer (id,from_sub,to_sub,amount_uy,note,ts) VALUES (?,?,?,?,?,?)")
      .bind("earlier", ALICE, BOB, suanliToUY(TRANSFER_DAILY_SUANLI), null, T0 - 1000).run();
    const r = await post({ to: "anon-bob222", suanli: 1 }, { token: tok });
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("daily_limit");
    expect(await balanceUY(db, ALICE, T0)).toBe(SIGNUP_GRANT_UY);
  });

  it("到账给收款人推一条通知", async () => {
    await post({ to: "anon-bob222", suanli: 23 }, { token: tok });
    expect(sendPush).toHaveBeenCalled();
    expect(sendPush.mock.calls[0][1]).toBe(BOB);   // 推给收款方，不是转出方
  });
});
