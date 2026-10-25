// src/selector.ts — 挑账号。纯函数：输入配置、用量、在飞预留、冷却、请求，输出选中的
// (engine, account) 和每个候选的理由。状态页和 POST /v1/select 干跑直接展示这些理由。
//
// 一个账号合格要同时满足：健康、不在冷却、并发未满、5 小时余量够、周配速线以下。
// 周配速：一周过了 x% 的时间，最多用到 x% + slack（且不超过 cap_7d）——防止周初
// 就把一周的额度烧完。
import {
  ENGINE_KIND,
  ENGINE_NAMES,
  DEFAULT_ESTIMATE,
  acctKey,
  policyFor,
  limitsFor,
  type PickLimits,
  type Account,
  type Config,
  type EngineName,
  type Estimate,
  type Kind,
  type Strategy,
} from "./config.js";
import type { Usage } from "./probes.js";
import type { Capabilities } from "./spec.js";

const WEEK_MS = 7 * 86400_000;
const DEFAULT_ORDER: EngineName[] = ["kimi", "codex", "claude", "gpt-image", "seedream"];

export type Inflight = Record<string, { count: number; d5h: number; d7d: number }>;

export type SelectState = {
  usage: Record<string, Usage>; // 按「额度键」存：gpt-image/codex-1 读 codex/codex-1
  inflight: Inflight; // 并发按真实账号键，预留按额度键（见 reserveKeys）
  cooldown: Record<string, number>; // 额度键 → 冷却到（ms）
  dailyCount: Record<string, number>; // seedream 当日张数，按账号键
  learned: Record<string, Estimate>; // `${taskClass}|${engine}` → 学到的单次消耗
  cursors: Record<string, number>; // round_robin 游标（会被就地推进）
};

export type SelectRequest = {
  kind: Kind;
  taskClass?: string;
  size?: "small" | "medium" | "large";
  avoid?: EngineName[]; // 软：排到最后
  require?: EngineName[]; // 硬：只在这些引擎里挑
  allow?: string[]; // 硬：只在这些账号键里挑（会话 strict 档用）
  exclude?: string[]; // 硬：本 run 里已经倒下过的账号键
  prefer?: string; // 粘性：合格就直接用它（会话续接用原账号）
  capabilities?: Capabilities; // 硬：做不到这些限制的引擎不选
  force?: boolean; // 无视配速和红线，只要没撞墙
};

export type Candidate = {
  engine: EngineName;
  id: string;
  key: string;
  eligible: boolean;
  reason: string;
  headroom: number | null; // null = 用量未知
  waitUntil?: number;
};

export type SelectResult = {
  pick: { engine: EngineName; account: Account; key: string; estimate: Estimate } | null;
  candidates: Candidate[];
  waitUntil: number | null; // 全部不合格时，最早可能有账号恢复的时刻
};

/**
 * 这个引擎能不能真正落实调用方要求的限制？做不到就返回理由（不选它），而不是假装做到：
 * - codex：唯一的工具就是 shell，关不掉；network:false 靠 workspace-write 沙箱（默认断网），
 *   write:false 靠 read-only 沙箱。
 * - claude / kimi（Claude Code CLI）：只要 Bash 在，curl 就能出网——network:false 必须同时 shell:false
 *   （届时连 WebFetch/WebSearch 一起禁）。
 */
export function capabilityGap(engine: EngineName, caps: Capabilities | undefined): string {
  if (!caps) return "";
  if (engine === "codex" && caps.shell === false) return "cannot enforce shell:false (codex only acts through shell)";
  if ((engine === "claude" || engine === "kimi") && caps.network === false && caps.shell !== false)
    return "cannot enforce network:false while shell is allowed";
  return "";
}

export function quotaKey(cfg: Config, engine: EngineName, id: string): string {
  const from = cfg.engines[engine]?.quota_from;
  return acctKey(from ?? engine, id);
}

/** 一个 run 占用的键：并发记在真实账号上，额度预留记在额度键上。 */
export function reserveKeys(cfg: Config, engine: EngineName, id: string): { conc: string; quota: string } {
  return { conc: acctKey(engine, id), quota: quotaKey(cfg, engine, id) };
}

