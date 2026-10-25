// src/probes.ts — 三家的额度探针。解析函数是纯函数（用 2026-10-25 在 VPS 上实测的
// 真实响应做单测），网络请求单独一层。三家的用量接口都不是公开接口，随时可能改：
// 解析失败只把账号标成「未知」，不判死——事后判别（legs.ts）照样兜底。
import type { Account, EngineName } from "./config.js";
import { codexAccessToken } from "./codex-auth.js";

export type Usage = {
  used5h: number | null; // 0–100
  reset5h: number | null; // epoch ms
  used7d: number | null;
  reset7d: number | null;
  healthy: boolean; // false = 凭据失效 / 吊销 / 模型被拒 —— 要人来修
  error?: string;
  probedAt: number;
};

const pct = (x: unknown, scale = 1): number | null => {
  if (x == null || x === "") return null; // Number(null) === 0：缺字段不能当成用了 0%
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n * scale)) : null;
};
const isoMs = (x: unknown): number | null => {
  const t = typeof x === "string" ? Date.parse(x) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Kimi `GET /coding/v1/usages`：usages.limit_5h / limit_7d 的 used_ratio（0–1）。 */
export function parseKimiUsage(j: any, now = Date.now()): Usage {
  const u = j?.usages ?? {};
  let used5h = pct(u.limit_5h?.used_ratio, 100);
  let reset5h = isoMs(u.limit_5h?.reset_time);
  let used7d = pct(u.limit_7d?.used_ratio, 100);
  let reset7d = isoMs(u.limit_7d?.reset_time);
  // 老格式兜底：limits[0].detail = 5h 窗口，usage = 周
  if (used5h == null && Array.isArray(j?.limits) && j.limits[0]?.detail) {
    const d = j.limits[0].detail;
    used5h = pct(Number(d.used) / Number(d.limit), 100);
    reset5h = isoMs(d.resetTime);
  }
  if (used7d == null && j?.usage) {
    used7d = pct(Number(j.usage.used) / Number(j.usage.limit), 100);
    reset7d = isoMs(j.usage.resetTime);
  }
  return { used5h, reset5h, used7d, reset7d, healthy: true, probedAt: now };
}

/** Codex `GET wham/usage`：rate_limit.primary_window(5h) / secondary_window(周)。 */
export function parseCodexUsage(j: any, now = Date.now()): Usage {
  const rl = j?.rate_limit ?? {};
  const win = (w: any): [number | null, number | null] => {
    if (!w) return [null, null];
    const after = Number(w.reset_after_seconds);
    const at = Number(w.reset_at);
    const reset = Number.isFinite(after) ? now + after * 1000 : Number.isFinite(at) ? at * 1000 : null;
    return [pct(w.used_percent), reset];
  };
  const [used5h, reset5h] = win(rl.primary_window);
  const [used7d, reset7d] = win(rl.secondary_window);
  return { used5h, reset5h, used7d, reset7d, healthy: true, probedAt: now };
}

/** Claude 订阅：messages 响应头 anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}。 */
export function parseClaudeHeaders(h: { get(name: string): string | null }, now = Date.now()): Usage {
  const p = "anthropic-ratelimit-unified-";
  const one = (w: "5h" | "7d"): [number | null, number | null] => {
    let used = pct(h.get(`${p}${w}-utilization`), 100);
    if (h.get(`${p}${w}-status`) === "rejected") used = 100;
    const r = Number(h.get(`${p}${w}-reset`));
    return [used, Number.isFinite(r) && r > 0 ? r * 1000 : null];
  };
  const [used5h, reset5h] = one("5h");
  const [used7d, reset7d] = one("7d");
  return { used5h, reset5h, used7d, reset7d, healthy: true, probedAt: now };
}

// 凭据/模型类错误 → 不健康（要人修）；配额类 → 健康但打满；其余 → 未知（网络抖动等）。
const AUTH_RE = /\b401\b|unauthori[sz]ed|invalid.{0,12}(api[ _-]?key|token)|token_expired|refresh[ _-]?token|revoked|invalidated|not logged in|oauth_scope|authentication|permission_error|log ?in again/i;
const QUOTA_RE = /\b429\b|usage limit|quota|rate[ _-]?limit|too many requests/i;
const MODEL_RE = /model.{0,40}(does not exist|is not supported|not[ _-]?found)/i;

export function usageFromError(err: string, now = Date.now()): Usage {
  const e = err.slice(0, 400);
  if (QUOTA_RE.test(e) && !AUTH_RE.test(e))
    return { used5h: 100, reset5h: null, used7d: null, reset7d: null, healthy: true, error: e, probedAt: now };
  const healthy = !(AUTH_RE.test(e) || MODEL_RE.test(e));
  return { used5h: null, reset5h: null, used7d: null, reset7d: null, healthy, error: e, probedAt: now };
}

// codexBusy：这条链上有 run 在跑，探针只读不刷新（token 过期就跳过本轮，保留旧数据）。
export type ProbeEnv = { secrets: Record<string, string>; fetchImpl?: typeof fetch; now?: number; codexBusy?: boolean };

async function bodyErr(r: Response): Promise<string> {
  return `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`;
}

export async function probeAccount(engine: EngineName, a: Account, env: ProbeEnv): Promise<Usage> {
  const f = env.fetchImpl ?? fetch;
  const now = env.now ?? Date.now();
  const sig = AbortSignal.timeout(20_000);
  try {
    if (engine === "kimi") {
      const key = env.secrets[a.key_env ?? ""];
      if (!key) return usageFromError(`not configured: ${a.key_env} missing in .env`, now);
      const url = new URL("v1/usages", a.base_url ?? "https://api.kimi.com/coding/");
      const r = await f(url, { headers: { Authorization: `Bearer ${key}` }, signal: sig });
      if (!r.ok) return usageFromError(await bodyErr(r), now);
      return parseKimiUsage(await r.json(), now);
    }
    if (engine === "codex") {
      if (!a.codex_home) return usageFromError("not configured: codex_home missing", now);
      const t = await codexAccessToken(a.codex_home, f, now, { noRefresh: env.codexBusy });
      const r = await f("https://chatgpt.com/backend-api/wham/usage", {
        headers: { Authorization: `Bearer ${t.access_token}`, "ChatGPT-Account-Id": t.account_id ?? "", "User-Agent": "codex-cli" },
        signal: sig,
      });
      if (!r.ok) return usageFromError(await bodyErr(r), now);
      return parseCodexUsage(await r.json(), now);
    }
    if (engine === "claude") {
      const tok = env.secrets[a.token_env ?? ""];
      if (!tok) return usageFromError(`not configured: ${a.token_env} missing in .env`, now);
      // setup-token 没有 user:profile scope，读不了 oauth/usage；发一条 1 token 的 haiku，
      // 读限流响应头（实测 5h 用量仍显示 0.0，成本可忽略）。
      const r = await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: sig,
      });
      const u = parseClaudeHeaders(r.headers, now);
      if (!r.ok && r.status !== 429) return usageFromError(await bodyErr(r), now);
      if (r.status === 429 && u.used5h == null) u.used5h = 100;
      return u;
    }
    // gpt-image 读 quota_from 的账号（monitor 里处理）；seedream 无窗口，本地记账。
    return { used5h: null, reset5h: null, used7d: null, reset7d: null, healthy: true, probedAt: now };
  } catch (e: any) {
    return usageFromError(String(e?.message ?? e), now);
  }
}
