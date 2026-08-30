// test/claim.test.js — GET/POST /agent/usage/claim（一生一次领 320 算力，够写一本书）
// 设计 spec：voicedrop repo docs/superpowers/specs/2026-08-30-book320-claim-design.md
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { fakeD1, usageSql, coreSql } from "./fakes.js";
import { handleUsageRoute } from "../src/index.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { BOOK_SUANLI, SIGNUP_GRANT_UY, uyToSuanli } from "../src/usage.js";
import { CLAIM_CAMPAIGN } from "../src/claim.js";

const PATH = "/agent/usage/claim";
const SIGNUP_SUANLI = uyToSuanli(SIGNUP_GRANT_UY);

function call(env, { token, method = "POST", platform } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (platform) headers["X-VD-Platform"] = platform;
  const req = new Request("https://jianshuo.dev" + PATH, { method, headers });
  return handleUsageRoute(new URL("https://jianshuo.dev" + PATH), req, env);
}

// 建一个环境；bound 里的 token 对应的 scope 预先绑好 Apple 实名。
async function makeEnv({ bound = [] } = {}) {
  const CORE = fakeD1(coreSql());
  for (const t of bound) {
    const scope = await anonScopeFromToken(t);
    CORE.prepare("INSERT INTO user_profiles (user_sub,apple_sub,linked_at) VALUES (?,?,?)")
      .bind(scope, "apple-" + scope, Date.now()).run();
  }
  return { USAGE: fakeD1(usageSql()), CORE, SESSION_SECRET: "" };
}

const grants = (db, scope) => db
  .prepare("SELECT amount_uy FROM ledger WHERE user_sub=? AND kind='grant' AND reason=?")
  .bind(scope, "campaign:" + CLAIM_CAMPAIGN).all().results;

describe("claim（一生一次领 320）", () => {
  it("无 token → 401", async () => {
    const r = await call(await makeEnv());
    expect(r.status).toBe(401);
  });

  it("绑过实名 → 首次领到 320 算力，余额 = 注册赠送 + 320", async () => {
    const tok = "anon_bound_user_abcdefghijklmnop";
    const env = await makeEnv({ bound: [tok] });
    const scope = await anonScopeFromToken(tok);

    const r = await call(env, { token: tok });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.granted_suanli).toBe(BOOK_SUANLI);
    expect(Math.round(body.suanli)).toBe(Math.round(SIGNUP_SUANLI + BOOK_SUANLI));
    expect(grants(env.USAGE, scope).length).toBe(1);
  });

  it("领取事件记进 mint 表 kind='claim'，一人一行", async () => {
    const tok = "anon_mintrow_user_abcdefghijklmn";
    const env = await makeEnv({ bound: [tok] });
    const scope = await anonScopeFromToken(tok);
    await call(env, { token: tok });

    const rows = env.USAGE.prepare("SELECT * FROM mint WHERE kind='claim'").bind().all().results;
    expect(rows.length).toBe(1);
    expect(rows[0].subject_key).toBe(CLAIM_CAMPAIGN);
    expect(rows[0].actor_sub).toBe(scope);
    expect(JSON.parse(rows[0].detail).suanli).toBe(BOOK_SUANLI);
  });

  it("mint 行的金额列全 0——不污染币价分母，也不烧投币熔断", async () => {
    const tok = "anon_zeroamt_user_abcdefghijklmn";
    const env = await makeEnv({ bound: [tok] });
    await call(env, { token: tok });

    const row = env.USAGE.prepare("SELECT * FROM mint WHERE kind='claim'").bind().all().results[0];
    expect(row.coins_uc).toBe(0);
    expect(row.price_uy).toBe(0);
    expect(row.actor_uy).toBe(0);
    expect(row.beneficiary_uy).toBe(0);
  });

  it("再领一次 → already，钱只发一次", async () => {
    const tok = "anon_twice_user_abcdefghijklmnop";
    const env = await makeEnv({ bound: [tok] });
    const scope = await anonScopeFromToken(tok);

    await call(env, { token: tok });
    const r2 = await call(env, { token: tok });
    expect(r2.status).toBe(200);
    const body = await r2.json();
    expect(body.already).toBe(true);
    expect(body.granted_suanli).toBe(0);

    expect(grants(env.USAGE, scope).length).toBe(1);
    expect(env.USAGE.prepare("SELECT * FROM mint WHERE kind='claim'").bind().all().results.length).toBe(1);
    // 余额没有二次膨胀
    expect(Math.round(body.suanli)).toBe(Math.round(SIGNUP_SUANLI + BOOK_SUANLI));
  });

  it("没绑实名 → 403 引导登录，一分钱不发", async () => {
    const tok = "anon_naked_user_abcdefghijklmnop";
    const env = await makeEnv();
    const scope = await anonScopeFromToken(tok);

    const r = await call(env, { token: tok });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("needs_apple_signin");
    expect(grants(env.USAGE, scope).length).toBe(0);
    expect(env.USAGE.prepare("SELECT * FROM mint WHERE kind='claim'").bind().all().results.length).toBe(0);
  });

  it("安卓没绑实名 → 引导微信登录", async () => {
    const env = await makeEnv();
    const r = await call(env, { token: "anon_android_user_abcdefghijklmn", platform: "android" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("needs_wechat_signin");
  });

  it("GET → 按钮状态：未领可领 / 已领标已领 / 没绑实名给出登录理由", async () => {
    const bound = "anon_getstate_bound_abcdefghijkl";
    const naked = "anon_getstate_naked_abcdefghijkl";
    const env = await makeEnv({ bound: [bound] });

    const before = await (await call(env, { token: bound, method: "GET" })).json();
    expect(before.campaign).toBe(CLAIM_CAMPAIGN);
    expect(before.suanli).toBe(BOOK_SUANLI);
    expect(before.claimed).toBe(false);
    expect(before.eligible).toBe(true);

    await call(env, { token: bound });
    const after = await (await call(env, { token: bound, method: "GET" })).json();
    expect(after.claimed).toBe(true);
    expect(after.eligible).toBe(false);

    const anon = await (await call(env, { token: naked, method: "GET" })).json();
    expect(anon.claimed).toBe(false);
    expect(anon.eligible).toBe(false);
    expect(anon.reason).toBe("needs_apple_signin");
  });

  it("USAGE 不可用 → 503，不假装领到了", async () => {
    const env = await makeEnv();
    env.USAGE = null;
    const r = await call(env, { token: "anon_degraded_user_abcdefghijklm" });
    expect(r.status).toBe(503);
  });
});
