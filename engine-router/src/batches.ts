// src/batches.ts — 出图批次（2026-10-28）：一批图整体交给 router，一批一个引擎，按账号并发排队画完。
//
// 之前（租约）是 paint 每张图问一次「给谁画」：账号一忙就判失败或外溢到 Seedream，外溢一次 paint 的
// group 粘性又把整本书钉死在 Seedream 单车道上（2026-10-28《嘟嘟的松木大桌子》）。现在：
//   - 调用方（paint）把一批 job 交进来（POST /v1/image-batches），开批时按整批 N 张的额度定一个引擎，
//     中途不换。同一 group（书的 slug）的后续批次沿用同一个引擎（router 记 group → 引擎）。
//   - 每个出图账号 imageSlots 张并发（缺省 4），全站最多 concurrency.image_total 张，其余排队。
//   - 执行仍在 paint（它有 Codex 链、方舟、后处理、XMP）：paint 来领活（claim）、画完回报（complete），
//     画的过程中每 30 秒心跳一次；3 分钟没心跳就当 paint 挂了，把这张放回队列。
//   - 引擎撞墙（额度 / 模型被拒）：冷却这个账号，这张放回队列，整批暂停到冷却结束——不换引擎；
//     连续暂停超过 MAX_PAUSE_MS（2 小时）判剩下的图失败（写书那边据此走退款）。
// 状态落盘 state/batches.json，重启接着排。
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { acctKey, imageSlots, type Account } from "./config.js";
import { shouldTryNextLeg } from "./legs.js";
import type { Pool } from "./pool.js";
import { cooldownFor, HttpError } from "./runs.js";
import { estimateFor, quotaKey, select } from "./selector.js";

export type ImageEngine = "gpt-image" | "seedream";
export type ItemStatus = "queued" | "running" | "done" | "failed";
export type BatchStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export type BatchItem = {
  job_id: string;
  key?: string; // 调用方自己的标识（如输出文件路径），原样带回
  status: ItemStatus;
  attempts: number;
  error?: string;
  startedAt?: number;
  beatAt?: number;
  doneAt?: number;
  cancel?: boolean; // 批次被取消时还在画：下次心跳告诉 paint 停下
};

export type Batch = {
  id: string;
  caller: string;
  label?: string;
  group?: string;
  priority: "interactive" | "batch"; // interactive（VoiceDrop 单张）排在整本书前面
  require?: ImageEngine; // 调用方点名 / 有透明图（只有 gpt-image 能画）
  engine: ImageEngine | null;
  accountId: string | null;
  decidedReason?: string;
  status: BatchStatus;
  pausedSince?: number;
  pausedUntil?: number;
  pauseReason?: string;
  items: BatchItem[];
  createdAt: number;
  finishedAt?: number;
};

type GroupPin = { engine: ImageEngine; accountId: string; at: number };

export const MAX_PAUSE_MS = 2 * 3600_000;
const STALE_MS = 3 * 60_000;
const PIN_TTL_MS = 14 * 86400_000;
const KEEP_DONE_MS = 3 * 86400_000;
const MAX_ITEMS = 200;
export const EXECUTOR = "paint"; // 只有执行方能领活 / 回报

const TERMINAL = new Set<BatchStatus>(["done", "failed", "cancelled"]);
const str = (x: unknown, n: number) => (typeof x === "string" ? x.trim().slice(0, n) : "");
const engineOf = (x: unknown): ImageEngine | undefined =>
  x === "gpt-image" || x === "codex" ? "gpt-image" : x === "seedream" ? "seedream" : undefined;

