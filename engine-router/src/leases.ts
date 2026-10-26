// src/leases.ts — 租约：router 只做「挑谁」，调用方自己执行。
//
// 给已经有成熟执行层、又不适合把执行搬进 router 的调用方用——paint 出图就是这样：
// 它有自己的 Codex 链（gpt-image-2-skill 写 auth.json 的格式和 codex CLI 不兼容，不能和
// router 的链共用）、8 分钟整单期限、ImageMagick 后处理、XMP 溯源。租约让 router 仍是
// 额度的唯一裁决者：开画前问一句用 gpt-image 还是 seedream（红线、周配速、冷却、
// Seedream 日上限都在这里判），画完回报结果（撞墙就冷却、Seedream 记张数）。
//
// 长租约（视频书一单几个小时）调用方可以带 label（书名）、边做边 progress 报步骤，每报一次按原 ttl 续期；
// 状态页显示在跑的租约和最近完成的带 label 租约。调用方还能 PUT 一份排队快照（/v1/queues/<name>），
// 状态页照样列出来——router 不管排队，只负责让人在一个地方看全。
// 租约、最近完成记录、排队快照落盘（state/leases.json），router 重启后接着算预留、接着显示。
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { ENGINE_NAMES, acctKey, type EngineName, type Kind } from "./config.js";
import { shouldTryNextLeg } from "./legs.js";
import type { Before, Pool } from "./pool.js";
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
  ttl: number;
  label?: string;
  progress?: { step: string; at: number };
  finishedAt?: number;
  ok?: boolean;
  error?: string;
  /** 开租时的用量快照：complete 时前后相减学单次消耗（视频书这类长租约就靠它进「学到的单次消耗」表） */
  before?: Before;
  learned?: { d5h: number; d7d: number };
};

export type QueueItem = { label: string; at?: number; note?: string };
export type QueueSnapshot = { name: string; caller: string; title: string; note: string; items: QueueItem[]; updatedAt: number };

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 6 * 3600_000;
const HISTORY = 30;

const engines = (x: unknown): EngineName[] => (Array.isArray(x) ? x.filter((e): e is EngineName => ENGINE_NAMES.includes(e)) : []);
const str = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");

