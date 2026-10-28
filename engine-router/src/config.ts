// src/config.ts — 账号注册表：config.json（不含密钥）+ .env（密钥），都能热重载。
import { readFileSync } from "node:fs";

/** 引擎名就是引擎类型：一类引擎下面挂多个账号。 */
export type EngineName = "claude" | "codex" | "kimi" | "gpt-image" | "seedream";
export const ENGINE_NAMES: EngineName[] = ["claude", "codex", "kimi", "gpt-image", "seedream"];
export type Kind = "text" | "image";
export const ENGINE_KIND: Record<EngineName, Kind> = {
  claude: "text",
  codex: "text",
  kimi: "text",
  "gpt-image": "image",
  seedream: "image",
};

export type Account = {
  id: string;
  token_env?: string; // claude：setup-token 所在的环境变量名
  key_env?: string; // kimi / seedream：API key 所在的环境变量名
  codex_home?: string; // codex：这条 device-auth 链的 CODEX_HOME
  base_url?: string; // kimi：Anthropic 兼容端点
  weight?: number; // headroom 乘这个权重（缺省 1）
  daily_cap?: number; // seedream：每日张数上限
  concurrency?: number; // 出图账号同时画几张（缺省 concurrency.image_per_account）；文字账号用 per_account
  // 这个账号的引擎进程额外的环境变量（router 配置，不是调用方给的，最后覆盖）。
  // 例：Kimi 的 1M 上下文 CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_CODE_MAX_CONTEXT_TOKENS、effort。
  env?: Record<string, string>;
  disabled?: boolean;
};

export type Strategy = "headroom" | "failover" | "round_robin";
// 挑选用的红线与配速。全局在 config.limits，单条策略可以用 policy.limits 覆盖其中几项——
// 例：出图要「Codex 用到快满再切 Seedream」，就给 image 策略 { pacing: false, cap_5h: 90, cap_7d: 90 }，
// 写书照旧按周配速走。
export type PickLimits = { cap_5h: number; cap_7d: number; weekly_slack: number; pacing: boolean };
export type Policy = { engines: Strategy; keys: Strategy; order?: EngineName[]; limits?: Partial<PickLimits> };
export type Estimate = { d5h: number; d7d: number }; // 一次任务吃掉的百分点

export type Config = {
  engines: Partial<Record<EngineName, { accounts: Account[]; quota_from?: EngineName }>>;
  models: Partial<Record<EngineName, { best: string; fast: string }>>;
  limits: PickLimits & { probe_every_s: number; claude_probe_every_s: number };
  policies: Record<string, Policy>;
  estimates: Record<string, Partial<Record<EngineName, Estimate>>>;
  // per_account：文字账号同时几个 run；出图：每个账号缺省 image_per_account 张（account.concurrency 可单独改），
  // 全站同时最多 image_total 张（1GB 小机器，每张 gpt-image 是一个 node 进程）。
  concurrency: { global_text: number; per_account: number; image_per_account: number; image_total: number };
  // 会话第 ② 档（同类引擎跨账号 resume）是否启用。claude_family 2026-10-25 实测通过
  // （claude↔kimi 双向、fast/best 两档都能 resume 同一会话），默认开；codex 跨 CODEX_HOME 未测，默认关。
  portable: { claude_family: boolean; codex: boolean };
};

export const DEFAULT_ESTIMATE: Estimate = { d5h: 10, d7d: 2 };

const DEFAULTS: Config = {
  engines: {},
  models: {
    claude: { best: "claude-opus-4-8", fast: "claude-haiku-4-5" },
    codex: { best: "gpt-6-astra", fast: "gpt-6-astra" },
    kimi: { best: "k3", fast: "k3" },
  },
  limits: { cap_5h: 85, cap_7d: 92, weekly_slack: 10, pacing: true, probe_every_s: 300, claude_probe_every_s: 900 },
  policies: { default: { engines: "headroom", keys: "headroom" } },
  estimates: {},
  concurrency: { global_text: 2, per_account: 1, image_per_account: 4, image_total: 6 },
  portable: { claude_family: true, codex: false },
};