export function estimateFor(cfg: Config, st: Pick<SelectState, "learned">, taskClass: string | undefined, engine: EngineName, size?: string): Estimate {
  const cls = taskClass ?? "default";
  const base = st.learned[`${cls}|${engine}`] ?? cfg.estimates[cls]?.[engine] ?? cfg.estimates.default?.[engine] ?? DEFAULT_ESTIMATE;
  const mul = size === "small" ? 0.5 : size === "large" ? 2 : 1;
  return { d5h: base.d5h * mul, d7d: base.d7d * mul };
}

/**
 * 周配速线（0–100）：本周已过时间比例 × 100 + slack，封顶 cap_7d。reset 未知时只看 cap。
 * pacing:false（例如出图策略）= 不配速，线就是 cap_7d——用到快满才换下一个。
 */
export function weeklyLine(lim: Pick<PickLimits, "cap_7d" | "weekly_slack"> & { pacing?: boolean }, reset7d: number | null, now: number): number {
  if (!reset7d || lim.pacing === false) return lim.cap_7d;
  const elapsed = Math.max(0, Math.min(1, 1 - (reset7d - now) / WEEK_MS));
  return Math.min(lim.cap_7d, elapsed * 100 + lim.weekly_slack);
}

function staleAfter(cfg: Config, engine: EngineName): number {
  const s = engine === "claude" ? cfg.limits.claude_probe_every_s : cfg.limits.probe_every_s;
  return 2.5 * s * 1000;
}