export class Leases {
  private leases = new Map<string, Lease>();
  private done: Lease[] = []; // 最近完成的带 label 租约，新的在前
  private queues = new Map<string, QueueSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private pool: Pool,
    private file?: string,
  ) {
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      const now = Date.now();
      for (const l of j.active ?? [])
        if (l?.id && l.expiresAt > now) {
          this.leases.set(l.id, l);
          this.pool.reserve(l.key, l.quotaKey, l.estimate, +1);
        }
      this.done = Array.isArray(j.done) ? j.done.slice(0, HISTORY) : [];
      for (const q of j.queues ?? []) if (q?.name) this.queues.set(q.name, q);
    } catch {
      /* 没有或坏了：从空开始 */
    }
  }

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

  recent(): Lease[] {
    return this.done;
  }

  queueSnapshots(): QueueSnapshot[] {
    return [...this.queues.values()].sort((a, b) => a.name.localeCompare(b.name));
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
    const label = str(b?.label, 120);
    const before = this.pool.snapshot(quota, conc);   // 占预留之前拍，shared 才不会把自己算进去
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
      ttl,
      ...(label ? { label } : {}),
      ...(before ? { before } : {}),
    };
    this.leases.set(lease.id, lease);
    this.pool.reserve(conc, quota, estimate, +1);
    this.save();
    console.log(`[leases] ${lease.id} ${caller}/${taskClass} → ${conc}${label ? ` 「${label}」` : ""}`);
    return { lease, selection };
  }

  /** 调用方报一下做到哪了（step 一句话），顺带按原 ttl 续期——长活不会做到一半预留被扫掉。 */
  progress(id: string, caller: string, b: any, now = Date.now()): Lease {
    const lease = this.mine(id, caller);
    const step = str(b?.step, 200);
    if (step) lease.progress = { step, at: now };
    const label = str(b?.label, 120);
    if (label) lease.label = label;
    lease.expiresAt = Math.max(lease.expiresAt, now + lease.ttl);
    this.save();
    return lease;
  }

  /**
   * 回报结果，释放预留。
   *   ok            这次总体成没成
   *   engine_used   实际干活的引擎（调用方可能在租到 gpt-image 后又自己降级到 seedream）
   *   error         租到的那个引擎的报错原文——额度/凭据类会让这个账号进冷却
   */
  complete(id: string, caller: string, b: any, now = Date.now()): Lease {
    const lease = this.mine(id, caller);
    const error = typeof b?.error === "string" ? b.error : "";
    this.release(lease, { finishedAt: now, ok: b?.ok === true, ...(error ? { error: error.slice(0, 300) } : {}) });
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
    // 用过订阅额度：探一次让配速尽快看到这次消耗（gpt-image 读的是 codex 账号）；成功且租的引擎就是干活的引擎时，
    // 顺带学单次消耗（同 run：没并发、同窗口才算，规则在 Pool.learnDelta）
    const probeEngine = lease.quotaKey.split("/")[0] as EngineName;
    if (used && used !== "seedream" && (probeEngine === "codex" || probeEngine === "claude" || probeEngine === "kimi")) {
      // 只学文字引擎的租约（视频书）；出图（gpt-image 读 codex 额度）照旧只探不学，不动 paint 的预估
      if (b?.ok === true && used === lease.engine && lease.engine === probeEngine)
        void this.pool.learnDelta(lease.taskClass, lease.engine, lease.quotaKey, lease.accountId, lease.before).then((s) => {
          if (!s) return;
          lease.learned = s;
          this.save();
          console.log(`[leases] ${lease.id} learned ${lease.taskClass}|${lease.engine}: +${s.d5h.toFixed(1)} (5h) +${s.d7d.toFixed(1)} (week)`);
        });
      else void this.pool.probe(probeEngine, lease.accountId);
    }
    return lease;
  }

  /** 调用方整份替换自己的排队快照（items 空 = 队里没东西，状态页照样显示）。 */
  putQueue(name: string, caller: string, b: any, now = Date.now()): QueueSnapshot {
    const prev = this.queues.get(name);
    if (prev && prev.caller !== caller && caller !== "admin") throw new HttpError(403, "queue owned by another caller");
    const items: QueueItem[] = (Array.isArray(b?.items) ? b.items : []).slice(0, 50).map((x: any) => ({
      label: str(x?.label, 120) || "?",
      ...(Number.isFinite(x?.at) ? { at: Number(x.at) } : {}),
      ...(str(x?.note, 160) ? { note: str(x?.note, 160) } : {}),
    }));
    const q: QueueSnapshot = { name, caller, title: str(b?.title, 80) || name, note: str(b?.note, 300), items, updatedAt: now };
    this.queues.set(name, q);
    this.save();
    return q;
  }

  private mine(id: string, caller: string): Lease {
    const lease = this.leases.get(id);
    if (!lease || (lease.caller !== caller && caller !== "admin")) throw new HttpError(404, "lease not found");
    return lease;
  }

  private release(lease: Lease, end: Pick<Lease, "finishedAt" | "ok" | "error">): void {
    if (!this.leases.delete(lease.id)) return;
    this.pool.reserve(lease.key, lease.quotaKey, lease.estimate, -1);
    Object.assign(lease, end);
    // 出图一张一个租约、没有 label，进历史只会刷屏；带 label 的长活才留底
    if (lease.label) this.done = [lease, ...this.done].slice(0, HISTORY);
    this.save();
  }

  private save(): void {
    const file = this.file;
    if (!file) return;
    const body = JSON.stringify({ active: [...this.leases.values()], done: this.done, queues: [...this.queues.values()] });
    this.saving = this.saving
      .then(async () => {
        await writeFile(file + ".tmp", body);
        await rename(file + ".tmp", file);
      })
      .catch((e) => console.error("[leases] save failed", e));
  }

  /** 过期没回报的租约：释放预留（调用方崩了或忘了回报）。 */
  sweep(now = Date.now()): void {
    for (const l of this.leases.values())
      if (l.expiresAt <= now) {
        console.warn(`[leases] ${l.id} (${l.caller} → ${l.key}) expired without complete`);
        this.release(l, { finishedAt: now, ok: false, error: "过期没回报" });
      }
  }
}

export function publicLease(l: Lease) {
  return { lease_id: l.id, engine: l.engine, account: l.key, expires_at: new Date(l.expiresAt).toISOString() };
}
