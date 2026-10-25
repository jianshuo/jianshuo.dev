// 探针解析：输入全部是 2026-10-25 在 Tokyo VPS 上实测的真实响应。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKimiUsage, parseCodexUsage, parseClaudeHeaders, usageFromError, probeAccount } from "../src/probes.ts";

const NOW = Date.parse("2026-10-25T05:20:00Z");

test("Kimi /coding/v1/usages 实测响应", () => {
  const j = {
    usage: { limit: "100", used: "55", remaining: "45", resetTime: "2026-10-30T06:40:24.980575Z" },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "44", remaining: "56", resetTime: "2026-10-25T07:40:24.980575Z" } }],
    usages: { limit_5h: { used_ratio: 0.4405, reset_time: "2026-10-25T07:40:24Z" }, limit_7d: { used_ratio: 0.5488, reset_time: "2026-10-30T06:40:24Z" } },
  };
  const u = parseKimiUsage(j, NOW);
  assert.equal(Math.round(u.used5h!), 44);
  assert.equal(Math.round(u.used7d!), 55);
  assert.equal(u.reset5h, Date.parse("2026-10-25T07:40:24Z"));
  assert.equal(u.reset7d, Date.parse("2026-10-30T06:40:24Z"));
  // 只有老字段时也能解析
  const old = parseKimiUsage({ usage: j.usage, limits: j.limits }, NOW);
  assert.equal(Math.round(old.used5h!), 44);
  assert.equal(Math.round(old.used7d!), 55);
});

test("Codex wham/usage 实测响应", () => {
  const u = parseCodexUsage({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 6309 }, secondary_window: { used_percent: 4, reset_after_seconds: 523889 } } }, NOW);
  assert.equal(u.used5h, 10);
  assert.equal(u.used7d, 4);
  assert.equal(u.reset5h, NOW + 6309_000);
  assert.equal(u.reset7d, NOW + 523889_000);
});

test("Claude 限流响应头实测", () => {
  const h = new Headers({
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.0",
    "anthropic-ratelimit-unified-5h-reset": "1792922400",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.19",
    "anthropic-ratelimit-unified-7d-reset": "1793088000",
  });
  const u = parseClaudeHeaders(h, NOW);
  assert.equal(u.used5h, 0);
  assert.equal(u.used7d, 19);
  assert.equal(u.reset5h, 1792922400_000);
  const rejected = parseClaudeHeaders(new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-utilization": "0.97" }), NOW);
  assert.equal(rejected.used5h, 100);
});

test("错误分类：凭据 → 不健康；配额 → 打满；网络 → 未知但健康", () => {
  // 实测：两条 Codex 链 access token 过期
  assert.equal(usageFromError('HTTP 401: {"error":{"message":"Provided authentication token is expired.","code":"token_expired"}}').healthy, false);
  // 实测：setup-token 读不了 oauth/usage
  assert.equal(usageFromError('HTTP 403: {"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}').healthy, false);
  assert.equal(usageFromError("codex refresh 401: refresh_token_invalidated").healthy, false);
  assert.equal(usageFromError("not configured: KIMI_KEY_1 missing in .env").healthy, true);
  const q = usageFromError("HTTP 429: You've reached your 5-hour usage limit");
  assert.equal(q.healthy, true);
  assert.equal(q.used5h, 100);
  const net = usageFromError("fetch failed: ECONNRESET");
  assert.equal(net.healthy, true);
  assert.equal(net.used5h, null);
  assert.equal(usageFromError("HTTP 400: The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.").healthy, false);
});

test("probeAccount：Kimi 走 /v1/usages，Claude 429 视为打满", async () => {
  const seen: string[] = [];
  const fakeFetch: any = async (url: any, init: any) => {
    seen.push(String(url));
    if (String(url).includes("kimi")) {
      assert.equal(init.headers.Authorization, "Bearer kk");
      return new Response(JSON.stringify({ usages: { limit_5h: { used_ratio: 0.5, reset_time: "2026-10-25T07:00:00Z" }, limit_7d: { used_ratio: 0.2, reset_time: "2026-10-30T07:00:00Z" } } }));
    }
    return new Response("{}", { status: 429, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.4" } });
  };
  const k = await probeAccount("kimi", { id: "kimi-1", key_env: "K" }, { secrets: { K: "kk" }, fetchImpl: fakeFetch, now: NOW });
  assert.equal(k.used5h, 50);
  assert.equal(seen[0], "https://api.kimi.com/coding/v1/usages");
  const c = await probeAccount("claude", { id: "c", token_env: "T" }, { secrets: { T: "tt" }, fetchImpl: fakeFetch, now: NOW });
  assert.equal(c.used5h, 100);
  assert.equal(c.used7d, 40);
  const missing = await probeAccount("claude", { id: "c", token_env: "NOPE" }, { secrets: {}, fetchImpl: fakeFetch, now: NOW });
  assert.match(missing.error!, /not configured/);
});