function evaluate(cfg: Config, lim: PickLimits, st: SelectState, req: SelectRequest, engine: EngineName, a: Account, now: number): Candidate {
  const key = acctKey(engine, a.id);
  const qk = quotaKey(cfg, engine, a.id);
  const c: Candidate = { engine, id: a.id, key, eligible: false, reason: "", headroom: null };
  if (a.disabled) return { ...c, reason: "disabled" };
  if (req.allow && !req.allow.includes(key)) return { ...c, reason: "not allowed for this thread" };
  if (req.exclude?.includes(key)) return { ...c, reason: "refused this task in this run" };
  const gap = capabilityGap(engine, req.capabilities);
  if (gap) return { ...c, reason: gap };
  const busy = st.inflight[key]?.count ?? 0;
  if (busy >= cfg.concurrency.per_account) return { ...c, reason: `busy (${busy} running)`, waitUntil: now + 30_000 };
  const cool = st.cooldown[qk] ?? 0;
  if (cool > now) return { ...c, reason: `cooling down until ${new Date(cool).toISOString()}`, waitUntil: cool };
  const weight = a.weight ?? 1;

  if (engine === "seedream") {
    const cap = a.daily_cap ?? 200;
    const n = st.dailyCount[key] ?? 0;
    if (n >= cap && !req.force) {
      const tomorrow = new Date(now);
      tomorrow.setUTCHours(24, 0, 0, 0);
      return { ...c, reason: `daily cap reached (${n}/${cap})`, waitUntil: tomorrow.getTime() };
    }
    return { ...c, eligible: true, reason: `${n}/${cap} today`, headroom: ((cap - n) / cap) * 100 * weight };
  }

  const u = st.usage[qk];
  // 不健康也给个「下次探测」的恢复时刻：排队模式会等它重探，而不是当它永远回不来直接判失败。
  if (u && !u.healthy)
    return { ...c, reason: `unhealthy: ${u.error ?? "?"}`, waitUntil: Math.max(now + 60_000, u.probedAt + staleAfter(cfg, engine) / 2.5) };
  if (!u || now - u.probedAt > staleAfter(cfg, engine) || (u.used5h == null && u.used7d == null))
    return { ...c, eligible: true, reason: "usage unknown" };

  const est = estimateFor(cfg, st, req.taskClass, engine, req.size);
  const res = st.inflight[qk] ?? { count: 0, d5h: 0, d7d: 0 };
  const used5h = (u.used5h ?? 0) + res.d5h;
  const used7d = (u.used7d ?? 0) + res.d7d;
  const line = weeklyLine(lim, u.reset7d, now);
  const lineName = lim.pacing === false ? "week cap" : "pace line";
  if (req.force) {
    if ((u.used5h ?? 0) >= 100) return { ...c, reason: "5h window exhausted", waitUntil: u.reset5h ?? now + 1800_000 };
    if ((u.used7d ?? 0) >= 100) return { ...c, reason: "weekly quota exhausted", waitUntil: u.reset7d ?? undefined };
  } else {
    if (used5h + est.d5h > lim.cap_5h)
      return {
        ...c,
        reason: `5h ${fmt(used5h)}% + est ${fmt(est.d5h)} > cap ${lim.cap_5h}`,
        waitUntil: u.reset5h ?? now + 1800_000,
      };
    if (used7d + est.d7d > line) {
      // 配速线随时间上涨：算出线涨到够用的时刻；超过 cap_7d（或不配速）就只能等周重置。
      const need = used7d + est.d7d;
      let wait = u.reset7d ?? now + 3600_000;
      if (lim.pacing !== false && u.reset7d && need <= lim.cap_7d) wait = u.reset7d - WEEK_MS + ((need - lim.weekly_slack) / 100) * WEEK_MS;
      return { ...c, reason: `week ${fmt(used7d)}% + est ${fmt(est.d7d)} > ${lineName} ${fmt(line)}`, waitUntil: Math.max(now + 60_000, wait) };
    }
  }
  const headroom = Math.min(lim.cap_5h - used5h, line - used7d) * weight;
  return { ...c, eligible: true, reason: `5h ${fmt(used5h)}% · week ${fmt(used7d)}% / ${lim.pacing === false ? "cap" : "line"} ${fmt(line)}`, headroom };
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

// 已知余量 > 未知（未知排在已知可用的后面，但仍可选）。
const score = (c: Candidate) => (c.headroom == null ? -1e9 : c.headroom);

function choose<T>(items: T[], strategy: Strategy, scoreOf: (t: T) => number, cursorKey: string, cursors: Record<string, number>): T | undefined {
  if (!items.length) return undefined;
  if (strategy === "failover") return items[0];
  if (strategy === "round_robin") {
    const i = (cursors[cursorKey] ?? 0) % items.length;
    cursors[cursorKey] = i + 1;
    return items[i];
  }
  // headroom：稳定排序，平手保持原顺序
  return items.map((t, i) => ({ t, i, s: scoreOf(t) })).sort((x, y) => y.s - x.s || x.i - y.i)[0].t;
}

export function select(cfg: Config, st: SelectState, req: SelectRequest, now = Date.now()): SelectResult {
  const policy = policyFor(cfg, req.taskClass, req.kind);
  const lim = limitsFor(cfg, policy); // 全局红线/配速，被这条策略的 limits 覆盖
  const engines = ENGINE_NAMES.filter(
    (e) => ENGINE_KIND[e] === req.kind && cfg.engines[e] && (!req.require?.length || req.require.includes(e)),
  );
  const candidates: Candidate[] = [];
  for (const e of engines) for (const a of cfg.engines[e]!.accounts) candidates.push(evaluate(cfg, lim, st, req, e, a, now));
  const eligible = candidates.filter((c) => c.eligible);
  const accountOf = (c: Candidate) => cfg.engines[c.engine]!.accounts.find((a) => a.id === c.id)!;
  const done = (c: Candidate | undefined): SelectResult => {
    if (!c) {
      const waits = candidates.map((x) => x.waitUntil).filter((x): x is number => typeof x === "number");
      return { pick: null, candidates, waitUntil: waits.length ? Math.min(...waits) : null };
    }
    return { pick: { engine: c.engine, account: accountOf(c), key: c.key, estimate: estimateFor(cfg, st, req.taskClass, c.engine, req.size) }, candidates, waitUntil: null };
  };

  if (req.prefer) {
    const p = eligible.find((c) => c.key === req.prefer);
    if (p) return done(p);
  }
  if (!eligible.length) return done(undefined);

  // 引擎层：有合格账号的引擎；avoid 的排到最后（不剔除——其他都满了还能兜底）。
  const order = [...(policy.order ?? []), ...DEFAULT_ORDER.filter((e) => !(policy.order ?? []).includes(e))];
  const avoid = new Set(req.avoid ?? []);
  let live = order.filter((e) => eligible.some((c) => c.engine === e));
  live = [...live.filter((e) => !avoid.has(e)), ...live.filter((e) => avoid.has(e))];
  const preferred = live.filter((e) => !avoid.has(e));
  const pool = preferred.length ? preferred : live;
  const best = (e: EngineName) => Math.max(...eligible.filter((c) => c.engine === e).map(score));
  const engine = choose(pool, policy.engines, best, `${req.taskClass ?? "default"}|engines`, st.cursors)!;

  // Key 层：同一引擎内，按配置里的账号顺序。
  const keys = eligible.filter((c) => c.engine === engine);
  return done(choose(keys, policy.keys, score, `${req.taskClass ?? "default"}|${engine}`, st.cursors));
}
