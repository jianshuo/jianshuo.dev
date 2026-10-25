// Codex 链：过期判断、刷新写回（RFC3339 last_refresh）、锁内重读、忙时不刷新。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAccessToken, jwtExpMs, needsRefresh, lock, REFRESH_TIMEOUT_MS, LOCK_STALE_MS, LOCK_WAIT_MS } from "../src/codex-auth.ts";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const NOW = Date.parse("2026-10-25T05:00:00Z");

async function home(expMs: number) {
  const d = await mkdtemp(join(tmpdir(), "codex-"));
  await writeFile(
    join(d, "auth.json"),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ aud: ["app_TESTCLIENT"] }), access_token: jwt({ exp: Math.floor(expMs / 1000) }), refresh_token: "rt-1", account_id: "acct" },
      last_refresh: "2026-10-14T13:31:56Z",
    }),
  );
  return d;
}

test("jwtExpMs / needsRefresh（提前 5 分钟）", () => {
  const t = { id_token: "", access_token: jwt({ exp: NOW / 1000 + 600 }), refresh_token: "" };
  assert.equal(jwtExpMs(t.access_token), NOW + 600_000);
  assert.equal(needsRefresh(t, NOW), false);
  assert.equal(needsRefresh(t, NOW + 301_000), true);
  assert.equal(needsRefresh({ ...t, access_token: "garbage" }, NOW), true);
});

test("没过期：不发请求，直接返回", async () => {
  const d = await home(NOW + 86400_000);
  let calls = 0;
  const t = await codexAccessToken(d, (async () => (calls++, new Response("{}"))) as any, NOW);
  assert.equal(calls, 0);
  assert.equal(t.refresh_token, "rt-1");
});

test("过期：用 id_token 的 aud 当 client_id 刷新，写回新 token + RFC3339 last_refresh + 备份", async () => {
  const d = await home(NOW - 1000);
  let body: any;
  const fake: any = async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ access_token: jwt({ exp: NOW / 1000 + 864000 }), refresh_token: "rt-2", id_token: jwt({ aud: "app_TESTCLIENT" }) }));
  };
  const t = await codexAccessToken(d, fake, NOW);
  assert.equal(body.client_id, "app_TESTCLIENT");
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "rt-1");
  assert.equal(t.refresh_token, "rt-2");
  const saved = JSON.parse(await readFile(join(d, "auth.json"), "utf8"));
  assert.equal(saved.tokens.refresh_token, "rt-2");
  assert.equal(saved.tokens.account_id, "acct", "保留 account_id");
  assert.equal(saved.last_refresh, new Date(NOW).toISOString(), "RFC3339 字符串，codex CLI 才认");
  assert.ok((await readdir(d)).some((f) => f.startsWith("auth.json.bak-")));
  assert.ok(!(await readdir(d)).includes("auth.json.lock"), "锁已释放");
});

test("两个调用同时刷新：只刷一次（锁内重读），绝不用旧 refresh token 刷第二次", async () => {
  const d = await home(NOW - 1000);
  let calls = 0;
  const fake: any = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 100));
    return new Response(JSON.stringify({ access_token: jwt({ exp: NOW / 1000 + 864000 }), refresh_token: "rt-2" }));
  };
  const [a, b] = await Promise.all([codexAccessToken(d, fake, NOW), codexAccessToken(d, fake, NOW)]);
  assert.equal(calls, 1);
  assert.equal(a.refresh_token, "rt-2");
  assert.equal(b.refresh_token, "rt-2");
});

test("锁：持锁进程崩了留下的过期锁会被等待者清掉；没过期的锁等超时报 failed to authenticate（审查 #9）", async () => {
  const d = await mkdtemp(join(tmpdir(), "lock-"));
  const p = join(d, "auth.json.lock");
  await writeFile(p, "999");
  const old = new Date(Date.now() - 120_000);
  await utimes(p, old, old);
  const release = await lock(p, 2000, 60_000); // 过期锁：立刻拿到
  await release();
  await writeFile(p, "999"); // 新鲜的锁：等不到
  await assert.rejects(lock(p, 300, 60_000), /failed to authenticate: codex auth lock timeout/);
  assert.ok(REFRESH_TIMEOUT_MS < LOCK_STALE_MS && LOCK_STALE_MS < LOCK_WAIT_MS, "持锁上限 < 过期判定 < 等锁上限");
});

test("有 run 在用这条链（noRefresh）：过期也不刷，抛错交给 monitor 保留旧数据", async () => {
  const d = await home(NOW - 1000);
  let calls = 0;
  await assert.rejects(codexAccessToken(d, (async () => (calls++, new Response("{}"))) as any, NOW, { noRefresh: true }), /deferred/);
  assert.equal(calls, 0);
});

test("刷新被拒（revoked）：原样抛出文案，auth.json 不动", async () => {
  const d = await home(NOW - 1000);
  const before = await readFile(join(d, "auth.json"), "utf8");
  const fake: any = async () => new Response('{"error":"refresh_token_invalidated"}', { status: 401 });
  await assert.rejects(codexAccessToken(d, fake, NOW), /refresh 401.*refresh_token_invalidated/);
  assert.equal(await readFile(join(d, "auth.json"), "utf8"), before);
});