export class Batches {
  batches = new Map<string, Batch>();
  pins = new Map<string, GroupPin>();
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private pool: Pool,
    private file?: string,
  ) {
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      for (const b of j.batches ?? []) if (b?.id) this.batches.set(b.id, b);
      for (const [g, p] of Object.entries(j.pins ?? {})) this.pins.set(g, p as GroupPin);
    } catch {
      /* 没有或坏了：从空开始 */
    }
    // 在飞预留不落盘：从在画的图重新算
    for (const b of this.batches.values()) for (const i of b.items) if (i.status === "running") this.reserve(b, +1);
  }

  start(): void {
    this.timer = setInterval(() => this.expire(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(id: string): Batch | undefined {
    return this.batches.get(id);
  }

  list(): Batch[] {
    return [...this.batches.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 交一批。同一批 job 重复交（paint 重启后补交）返回原批次。 */
  submit(body: any, caller: string, now = Date.now()): { batch: Batch; existing: boolean } {
    const raw = Array.isArray(body?.items) ? body.items : [];
    if (!raw.length || raw.length > MAX_ITEMS) throw new HttpError(400, `items must be 1–${MAX_ITEMS} jobs`);
    const items: BatchItem[] = [];
    const seen = new Set<string>();
    let transparent = false;
    for (const x of raw) {
      const id = str(x?.job_id, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) throw new HttpError(400, `bad or duplicate job_id ${JSON.stringify(x?.job_id)}`);
      seen.add(id);
      if (x?.transparent === true) transparent = true;
      const key = str(x?.key, 300);
      items.push({ job_id: id, ...(key ? { key } : {}), status: "queued", attempts: 0 });
    }
    for (const b of this.batches.values())
      if (b.caller === caller && b.items.some((i) => seen.has(i.job_id))) {
        if (b.items.length === items.length && items.every((i) => b.items.some((x) => x.job_id === i.job_id))) return { batch: b, existing: true };
        throw new HttpError(409, `job already in batch ${b.id}`);
      }
    let require = engineOf(body?.engine);
    if (body?.engine != null && body.engine !== "auto" && !require) throw new HttpError(400, "engine must be auto | gpt-image | seedream");
    if (transparent) {
      if (require === "seedream") throw new HttpError(400, "seedream cannot do transparent output");
      require = "gpt-image";
    }
    const group = str(body?.group, 80);
    if (group && !/^[\w.:-]{1,80}$/.test(group)) throw new HttpError(400, "bad group");
    const label = str(body?.label, 120);
    const b: Batch = {
      id: "b_" + randomBytes(9).toString("base64url"),
      caller,
      ...(label ? { label } : {}),
      ...(group ? { group } : {}),
      priority: body?.priority === "interactive" ? "interactive" : "batch",
      ...(require ? { require } : {}),
      engine: null,
      accountId: null,
      status: "queued",
      items,
      createdAt: now,
    };
    this.batches.set(b.id, b);
    this.decide(b, now);
    this.prune(now);
    this.save();
    console.log(`[batches] ${b.id} ${caller} ${items.length} 张${label ? ` 「${label}」` : ""}${group ? ` group=${group}` : ""} → ${b.engine ? `${b.engine}/${b.accountId}（${b.decidedReason}）` : `暂停：${b.pauseReason}`}`);
    return { batch: b, existing: false };
  }

  /**
   * 给批次定引擎（只定一次）。点名的、group 已绑定的直接用（force：只要没撞墙，配速和红线不拦）；
   * 其余按出图策略、整批剩余张数的额度预估挑。谁都不合格就暂停到最早可用时刻。
   */
  private decide(b: Batch, now: number): void {
    if (b.engine) return;
    let require = b.require;
    let why = require ? `requested ${require}` : "";
    const pin = b.group ? this.pins.get(b.group) : undefined;
    const pinned = pin && now - pin.at < PIN_TTL_MS ? pin : undefined;
    if (pinned && (!require || require === pinned.engine)) {
      require = pinned.engine;
      why = `group ${b.group} uses ${pinned.engine}`;
    }
    const count = b.items.filter((i) => i.status === "queued").length || 1;
    const sel = select(
      this.pool.cfg,
      this.pool.selectState(),
      { kind: "image", taskClass: "image", require: require ? [require] : undefined, force: !!require, ignoreBusy: true, count },
      now,
    );
    if (!sel.pick) {
      const reason = sel.candidates.map((c) => `${c.key}: ${c.reason}`).join("; ") || "no image account configured";
      this.pause(b, sel.waitUntil ?? now + 5 * 60_000, reason, now);
      return;
    }
    b.engine = sel.pick.engine as ImageEngine;
    b.accountId = sel.pick.account.id;
    b.decidedReason = why || sel.candidates.find((c) => c.key === sel.pick!.key)?.reason || "";
    b.pausedUntil = undefined;
    b.pauseReason = undefined;
    if (b.group) this.pins.set(b.group, { engine: b.engine, accountId: b.accountId, at: now });
  }

  private pause(b: Batch, until: number, reason: string, now: number): void {
    b.pausedSince ??= now;
    b.pausedUntil = until;
    b.pauseReason = reason.slice(0, 300);
    this.refresh(b, now);
  }

  private account(b: Batch): Account | undefined {
    if (!b.engine || !b.accountId) return undefined;
    return this.pool.cfg.engines[b.engine]?.accounts.find((a) => a.id === b.accountId && !a.disabled);
  }

  private reserve(b: Batch, sign: 1 | -1): void {
    if (!b.engine || !b.accountId) return;
    const est = estimateFor(this.pool.cfg, this.pool.selectState(), "image", b.engine);
    this.pool.reserve(acctKey(b.engine, b.accountId), quotaKey(this.pool.cfg, b.engine, b.accountId), est, sign);
  }

  private running(): { byKey: Map<string, number>; total: number } {
    const byKey = new Map<string, number>();
    let total = 0;
    for (const b of this.batches.values())
      for (const i of b.items)
        if (i.status === "running" && b.engine && b.accountId) {
          const k = acctKey(b.engine, b.accountId);
          byKey.set(k, (byKey.get(k) ?? 0) + 1);
          total++;
        }
    return { byKey, total };
  }

  /** 执行方领活：按优先级、先来后到，在各账号并发和全站上限之内派出最多 max 张。 */
  claim(caller: string, max: number, now = Date.now()): { job_id: string; batch_id: string; engine: ImageEngine; account: string }[] {
    if (caller !== EXECUTOR && caller !== "admin") throw new HttpError(403, "only the executor can claim");
    this.expire(now);
    const cfg = this.pool.cfg;
    const { byKey, total: running } = this.running();
    let total = running;
    const out: { job_id: string; batch_id: string; engine: ImageEngine; account: string }[] = [];
    const order = [...this.batches.values()]
      .filter((b) => !TERMINAL.has(b.status) && b.items.some((i) => i.status === "queued"))
      .sort((a, b) => (a.priority === b.priority ? a.createdAt - b.createdAt : a.priority === "interactive" ? -1 : 1));
    for (const b of order) {
      if (out.length >= max || total >= cfg.concurrency.image_total) break;
      if (b.pausedUntil && b.pausedUntil > now) continue;
      if (b.engine && !this.account(b)) {
        // 账号被删 / 停用：这批还没开画的部分重新定引擎（已画好的不动）
        b.engine = null;
        b.accountId = null;
      }
      this.decide(b, now);
      const a = this.account(b);
      if (!b.engine || !a) continue;
      const key = acctKey(b.engine, a.id);
      const qk = quotaKey(cfg, b.engine, a.id);
      const cool = this.pool.cooldownUntil(qk);
      if (cool > now) {
        this.pause(b, cool, `${qk} cooling down`, now);
        continue;
      }
      if (b.engine === "seedream") {
        const cap = a.daily_cap ?? 200;
        if ((this.pool.selectState().dailyCount[key] ?? 0) >= cap) {
          const tomorrow = new Date(now);
          tomorrow.setUTCHours(24, 0, 0, 0);
          this.pause(b, tomorrow.getTime(), `${key} daily cap ${cap} reached`, now);
          continue;
        }
      }
      b.pausedUntil = undefined;
      b.pauseReason = undefined;
      const slots = imageSlots(cfg, a);
      for (const i of b.items) {
        if (i.status !== "queued") continue;
        if (out.length >= max || total >= cfg.concurrency.image_total || (byKey.get(key) ?? 0) >= slots) break;
        i.status = "running";
        i.attempts++;
        i.startedAt = i.beatAt = now;
        delete i.error;
        this.reserve(b, +1);
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
        total++;
        out.push({ job_id: i.job_id, batch_id: b.id, engine: b.engine, account: key });
      }
      this.refresh(b, now);
    }
    if (out.length) this.save();
    return out;
  }

  private find(jobId: string): { b: Batch; i: BatchItem } | undefined {
    for (const b of this.batches.values()) {
      const i = b.items.find((x) => x.job_id === jobId);
      if (i) return { b, i };
    }
    return undefined;
  }

  /**
   * 执行方回报一张图。error 是引擎报错原文：额度 / 模型被拒 → 冷却账号、这张放回队列、整批暂停（不换引擎）；
   * 被打断（paint 重启、期限到）重排一次；其余就是这张失败。
   */
  complete(caller: string, jobId: string, body: any, now = Date.now()): BatchItem {
    if (caller !== EXECUTOR && caller !== "admin") throw new HttpError(403, "only the executor can complete");
    const f = this.find(jobId);
    if (!f || f.i.status !== "running") throw new HttpError(404, "job not running");
    const { b, i } = f;
    this.reserve(b, -1);
    const ok = body?.ok === true;
    const error = typeof body?.error === "string" ? body.error.slice(0, 600) : "";
    i.doneAt = now;
    if (ok) {
      i.status = "done";
      delete i.error;
      b.pausedSince = undefined;
      if (b.engine === "seedream" && b.accountId) this.pool.countDaily(acctKey("seedream", b.accountId));
    } else if (i.cancel) {
      i.status = "failed";
      i.error = "cancelled";
    } else if (shouldTryNextLeg(error) && b.engine && b.accountId) {
      const qk = quotaKey(this.pool.cfg, b.engine, b.accountId);
      const until = cooldownFor(error, this.pool.usage(qk), now) || now + 30 * 60_000;
      this.pool.setCooldown(qk, until);
      i.status = "queued";
      i.error = error;
      this.pause(b, until, `${qk}: ${error}`, now);
      console.log(`[batches] ${b.id} ${qk} 撞墙 → 冷却到 ${new Date(until).toISOString()}，整批暂停：${error.slice(0, 160)}`);
    } else if (/interrupted|deadline_exceeded/i.test(error) && i.attempts < 2) {
      i.status = "queued";
      i.error = error;
    } else {
      i.status = "failed";
      i.error = error || "failed";
    }
    this.refresh(b, now);
    this.save();
    return i;
  }

  /** 执行方心跳：续上在画的图；返回要停下的（批次被取消 / router 已不认这张）。 */
  heartbeat(caller: string, jobIds: unknown, now = Date.now()): string[] {
    if (caller !== EXECUTOR && caller !== "admin") throw new HttpError(403, "only the executor can heartbeat");
    const stop: string[] = [];
    for (const id of Array.isArray(jobIds) ? jobIds : []) {
      const f = typeof id === "string" ? this.find(id) : undefined;
      if (!f || f.i.status !== "running" || f.i.cancel) {
        if (typeof id === "string") stop.push(id);
        continue;
      }
      f.i.beatAt = now;
    }
    return stop;
  }

  /** 执行方刚启动：它手上的图全没了，在画的放回队列。 */
  releaseAll(caller: string, now = Date.now()): number {
    if (caller !== EXECUTOR && caller !== "admin") throw new HttpError(403, "only the executor can release");
    let n = 0;
    for (const b of this.batches.values())
      for (const i of b.items)
        if (i.status === "running") {
          this.requeue(b, i, "interrupted: executor restarted");
          n++;
        }
    for (const b of this.batches.values()) this.refresh(b, now);
    if (n) this.save();
    return n;
  }

  private requeue(b: Batch, i: BatchItem, why: string): void {
    this.reserve(b, -1);
    if (i.cancel) {
      i.status = "failed";
      i.error = "cancelled";
      return;
    }
    i.status = "queued";
    i.error = why;
  }

  cancel(id: string, caller: string, now = Date.now()): Batch {
    const b = this.batches.get(id);
    if (!b || (b.caller !== caller && caller !== "admin")) throw new HttpError(404, "batch not found");
    if (TERMINAL.has(b.status)) return b;
    for (const i of b.items) {
      if (i.status === "queued") {
        i.status = "failed";
        i.error = "cancelled";
      } else if (i.status === "running") i.cancel = true;
    }
    b.status = "cancelled";
    this.refresh(b, now);
    this.save();
    console.log(`[batches] ${b.id} cancelled by ${caller}`);
    return b;
  }

  /** 定时：没心跳的图放回队列；暂停太久的批次判失败；清旧批次和过期的 group 绑定。 */
  expire(now = Date.now()): void {
    let dirty = false;
    for (const b of this.batches.values()) {
      if (TERMINAL.has(b.status) && b.status !== "cancelled") continue;
      for (const i of b.items)
        if (i.status === "running" && now - (i.beatAt ?? 0) > STALE_MS) {
          console.warn(`[batches] ${b.id} ${i.job_id} 没心跳了，放回队列`);
          this.requeue(b, i, "interrupted: executor heartbeat lost");
          dirty = true;
        }
      if (b.pausedSince && now - b.pausedSince > MAX_PAUSE_MS && b.items.some((i) => i.status === "queued")) {
        for (const i of b.items)
          if (i.status === "queued") {
            i.status = "failed";
            i.error = `paused over ${MAX_PAUSE_MS / 3600_000}h: ${b.pauseReason ?? i.error ?? ""}`.slice(0, 600);
          }
        console.warn(`[batches] ${b.id} 暂停超过 ${MAX_PAUSE_MS / 3600_000} 小时，剩下的图判失败：${b.pauseReason}`);
        dirty = true;
      }
      this.refresh(b, now);
    }
    if (this.prune(now)) dirty = true;
    if (dirty) this.save();
  }

  /** 由各张图的状态推出批次状态。 */
  private refresh(b: Batch, now: number): void {
    const n = (s: ItemStatus) => b.items.filter((i) => i.status === s).length;
    if (n("queued") + n("running") === 0) {
      if (b.status !== "cancelled") b.status = n("failed") ? "failed" : "done";
      if (!b.finishedAt) {
        b.finishedAt = now;
        console.log(`[batches] ${b.id} ${b.status}：${n("done")}/${b.items.length} 张画好`);
        // 用过订阅额度：探一次让配速尽快看到这批的消耗
        if (b.engine === "gpt-image" && b.accountId) void this.pool.probe("codex", b.accountId);
      }
      return;
    }
    if (b.status === "cancelled") return;
    b.status = n("running") ? "running" : b.pausedUntil && b.pausedUntil > now ? "paused" : "queued";
  }

  private prune(now: number): boolean {
    let changed = false;
    for (const [id, b] of this.batches)
      if (b.finishedAt && now - b.finishedAt > KEEP_DONE_MS) {
        this.batches.delete(id);
        changed = true;
      }
    for (const [g, p] of this.pins)
      if (now - p.at > PIN_TTL_MS) {
        this.pins.delete(g);
        changed = true;
      }
    return changed;
  }

  save(): void {
    const file = this.file;
    if (!file) return;
    const body = JSON.stringify({ batches: [...this.batches.values()], pins: Object.fromEntries(this.pins) });
    this.saving = this.saving
      .then(async () => {
        await writeFile(file + ".tmp", body);
        await rename(file + ".tmp", file);
      })
      .catch((e) => console.error("[batches] save failed", e));
  }

  /** 状态页用：每个出图账号的在画 / 排队张数。 */
  load(): Record<string, { running: number; queued: number }> {
    const out: Record<string, { running: number; queued: number }> = {};
    for (const b of this.batches.values()) {
      if (!b.engine || !b.accountId) continue;
      const k = acctKey(b.engine, b.accountId);
      const o = (out[k] ??= { running: 0, queued: 0 });
      for (const i of b.items) if (i.status === "running") o.running++;
      else if (i.status === "queued") o.queued++;
    }
    return out;
  }
}

export function publicBatch(b: Batch) {
  const n = (s: ItemStatus) => b.items.filter((i) => i.status === s).length;
  const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);
  return {
    batch_id: b.id,
    status: b.status,
    engine: b.engine,
    account: b.engine && b.accountId ? acctKey(b.engine, b.accountId) : null,
    decided_reason: b.decidedReason ?? null,
    group: b.group ?? null,
    label: b.label ?? null,
    priority: b.priority,
    paused_until: b.pausedUntil && b.status === "paused" ? iso(b.pausedUntil) : null,
    pause_reason: b.status === "paused" ? (b.pauseReason ?? null) : null,
    created_at: iso(b.createdAt),
    finished_at: iso(b.finishedAt),
    counts: { total: b.items.length, queued: n("queued"), running: n("running"), done: n("done"), failed: n("failed") },
    items: b.items.map((i) => ({ job_id: i.job_id, key: i.key ?? null, status: i.status, attempts: i.attempts, error: i.error ?? null })),
  };
}
