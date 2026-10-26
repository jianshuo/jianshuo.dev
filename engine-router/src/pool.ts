// src/pool.ts — 账号池的运行时状态 + 额度监控循环。
//
// 状态（用量、冷却、Seedream 当日张数、学到的单次消耗、轮转游标）落盘到
// state/pool.json，重启不丢。在飞预留不落盘：它由 runs.ts 从在跑的 run 重新算出来。
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { acctKey, loadConfig, loadSecrets, type Config, type EngineName, type Estimate } from "./config.js";
import { probeAccount, type Usage } from "./probes.js";

/** 开工前的用量快照，见 Pool.snapshot / learnDelta。 */
export type Before = { u5: number | null; r5: number | null; u7: number | null; r7: number | null; shared: boolean };
import type { Inflight, SelectState } from "./selector.js";
import { alertAdmin } from "./alert.js";

type Persisted = {
  usage: Record<string, Usage>;
  cooldown: Record<string, number>;
  daily: { date: string; count: Record<string, number> };
  learned: Record<string, Estimate>;
  cursors: Record<string, number>;
};

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export class Pool {
  cfg: Config;
  secrets: Record<string, string>;
  inflight: Inflight = {};
  private p: Persisted = { usage: {}, cooldown: {}, daily: { date: today(), count: {} }, learned: {}, cursors: {} };
  private lastProbe: Record<string, number> = {};
  private timer: NodeJS.Timeout | null = null;
  private probing: Promise<void> | null = null;
  onChange: () => void = () => {};

  constructor(
    private configPath: string,
    private secretsPath: string,
    private statePath: string,
  ) {
    this.cfg = loadConfig(configPath);
    this.secrets = loadSecrets(secretsPath);
    try {
      this.p = { ...this.p, ...JSON.parse(readFileSync(statePath, "utf8")) };
    } catch {}
  }

  /** 热重载配置和密钥；配置坏了抛错、保留旧的。 */
  reload(): void {
    const cfg = loadConfig(this.configPath);
    this.cfg = cfg;
    this.secrets = loadSecrets(this.secretsPath);
    this.lastProbe = {}; // 新账号立刻探
  }

  selectState(): SelectState {
    this.rollDaily();
    return {
      usage: this.p.usage,
      inflight: this.inflight,
      cooldown: this.p.cooldown,
      dailyCount: this.p.daily.count,
      learned: this.p.learned,
      cursors: this.p.cursors,
    };
  }

  usage(key: string): Usage | undefined {
    return this.p.usage[key];
  }

  cooldownUntil(key: string): number {
    return this.p.cooldown[key] ?? 0;
  }

  setCooldown(quotaKey: string, until: number): void {
    this.p.cooldown[quotaKey] = until;
    void this.save();
  }

  countDaily(key: string): void {
    this.rollDaily();
    this.p.daily.count[key] = (this.p.daily.count[key] ?? 0) + 1;
    void this.save();
  }

  /** 单次消耗学习：指数滑动平均（新样本权重 0.3）。 */
  learn(taskClass: string, engine: EngineName, sample: Estimate): void {
    const k = `${taskClass}|${engine}`;
    const prev = this.p.learned[k];
    const a = 0.3;
    this.p.learned[k] = prev
      ? { d5h: prev.d5h * (1 - a) + sample.d5h * a, d7d: prev.d7d * (1 - a) + sample.d7d * a }
      : sample;
    void this.save();
  }

  /** 开工前的用量快照（run 的 attempt 和 lease 共用）。shared＝开工时这个账号上已有别的活，前后相减会混进别人的消耗。 */
  snapshot(quotaKey: string, conc: string): Before | undefined {
    const u = this.usage(quotaKey);
    const shared = (this.inflight[quotaKey]?.count ?? 0) > 0 || (this.inflight[conc]?.count ?? 0) > 0;
    return u ? { u5: u.used5h, r5: u.reset5h, u7: u.used7d, r7: u.reset7d, shared } : undefined;
  }

  /**
   * 单次消耗学习：结束后探一次，同一窗口内、没有并发干扰时，前后相减（run 和 lease 共用，调用前要先释放自己的预留）。
   * 返回学到的样本，没学（有并发、跨窗口、探不到）返回 undefined。
   */
  async learnDelta(taskClass: string, engine: EngineName, quotaKey: string, accountId: string, b: Before | undefined): Promise<Estimate | undefined> {
    if (!b || b.shared) return;
    const probeEngine = quotaKey.split("/")[0] as EngineName;
    if (probeEngine !== "kimi" && probeEngine !== "codex" && probeEngine !== "claude") return;
    const after = await this.probe(probeEngine, accountId);
    if (!after?.healthy || (this.inflight[quotaKey]?.count ?? 0) > 0) return;
    const same = (x: number | null, y: number | null) => x != null && y != null && Math.abs(x - y) < 120_000;
    if (!same(b.r5, after.reset5h) || b.u5 == null || after.used5h == null) return;
    const d5h = Math.max(0, after.used5h - b.u5);
    const d7d = same(b.r7, after.reset7d) && b.u7 != null && after.used7d != null ? Math.max(0, after.used7d - b.u7) : d5h / 5;
    this.learn(taskClass, engine, { d5h, d7d });
    return { d5h, d7d };
  }

  /**
   * 在飞预留：并发记在真实账号键上，额度预留记在额度键上（gpt-image/codex-1 → codex/codex-1）。
   * run 和 lease 共用这一处。
   */
  reserve(conc: string, quota: string, est: Estimate, sign: 1 | -1): void {
    const bump = (k: string, d5h: number, d7d: number, count: number) => {
      const cur = this.inflight[k] ?? { count: 0, d5h: 0, d7d: 0 };
      this.inflight[k] = { count: Math.max(0, cur.count + count), d5h: Math.max(0, cur.d5h + d5h), d7d: Math.max(0, cur.d7d + d7d) };
    };
    bump(conc, 0, 0, sign);
    bump(quota, sign * est.d5h, sign * est.d7d, 0);
  }

  learnedTable(): Record<string, Estimate> {
    return this.p.learned;
  }

  private rollDaily(): void {
    if (this.p.daily.date !== today()) this.p.daily = { date: today(), count: {} };
  }

  private saving: Promise<void> = Promise.resolve();

  /** 串行落盘：并发的 save 共用一个 tmp 文件会互相 rename 掉（ENOENT）。 */
  save(): Promise<void> {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.statePath), { recursive: true });
        const tmp = this.statePath + ".tmp";
        await writeFile(tmp, JSON.stringify(this.p, null, 1));
        await rename(tmp, this.statePath);
      })
      .catch((e) => console.error("[pool] save failed", e));
    return this.saving;
  }

  /** 需要直接探的账号（gpt-image 读 quota_from，seedream 无窗口，都不探）。 */
  probeTargets(): { engine: EngineName; id: string; key: string }[] {
    const out: { engine: EngineName; id: string; key: string }[] = [];
    for (const engine of ["kimi", "codex", "claude"] as EngineName[])
      for (const a of this.cfg.engines[engine]?.accounts ?? []) if (!a.disabled) out.push({ engine, id: a.id, key: acctKey(engine, a.id) });
    return out;
  }

  /** 探一个账号并记账；健康状态翻转时告警。返回新用量。 */
  async probe(engine: EngineName, id: string): Promise<Usage | undefined> {
    const a = this.cfg.engines[engine]?.accounts.find((x) => x.id === id);
    if (!a) return undefined;
    const key = acctKey(engine, id);
    const before = this.p.usage[key];
    // gpt-image 和 codex 同名账号共用一条链：任一边有 run 在跑都算忙。
    const codexBusy =
      engine === "codex" && ((this.inflight[key]?.count ?? 0) > 0 || (this.inflight[acctKey("gpt-image", id)]?.count ?? 0) > 0);
    const u = await probeAccount(engine, a, { secrets: this.secrets, codexBusy });
    this.lastProbe[key] = Date.now();
    // 探针一时失败（网络抖动、未知）不覆盖上一次的好数据，只记错误。
    if (u.healthy && u.used5h == null && u.used7d == null && before?.healthy && u.error) {
      this.p.usage[key] = { ...before, error: u.error };
    } else {
      this.p.usage[key] = u;
    }
    if (before?.healthy !== false && !u.healthy)
      void alertAdmin(`unhealthy:${key}`, `engine-router：${key} 不可用`, u.error ?? "", this.secrets.ADMIN_PUSH_TOKEN);
    if (before && !before.healthy && u.healthy) console.log(`[pool] ${key} recovered`);
    await this.save();
    this.onChange();
    return this.p.usage[key];
  }

  /**
   * 一轮：到点的账号逐个探（串行，1 核小机器别并发）。已有一轮在跑时：普通调用直接跳过；
   * force（admin/probe、reload）等那一轮跑完再强制补一轮——否则 reload 后紧跟的 probe
   * 会立刻返回旧数据（2026-10-25 加 claude-2 时撞到）。
   */
  async tick(force = false): Promise<void> {
    if (this.probing) {
      if (!force) return;
      await this.probing;
      if (this.probing) return this.probing; // 等待期间别人又起了一轮
    }
    this.probing = (async () => {
      const now = Date.now();
      for (const t of this.probeTargets()) {
        const every = (t.engine === "claude" ? this.cfg.limits.claude_probe_every_s : this.cfg.limits.probe_every_s) * 1000;
        if (force || now - (this.lastProbe[t.key] ?? 0) >= every) await this.probe(t.engine, t.id);
      }
    })().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