const STRATEGIES: Strategy[] = ["headroom", "failover", "round_robin"];

/** 解析 + 校验 + 补缺省。坏配置直接抛错——reload 时由调用方兜住、保留旧配置。 */
export function parseConfig(raw: unknown): Config {
  const j = (raw ?? {}) as any;
  const cfg: Config = {
    engines: {},
    models: { ...DEFAULTS.models, ...(j.models ?? {}) },
    limits: { ...DEFAULTS.limits, ...(j.limits ?? {}) },
    policies: { ...DEFAULTS.policies, ...(j.policies ?? {}) },
    estimates: j.estimates ?? {},
    concurrency: { ...DEFAULTS.concurrency, ...(j.concurrency ?? {}) },
    portable: { ...DEFAULTS.portable, ...(j.portable ?? {}) },
  };
  const seen = new Set<string>();
  for (const [name, e] of Object.entries(j.engines ?? {})) {
    if (!ENGINE_NAMES.includes(name as EngineName)) throw new Error(`unknown engine "${name}"`);
    const accounts: Account[] = [];
    for (const a of ((e as any)?.accounts ?? []) as Account[]) {
      if (!a?.id || !/^[A-Za-z0-9_.-]{1,40}$/.test(a.id)) throw new Error(`engine ${name}: bad account id ${JSON.stringify(a?.id)}`);
      const key = `${name}/${a.id}`;
      if (seen.has(key)) throw new Error(`duplicate account ${key}`);
      seen.add(key);
      accounts.push({ ...a });
    }
    const quota_from = (e as any)?.quota_from as EngineName | undefined;
    if (quota_from && !ENGINE_NAMES.includes(quota_from)) throw new Error(`engine ${name}: bad quota_from`);
    cfg.engines[name as EngineName] = { accounts, quota_from };
  }
  for (const [cls, p] of Object.entries(cfg.policies)) {
    if (!STRATEGIES.includes(p.engines) || !STRATEGIES.includes(p.keys)) throw new Error(`policy ${cls}: bad strategy`);
    for (const o of p.order ?? []) if (!ENGINE_NAMES.includes(o)) throw new Error(`policy ${cls}: bad engine ${o} in order`);
    for (const [k, v] of Object.entries(p.limits ?? {})) {
      if (k === "pacing") {
        if (typeof v !== "boolean") throw new Error(`policy ${cls}: limits.pacing must be true/false`);
      } else if (k === "cap_5h" || k === "cap_7d" || k === "weekly_slack") {
        if (typeof v !== "number" || !(v >= 0 && v <= 100)) throw new Error(`policy ${cls}: limits.${k} must be 0–100`);
      } else throw new Error(`policy ${cls}: unknown limits.${k}`);
    }
  }
  return cfg;
}

/** 这条策略实际用的红线与配速：全局 limits，被 policy.limits 覆盖。 */
export function limitsFor(cfg: Config, policy: Policy | undefined): PickLimits {
  const g = cfg.limits;
  return { cap_5h: g.cap_5h, cap_7d: g.cap_7d, weekly_slack: g.weekly_slack, pacing: g.pacing !== false, ...(policy?.limits ?? {}) };
}

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/** 极简 dotenv：KEY=VALUE，# 开头整行注释，值两侧引号去掉。和 systemd EnvironmentFile 一样不支持行内注释。 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadSecrets(path: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function policyFor(cfg: Config, taskClass: string | undefined, kind: Kind): Policy {
  if (taskClass && cfg.policies[taskClass]) return cfg.policies[taskClass];
  if (kind === "image" && cfg.policies.image) return cfg.policies.image;
  return cfg.policies.default;
}

export function modelFor(cfg: Config, engine: EngineName, quality: string | undefined): string {
  const m = cfg.models[engine];
  if (!m) return "";
  return quality === "fast" ? m.fast : m.best;
}

/** 出图账号同时画几张。 */
export function imageSlots(cfg: Config, a: Account): number {
  return Math.max(1, a.concurrency ?? cfg.concurrency.image_per_account);
}

/** (engine, account) 的全局唯一键。 */
export const acctKey = (engine: EngineName, id: string) => `${engine}/${id}`;
