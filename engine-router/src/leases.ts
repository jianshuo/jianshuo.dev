// src/leases.ts — 租约：router 只做「挑谁」，调用方自己执行。
//
// 给已经有成熟执行层、又不适合把执行搬进 router 的调用方用——paint 出图就是这样：
// 它有自己的 Codex 链（gpt-image-2-skill 写 auth.json 的格式和 codex CLI 不兼容，不能和
// router 的链共用）、8 分钟整单期限、ImageMagick 后处理、XMP 溯源。租约让 router 仍是
// 额度的唯一裁决者：开画前问一句用 gpt-image 还是 seedream（红线、周配速、冷却、
// Seedream 日上限都在这里判），画完回报结果（撞墙就冷却、Seedream 记张数）。
//
// 只在内存里：租约很短（缺省 15 分钟过期自动释放预留），router 重启丢了也只是少算几分钟预留。
import { randomBytes } from "node:crypto";
import { ENGINE_NAMES, acctKey, type EngineName, type Kind } from "./config.js";
import { shouldTryNextLeg } from "./legs.js";
import type { Pool } from "./pool.js";
import { reserveKeys, select, type SelectResult } from "./selector.js";
import { cooldownFor, HttpError } from "./runs.js";

export type Lease = {
  id: string;
  caller: string;
  engine: EngineName;
  accountId: string;
  key: string;
  quotaKey: string;
  estimate: { d5h: number; d7d: number };
  taskClass: string;
  createdAt: number;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 6 * 3600_000;

const engines = (x: unknown): EngineName[] => (Array.isArray(x) ? x.filter((e): e is EngineName => ENGINE_NAMES.includes(e)) : []);

export class Leases {
  private leases = new Map<string, Lease>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private pool: Pool) {}

  start(): void {
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  active(): Lease[] {
    return [...this.leases.values()];
  }

  /** 挑一个账号并占上预留。没有合格的返回 lease:null + 各候选理由 + 最早恢复时刻。 */
  create(b: any, caller: string, now = Date.now()): { lease: Lease | null; selection: SelectResult } {
    const kind: Kind = b?.kind === "text" ? "text" : "image";
    const taskClass = typeof b?.task_class === "string" && b.task_class ? b.task_class.slice(0, 40) : kind === "image" ? "image" : "default";
    const st = this.pool.selectState();
    const selection = select(
      this.pool.cfg,
      st,
      {
        kind,
        taskClass,
        size: ["small", "medium", "large"].includes(b?.size) ? b.size : undefined,
        avoid: engines(b?.engine_hints?.avoid),
        require: engines(b?.engine_hints?.require),
        force: b?.force === true,
        capabilities: b?.capabilities,
      },
      now,
    );
    if (!selection.pick) {
      console.log(`[leases] ${caller}/${taskClass} → none: ${selection.candidates.map((c) => `${c.key}: ${c.reason}`).join("; ").slice(0, 300)}`);
      return { lease: null, selection };
    }
    const { engine, account, estimate } = selection.pick;
    const { conc, quota } = reserveKeys(this.pool.cfg, engine, account.id);
    const ttl = Math.min(MAX_TTL_MS, Math.max(60_000, Number(b?.ttl_ms) || DEFAULT_TTL_MS));
    const lease: Lease = {
      id: "l_" + randomBytes(9).toString("base64url"),
      caller,
      engine,
      accountId: account.id,
      key: conc,
      quotaKey: quota,
      estimate,
      taskClass,
      createdAt: now,
      expiresAt: now + ttl,
    };
    this.leases.set(lease.id, lease);
    this.pool.reserve(conc, quota, estimate, +1);
    console.log(`[leases] ${lease.id} ${caller}/${taskClass} → ${conc}`);
    return { lease, selection };
  }

  /**
   * 回报结果，释放预留。
   *   ok            这次总体成没成
   *   engine_used   实际干活的引擎（调用方可能在租到 gpt-image 后又自己降级到 seedream）
   *   error         租到的那个引擎的报错原文——额度/凭据类会让这个账号进冷却
   */
  complete(id: string, caller: string, b: any, now = Date.now()): Lease {
    const lease = this.leases.get(id);
    if (!lease || (lease.caller !== caller && caller !== "admin")) throw new HttpError(404, "lease not found");
    this.release(lease);
    const error = typeof b?.error === "string" ? b.error : "";
    console.log(`[leases] ${lease.id} complete ok=${b?.ok === true} used=${b?.engine_used ?? "-"}${error ? " error=" + error.slice(0, 120) : ""}`);
    if (error && shouldTryNextLeg(error)) {
      const until = cooldownFor(error, this.pool.usage(lease.quotaKey), now);
      if (until) this.pool.setCooldown(lease.quotaKey, until);
      console.log(`[leases] ${lease.key} 报错 → 冷却：${error.slice(0, 160)}`);
    }
    const used = ENGINE_NAMES.includes(b?.engine_used) ? (b.engine_used as EngineName) : b?.ok ? lease.engine : undefined;
    if (used === "seedream") {
      const id2 = lease.engine === "seedream" ? lease.accountId : this.pool.cfg.engines.seedream?.accounts.find((a) => !a.disabled)?.id;
      if (id2) this.pool.countDaily(acctKey("seedream", id2));
    }
    // 用过订阅额度：探一次让配速尽快看到这次消耗（gpt-image 读的是 codex 账号）
    const probeEngine = lease.quotaKey.split("/")[0] as EngineName;
    if (used && used !== "seedream" && (probeEngine === "codex" || probeEngine === "claude" || probeEngine === "kimi"))
      void this.pool.probe(probeEngine, lease.accountId);
    return lease;
  }

  private release(lease: Lease): void {
    if (!this.leases.delete(lease.id)) return;
    this.pool.reserve(lease.key, lease.quotaKey, lease.estimate, -1);
  }

  /** 过期没回报的租约：释放预留（调用方崩了或忘了回报）。 */
  sweep(now = Date.now()): void {
    for (const l of this.leases.values())
      if (l.expiresAt <= now) {
        console.warn(`[leases] ${l.id} (${l.caller} → ${l.key}) expired without complete`);
        this.release(l);
      }
  }
}

export function publicLease(l: Lease) {
  return { lease_id: l.id, engine: l.engine, account: l.key, expires_at: new Date(l.expiresAt).toISOString() };
}
