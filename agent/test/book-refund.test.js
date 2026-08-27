// test/book-refund.test.js — POST /agent/usage/book-refund（写书/修书失败退回预扣算力）
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { fakeD1, usageSql } from "./fakes.js";
import { handleUsageRoute } from "../src/index.js";
import { grantBucket, debit } from "../src/usage_store.js";
import { anonScopeFromToken } from "../../functions/lib/auth.js";
import { BOOK_SUANLI, BOOK_REVISE_SUANLI, bookCostUY, bookReviseCostUY, suanliToUY } from "../src/usage.js";

const SQL = usageSql();
const PATH = "/agent/usage/book-refund";
function call(env, { token, body } = {}) {
  const req = new Request("https://jianshuo.dev" + PATH, {
    method: "POST",
    headers: token ? { Authorization: "Bearer " + token } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleUsageRoute(new URL("https://jianshuo.dev" + PATH), req, env);
}

describe("book-refund", () => {
  it("无 token → 401", async () => {
    const r = await call({ USAGE: fakeD1(SQL), SESSION_SECRET: "" });
    expect(r.status).toBe(401);
  });

  it("缺 ref → 400 bad-request，不退款", async () => {
    const db = fakeD1(SQL);
    const r = await call({ USAGE: db, SESSION_SECRET: "" }, { token: "anon_noref_token_abcdefghijklmnop", body: {} });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bad-request");
    expect(db.prepare("SELECT * FROM ledger WHERE reason LIKE 'book%refund'").bind().all().results.length).toBe(0);
  });

  it("写书失败 → 退回 320，记 book-refund grant 带 ref，余额复原", async () => {
    const db = fakeD1(SQL);
    const env = { USAGE: db, SESSION_SECRET: "" };
    const tok = "anon_refund_token_abcdefghijklmnop";
    const scope = await anonScopeFromToken(tok);
    // 造够额度并模拟预扣 320（书没写成）
    await grantBucket(db, scope, suanliToUY(500), "campaign:test", null, Date.now()); // + signup 200 = 700
    await debit(db, scope, bookCostUY(), "book", { seed: "台湾" }, Date.now());         // 预扣后 380
    // 退款
    const r = await call(env, { token: tok, body: { ref: "job-abc-123" } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refunded_suanli).toBe(BOOK_SUANLI);
    expect(Math.round(body.suanli)).toBe(700); // 复原
    const grants = db.prepare("SELECT reason, detail FROM ledger WHERE reason='book-refund'").bind().all().results;
    expect(grants.length).toBe(1);
    expect(JSON.parse(grants[0].detail).ref).toBe("job-abc-123");
    expect(JSON.parse(grants[0].detail).kind).toBe("book");
  });

  it("同 ref 二次退 → deduped，不重复加钱", async () => {
    const db = fakeD1(SQL);
    const env = { USAGE: db, SESSION_SECRET: "" };
    const tok = "anon_dedup_token_abcdefghijklmnop";
    const scope = await anonScopeFromToken(tok);
    await grantBucket(db, scope, suanliToUY(500), "campaign:test", null, Date.now());
    await debit(db, scope, bookCostUY(), "book", { seed: "x" }, Date.now());
    const first = await call(env, { token: tok, body: { ref: "job-same" } });
    expect((await first.json()).refunded_suanli).toBe(BOOK_SUANLI);
    const second = await call(env, { token: tok, body: { ref: "job-same" } });
    const body2 = await second.json();
    expect(body2.deduped).toBe(true);
    expect(body2.refunded_suanli).toBe(0);
    // 只有一条 book-refund 流水
    const grants = db.prepare("SELECT id FROM ledger WHERE reason='book-refund'").bind().all().results;
    expect(grants.length).toBe(1);
  });

  it("kind:revise → 退回 40，记 book-revise-refund", async () => {
    const db = fakeD1(SQL);
    const env = { USAGE: db, SESSION_SECRET: "" };
    const tok = "anon_revref_token_abcdefghijklmnop";
    const scope = await anonScopeFromToken(tok);
    await debit(db, scope, bookReviseCostUY(), "book-revise", { slug: "entropy" }, Date.now()); // signup 200 - 40 = 160
    const r = await call(env, { token: tok, body: { ref: "entropy#1700000000000", kind: "revise" } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.refunded_suanli).toBe(BOOK_REVISE_SUANLI);
    expect(Math.round(body.suanli)).toBe(200); // 复原
    const grants = db.prepare("SELECT reason, detail FROM ledger WHERE reason='book-revise-refund'").bind().all().results;
    expect(grants.length).toBe(1);
    expect(JSON.parse(grants[0].detail).kind).toBe("revise");
  });

  it("写书退款与修书退款 ref 互不串（同 ref 字面不同 reason 各退各的）", async () => {
    const db = fakeD1(SQL);
    const env = { USAGE: db, SESSION_SECRET: "" };
    const tok = "anon_cross_token_abcdefghijklmnop";
    const scope = await anonScopeFromToken(tok);
    await grantBucket(db, scope, suanliToUY(500), "campaign:test", null, Date.now());
    // 同一 ref 字面，一次按写书退、一次按修书退：reason 不同，去重互不影响
    const a = await call(env, { token: tok, body: { ref: "shared" } });
    const b = await call(env, { token: tok, body: { ref: "shared", kind: "revise" } });
    expect((await a.json()).refunded_suanli).toBe(BOOK_SUANLI);
    expect((await b.json()).refunded_suanli).toBe(BOOK_REVISE_SUANLI);
  });
});
