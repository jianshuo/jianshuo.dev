// src/runs.ts — 任务调度：排队 → 挑账号 → 起 runner → 监视 → 收尾（成功 / 换账号 / 认输）。
//
// 每个 run 落盘 runs/<id>.json；runner 是 detached 子进程，router 重启不杀它（unit 里
// KillMode=process），新进程启动时从 run 文件 + 结果文件接手。在飞预留从 running 的
// run 重新算，不单独落盘。
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ENGINE_NAMES, modelFor, type EngineName, type Kind } from "./config.js";
import { APP_ROOT, RUNS_DIR, WORK_ROOT } from "./env.js";
import { shouldTryNextLeg } from "./legs.js";
import type { Pool } from "./pool.js";
import { reserveKeys, select, type SelectRequest, type SelectResult } from "./selector.js";
import type { AttemptResult, AttemptSpec, Capabilities, RunEvent } from "./spec.js";
import { continuation, handoffPrompt, strictAllow, type Continuity, type ThreadStore } from "./threads.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type RunRequest = {
  kind: Kind;
  task_class: string;
  prompt: string;
  thread_id?: string;
  continuity: Continuity;
  instructions?: string;
  workdir?: string;
  context_dirs: string[];
  capabilities: Capabilities;
  env: Record<string, string>;
  quality?: "best" | "fast";
  engine_hints: { avoid: EngineName[]; require: EngineName[] };
  output_schema?: unknown;
  budget: { max_turns: number; timeout_ms: number; size?: "small" | "medium" | "large" };
  priority: "user" | "normal" | "background";
  resume_hint?: string;
  idempotency_key?: string;
  label?: string; // 给人看的一句（书名等），只用于状态页
  callback_url?: string;
  on_exhausted: "queue" | "fail";
  force: boolean;
};

export type Attempt = {
  n: number;
  engine: EngineName;
  accountId: string;
  key: string;
  quotaKey: string;
  tier: number; // 会话档位：0 新会话 / 1 原账号 / 2 同家族 / 3 交接
  startedAt: number;
  endedAt?: number;
  pid?: number;
  ok?: boolean;
  error?: string;
  sessionId?: string;
  deadSince?: number; // watch 第一次发现 runner 没了还没结果的时刻
  estimate: { d5h: number; d7d: number };
  before?: { u5: number | null; r5: number | null; u7: number | null; r7: number | null; shared: boolean };
};

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type RunRecord = {
  id: string;
  caller: string;
  createdAt: number;
  status: RunStatus;
  req: RunRequest;
  threadId: string;
  attempts: Attempt[];
  tried: string[]; // 本 run 里拒答过的账号（永久排除）；额度/凭据问题不进这里，靠冷却
  queuedReason?: string;
  eta?: number | null;
  reply?: string;
  result?: unknown;
  error?: string;
  finishedAt?: number;
};

const MAX_ATTEMPTS = 6;
const PRIORITY = { user: 0, normal: 1, background: 2 } as const;
/**
 * 绝对路径并解析符号链接。还不存在的路径：解析最近一个存在的上级，再把剩下的拼回去——
 * 否则新书目录（还没建）和它已存在的上级一个解析了一个没解析，比较对不上。
 * 根和调用方路径都要过这一道。
 */
function real(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(p);
      tail.unshift(basename(head));
      head = parent;
    }
  }
}
const roots = (spec: string) =>
  spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(real);
// 每次校验时现算：模块加载时目录可能还不存在，符号链接解析不了，之后就对不上了。
const workdirRoots = () => roots(process.env.WORKDIR_ROOTS ?? `${WORK_ROOT},/opt/claude-agent/workspace`);
// 参考资料目录（只读的 skill 等）：工作目录的根 + 额外的只读根。
const contextRoots = () => [...workdirRoots(), ...roots(process.env.CONTEXT_ROOTS ?? "/opt/claude-agent/.claude/skills")];

/**
 * 调用方给的路径必须落在白名单根下（先解析符号链接）。router 自己的目录（.env、
 * accounts/ 里的 Codex 凭据、state/）一律不行——work/ 下面的 thread 目录除外；
 * work/ 根本身也不行（否则能看到别的调用方的 thread 目录）。
 */
function checkPath(p: unknown, allowed: string[], what: string): string {
  const abs = real(String(p));
  const under = (r: string) => abs === r || abs.startsWith(r + sep);
  const appRoot = real(APP_ROOT);
  const workRoot = real(WORK_ROOT);
  if (abs === workRoot || (under(appRoot) && !abs.startsWith(workRoot + sep)))
    throw new HttpError(400, `${what} not allowed: ${abs}`);
  if (!allowed.some(under)) throw new HttpError(400, `${what} must be under one of: ${allowed.join(", ")}`);
  return abs;
}

// 调用方的 env 只用来给工具传业务密钥（如 PAINT_API_TOKEN）。会改变进程行为或隔离边界的
// 一律拒：HOME/CLAUDE_CONFIG_DIR 会绕过 auto-memory 隔离和会话目录，NODE_OPTIONS/LD_* 能注入代码。
const ENV_DENY =
  /^(HOME|PATH|USER|LOGNAME|SHELL|PWD|TMPDIR|TMP|TEMP|BASH_ENV|ENV|IFS|NODE_.*|LD_.*|DYLD_.*|PYTHON.*|PERL.*|RUBY.*|NPM_.*|CLAUDE_.*|ANTHROPIC_.*|CODEX_.*|OPENAI_.*|XDG_.*|GIT_.*|SSH_.*|SUDO_.*|SYSTEMD_.*|DBUS_.*)$/i;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const newId = (p: string) => p + "_" + randomBytes(9).toString("base64url");
const runFile = (id: string) => join(RUNS_DIR, id + ".json");
export const eventsFile = (id: string) => join(RUNS_DIR, id + ".jsonl");
const resultFile = (id: string, n: number) => join(RUNS_DIR, `${id}.result-${n}.json`);

function asEngines(x: unknown): EngineName[] {
  if (!Array.isArray(x)) return [];
  return x.filter((e): e is EngineName => ENGINE_NAMES.includes(e));
}

/** 校验 + 补缺省。除 prompt 外全部可选。 */
export function normalizeRequest(b: any): RunRequest {
  if (!b || typeof b !== "object") throw new HttpError(400, "body must be a JSON object");
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  if (!prompt.trim()) throw new HttpError(400, "prompt required");
  if (prompt.length > 200_000) throw new HttpError(413, "prompt too long");
  const kind: Kind = b.kind === "image" ? "image" : "text";
  if (kind === "image") throw new HttpError(400, "images go through POST /v1/image-batches");
  if (b.thread_id != null && !ID_RE.test(String(b.thread_id))) throw new HttpError(400, "bad thread_id");
  const continuity: Continuity = ["strict", "loose", "none"].includes(b.continuity) ? b.continuity : "loose";
  const workdir = b.workdir != null ? checkPath(b.workdir, workdirRoots(), "workdir") : undefined;
  const context_dirs = Array.isArray(b.context_dirs) ? b.context_dirs.slice(0, 10).map((d: unknown) => checkPath(d, contextRoots(), "context_dir")) : [];
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || ENV_DENY.test(k)) throw new HttpError(400, `env ${k} not allowed`);
    env[k] = String(v);
  }
  const budget = b.budget ?? {};
  const size = ["small", "medium", "large"].includes(budget.size) ? budget.size : undefined;
  return {
    kind,
    task_class: typeof b.task_class === "string" && b.task_class ? b.task_class.slice(0, 40) : "default",
    prompt,
    thread_id: b.thread_id ?? undefined,
    continuity,
    instructions: typeof b.instructions === "string" ? b.instructions : undefined,
    workdir,
    context_dirs,
    capabilities: { shell: b.capabilities?.shell, network: b.capabilities?.network, write: b.capabilities?.write },
    env,
    quality: b.quality === "fast" ? "fast" : b.quality === "best" ? "best" : undefined,
    engine_hints: { avoid: asEngines(b.engine_hints?.avoid), require: asEngines(b.engine_hints?.require) },
    output_schema: b.output_schema ?? undefined,
    budget: {
      max_turns: Math.min(500, Math.max(1, Number(budget.max_turns) || 160)),
      timeout_ms: Math.min(6 * 3600_000, Math.max(60_000, Number(budget.timeout_ms) || 3 * 3600_000)),
      size,
    },
    priority: b.priority === "background" ? "background" : b.priority === "user" ? "user" : "normal",
    resume_hint: typeof b.resume_hint === "string" ? b.resume_hint : undefined,
    idempotency_key: typeof b.idempotency_key === "string" ? b.idempotency_key.slice(0, 120) : undefined,
    label: typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 120) : undefined,
    callback_url: typeof b.callback_url === "string" && /^https?:\/\//.test(b.callback_url) ? b.callback_url : undefined,
    on_exhausted: b.on_exhausted === "fail" ? "fail" : "queue",
    force: b.force === true,
  };
}

/** 撞墙之后这个账号冷却到什么时候（按错误类型）。内容拒答不冷却——换别家写，这家照样能接别的活。 */
const REFUSAL_RE = /violate.{0,20}usage policy|unable to respond to this request|\brefusal\b|high risk/i;
export const isRefusal = (error: string) => REFUSAL_RE.test(error);

export function cooldownFor(error: string, u: { reset5h: number | null; reset7d: number | null } | undefined, now: number): number {
  if (isRefusal(error)) return 0;
  if (/weekly|7-day|7d/i.test(error) && u?.reset7d && u.reset7d > now) return u.reset7d;
  if (/usage limit|quota|rate[ _-]?limit|too many requests|\b429\b|api error: 403/i.test(error))
    return u?.reset5h && u.reset5h > now ? u.reset5h : now + 30 * 60_000;
  return now + 30 * 60_000; // 凭据 / 模型被拒：先冷却，探针会把它标成不健康
}

export type RunsOptions = {
  spawnRunner?: (specPath: string, logPath: string) => number; // 测试注入
  pidAlive?: (pid: number) => boolean;
  callbackSecret?: string;
};

export class Runs {
  runs = new Map<string, RunRecord>();
  private idem = new Map<string, string>();
  private pumping: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private pool: Pool,
    private threads: ThreadStore,
    private opts: RunsOptions = {},
  ) {}

  async load(): Promise<void> {
    await mkdir(RUNS_DIR, { recursive: true });
    await this.prune();
    for (const f of await readdir(RUNS_DIR)) {
      if (!/^r_[A-Za-z0-9_-]+\.json$/.test(f)) continue;
      try {
        const r = JSON.parse(await readFile(join(RUNS_DIR, f), "utf8")) as RunRecord;
        // 只把没结束的和最近一天的放进内存
        if (r.status === "queued" || r.status === "running" || Date.now() - (r.finishedAt ?? r.createdAt) < 86400_000) {
          this.runs.set(r.id, r);
          if (r.req.idempotency_key) this.idem.set(`${r.caller}|${r.req.idempotency_key}`, r.id);
          if (r.status === "running") this.reserve(r, r.attempts[r.attempts.length - 1], +1);
        }
      } catch {}
    }
  }

  /** 已结束超过 14 天的 run：连同事件流、attempt/result/log 一起删（启动时 + 每天一次）。 */
  async prune(keepMs = 14 * 86400_000): Promise<void> {
    const files = await readdir(RUNS_DIR).catch(() => [] as string[]);
    const now = Date.now();
    for (const f of files) {
      const m = /^(r_[A-Za-z0-9_-]+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const r = JSON.parse(await readFile(join(RUNS_DIR, f), "utf8")) as RunRecord;
        if (!r.finishedAt || now - r.finishedAt < keepMs) continue;
        for (const g of files) if (g.startsWith(m[1] + ".")) await unlink(join(RUNS_DIR, g)).catch(() => {});
        this.runs.delete(r.id);
      } catch {}
    }
  }

  start(): void {
    const daily = setInterval(() => void this.prune(), 86400_000);
    daily.unref?.();
    this.timer = setInterval(() => {
      void this.watch();
      this.pump();
    }, 2000);
    this.timer.unref?.();
    this.pump();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  async submit(raw: any, caller: string): Promise<{ run: RunRecord; existing: boolean }> {
    const req = normalizeRequest(raw);
    await mkdir(RUNS_DIR, { recursive: true });
    // 幂等：同一个键还在排队/在跑/已写成 → 接回那一个（调用方进程重启后重提交，不会跑出两份）；
    // 上次失败或取消了 → 允许重来（例如 VPS 重启把 runner 杀了，调用方续跑要的是新的一次）。
    if (req.idempotency_key) {
      const prev = this.runs.get(this.idem.get(`${caller}|${req.idempotency_key}`) ?? "");
      if (prev && prev.status !== "failed" && prev.status !== "cancelled") return { run: prev, existing: true };
    }
    let thread = req.thread_id ? await this.threads.get(req.thread_id) : undefined;
    if (req.thread_id && !thread) throw new HttpError(404, "thread not found");
    if (thread && thread.caller !== caller) throw new HttpError(403, "thread belongs to another caller");
    const id = newId("r");
    if (!thread) {
      const tid = newId("t");
      const workdir = req.workdir ?? join(WORK_ROOT, tid);
      await mkdir(workdir, { recursive: true }).catch(() => {});
      thread = await this.threads.create(tid, caller, workdir);
    }
    thread.runs.push(id);
    await this.threads.save(thread);
    const run: RunRecord = { id, caller, createdAt: Date.now(), status: "queued", req, threadId: thread.id, attempts: [], tried: [] };
    this.runs.set(id, run);
    if (req.idempotency_key) this.idem.set(`${caller}|${req.idempotency_key}`, id);
    await this.save(run);
    await this.event(run, { type: "queued" });
    this.pump();
    return { run, existing: false };
  }

  async cancel(id: string): Promise<RunRecord | undefined> {
    const r = this.runs.get(id);
    if (!r || (r.status !== "queued" && r.status !== "running")) return r;
    const a = r.attempts[r.attempts.length - 1];
    // endedAt 是「这次 attempt 已收尾」的唯一标记：cancel 和 finishAttempt 谁先同步地设上它，
    // 谁负责释放预留——另一个看到已设就跳过，预留只释放一次。
    if (r.status === "running" && a && a.endedAt == null) {
      if (a.pid) {
        try {
          process.kill(-a.pid, "SIGTERM"); // detached = 自成进程组，连同引擎 CLI 一起
        } catch {}
      }
      a.endedAt = Date.now();
      a.ok = false;
      a.error = "cancelled";
      this.reserve(r, a, -1);
    }
    await this.finish(r, "cancelled", { error: "cancelled" });
    return r;
  }

  /** 干跑：这个请求现在会选谁、为什么。不推进 round_robin 游标，看不到别人的 thread。 */
  async dryRun(raw: any, caller: string): Promise<SelectResult> {
    // 出图不在 router 里执行（走租约），但干跑只是挑选，照样能看「现在会给谁」
    const req = normalizeRequest({ ...raw, kind: "text" });
    if (raw?.kind === "image") req.kind = "image";
    const thread = req.thread_id ? await this.threads.get(req.thread_id) : undefined;
    if (req.thread_id && (!thread || (thread.caller !== caller && caller !== "admin"))) throw new HttpError(404, "thread not found");
    const st = this.pool.selectState();
    return select(this.pool.cfg, { ...st, cursors: { ...st.cursors } }, this.selectRequest(req, thread, []));
  }

  // ── 调度 ────────────────────────────────────────────────────────────────
  pump(): void {
    this.pumping = this.pumping.then(() => this.pumpOnce()).catch((e) => console.error("[runs] pump", e));
  }

  private selectRequest(req: RunRequest, thread: Awaited<ReturnType<ThreadStore["get"]>>, tried: string[]): SelectRequest {
    const sr: SelectRequest = {
      kind: req.kind,
      taskClass: req.task_class,
      size: req.budget.size,
      avoid: req.engine_hints.avoid,
      require: req.engine_hints.require,
      exclude: tried,
      force: req.force,
      capabilities: req.capabilities,
    };
    if (thread?.lastKey && req.continuity !== "none") {
      sr.prefer = thread.lastKey; // 粘性：原账号合格就继续用它，历史完整
      if (req.continuity === "strict") sr.allow = strictAllow(this.pool.cfg, thread);
    }
    return sr;
  }

  private async pumpOnce(): Promise<void> {
    const queued = [...this.runs.values()]
      .filter((r) => r.status === "queued")
      .sort((a, b) => PRIORITY[a.req.priority] - PRIORITY[b.req.priority] || a.createdAt - b.createdAt);
    for (const r of queued) {
      // 快照是循环开始时拍的；每次 await 之后都要重看——期间可能被 cancel 了。
      if (r.status !== "queued") continue;
      const running = [...this.runs.values()].filter((x) => x.status === "running" && x.req.kind === r.req.kind).length;
      const cap = this.pool.cfg.concurrency.global_text; // 出图不走 run（kind:image 在 normalizeRequest 就拒了），走 batches.ts
      if (running >= cap) {
        await this.setQueued(r, `global concurrency ${running}/${cap}`, null);
        continue;
      }
      const thread = await this.threads.get(r.threadId);
      if (r.status !== "queued") continue;
      const res = select(this.pool.cfg, this.pool.selectState(), this.selectRequest(r.req, thread, r.tried));
      if (!res.pick) {
        const why = res.candidates.length ? res.candidates.map((c) => `${c.key}: ${c.reason}`).join("; ") : "no account configured for this kind";
        const nothingLeft = res.waitUntil == null || r.attempts.length >= MAX_ATTEMPTS;
        if (r.req.on_exhausted === "fail" || nothingLeft) {
          const last = r.attempts[r.attempts.length - 1];
          await this.finish(r, "failed", { error: last?.error ? `all accounts tried; last error: ${last.error}` : `no eligible account: ${why}` });
        } else {
          await this.setQueued(r, why, res.waitUntil);
        }
        continue;
      }
      await this.startAttempt(r, thread!, res.pick.engine, res.pick.account.id, res.pick.estimate);
    }
  }

  private async setQueued(r: RunRecord, reason: string, eta: number | null): Promise<void> {
    if (r.queuedReason === reason && r.eta === eta) return;
    r.queuedReason = reason;
    r.eta = eta;
    await this.save(r);
    await this.event(r, { type: "queued", reason, eta: eta ?? undefined });
  }

  private reserve(r: RunRecord, a: Attempt | undefined, sign: 1 | -1): void {
    if (a) this.pool.reserve(a.key, a.quotaKey, a.estimate, sign);
  }

  private async startAttempt(r: RunRecord, thread: NonNullable<Awaited<ReturnType<ThreadStore["get"]>>>, engine: EngineName, accountId: string, estimate: { d5h: number; d7d: number }): Promise<void> {
    const cfg = this.pool.cfg;
    const { conc: key, quota: quotaKey } = reserveKeys(cfg, engine, accountId);
    const n = r.attempts.length + 1;
    const cont = r.req.continuity === "none" ? { tier: 0 as const } : continuation(cfg, thread, key);
    let prompt = r.req.prompt;
    if (cont.tier === 3) prompt = handoffPrompt(thread, prompt);
    if (n > 1) {
      prompt +=
        "\n\n" +
        (r.req.resume_hint ??
          `补充：本任务上一次尝试因引擎额度或凭据问题中断，可能已经做了一部分——动手前先检查工作目录 ${thread.workdir} 的现状，接着做完，不要从头另起。`);
    }
    const a: Attempt = {
      n,
      engine,
      accountId,
      key,
      quotaKey,
      tier: cont.tier,
      startedAt: Date.now(),
      estimate,
      before: this.pool.snapshot(quotaKey, key),
    };
    const spec: AttemptSpec = {
      runId: r.id,
      attempt: n,
      engine,
      accountId,
      model: modelFor(cfg, engine, r.req.quality),
      prompt,
      instructions: r.req.instructions,
      resumeSession: cont.session,
      firstTurn: !cont.session,
      workdir: thread.workdir,
      contextDirs: r.req.context_dirs,
      cwd: thread.cwd,
      env: r.req.env,
      capabilities: r.req.capabilities,
      outputSchema: r.req.output_schema,
      maxTurns: r.req.budget.max_turns,
      timeoutMs: r.req.budget.timeout_ms,
    };
    const specPath = join(RUNS_DIR, `${r.id}.attempt-${n}.json`);
    await writeFile(specPath, JSON.stringify(spec));
    if (r.status !== "queued") return; // 写 spec 的工夫里被 cancel 了：不起跑
    r.attempts.push(a);
    r.status = "running";
    r.queuedReason = undefined;
    r.eta = undefined;
    this.reserve(r, a, +1);
    try {
      a.pid = (this.opts.spawnRunner ?? defaultSpawn)(specPath, join(RUNS_DIR, `${r.id}.log`));
    } catch (e: any) {
      a.error = `spawn failed: ${e?.message ?? e}`;
    }
    await this.save(r);
    await this.event(r, { type: "started", attempt: n, account: key });
    console.log(`[runs] ${r.id} attempt ${n} → ${key} (tier ${cont.tier}, est 5h ${estimate.d5h.toFixed(1)})`);
  }

  // ── 监视与收尾 ──────────────────────────────────────────────────────────
  private watching = false;

  /**
   * 每 2 秒一轮。防重入：上一轮还没走完（读文件、收尾里有 await）就跳过——两轮重叠会把同一
   * 次 attempt 收尾两次，第二次甚至落到新起的 attempt 上（代码审查 #1）。「进程没了还没结果」
   * 不再原地睡等：这一轮记下时刻，3 秒后的轮次再确认。
   */
  async watch(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      for (const r of this.runs.values()) {
        if (r.status !== "running") continue;
        const a = r.attempts[r.attempts.length - 1];
        if (!a || a.endedAt != null) continue;
        const rf = resultFile(r.id, a.n);
        let res: AttemptResult | null = null;
        if (existsSync(rf)) {
          try {
            res = JSON.parse(await readFile(rf, "utf8"));
          } catch {} // 半截文件：下一轮再读
        } else if (a.error?.startsWith("spawn failed")) {
          res = { ok: false, reply: "", error: a.error, sessionId: "" };
        } else if (a.pid && !(this.opts.pidAlive ?? pidAlive)(a.pid) && Date.now() - a.startedAt > 5000) {
          // 结果文件可能正在 rename：先记下，过 3 秒还没有才判死
          if (!a.deadSince) a.deadSince = Date.now();
          else if (Date.now() - a.deadSince >= 3000) res = { ok: false, reply: "", error: "runner died without a result", sessionId: "" };
        }
        if (res) await this.finishAttempt(r, a, res);
      }
    } finally {
      this.watching = false;
    }
  }

  private async finishAttempt(r: RunRecord, a: Attempt, res: AttemptResult): Promise<void> {
    // 只收尾「当前在跑的最后一次 attempt」，且只收一次。标记和释放预留都在第一个 await 之前
    // 同步完成——cancel() 用同一个 endedAt 判断，谁先到谁释放（审查 #3）。
    if (r.status !== "running" || a.endedAt != null || r.attempts[r.attempts.length - 1] !== a) return;
    a.endedAt = Date.now();
    a.ok = res.ok;
    a.error = res.ok ? undefined : res.error;
    a.sessionId = res.sessionId || a.sessionId;
    this.reserve(r, a, -1);
    void this.learnAfter(r, a);

    const thread = await this.threads.get(r.threadId);
    if (thread && a.sessionId) {
      thread.sessions[a.key] = a.sessionId;
      thread.lastKey = a.key;
    }
    if (r.status !== "running") {
      // await 期间被 cancel 了：会话号照记（下次续聊还能接上），状态不动
      if (thread) await this.threads.save(thread);
      return;
    }

    if (res.ok) {
      if (thread) {
        thread.turns.push({ prompt: r.req.prompt, reply: res.reply, account: a.key, ts: Date.now() });
        await this.threads.save(thread);
      }
      await this.finish(r, "done", { reply: res.reply, result: res.result });
      return;
    }
    if (thread) await this.threads.save(thread);

    if (shouldTryNextLeg(res.error) && r.attempts.length < MAX_ATTEMPTS) {
      const until = cooldownFor(res.error, this.pool.usage(a.quotaKey), Date.now());
      if (until) this.pool.setCooldown(a.quotaKey, until);
      // 只有内容拒答才在本 run 里永久排除这个账号（换别家写）；额度/凭据问题靠冷却——冷却会
      // 结束，排队模式就能等到最早恢复的账号，而不是三家都撞过一次就判失败（审查 #5）。
      if (isRefusal(res.error)) r.tried.push(a.key);
      r.status = "queued";
      await this.save(r);
      await this.event(r, { type: "switched", from: a.key, reason: res.error.slice(0, 300) });
      console.log(`[runs] ${r.id} ${a.key} 用不了 → 换账号：${res.error.slice(0, 160)}`);
      void this.pool.probe(a.quotaKey.split("/")[0] as EngineName, a.accountId); // 凭据类错误让探针标成不健康
      this.pump();
      return;
    }
    await this.finish(r, "failed", { error: res.error });
  }

  /** 单次消耗学习：结束后探一次，同一窗口内、没有并发干扰时，前后相减（规则在 Pool.learnDelta，lease 共用）。 */
  private async learnAfter(r: RunRecord, a: Attempt): Promise<void> {
    if (!a.ok) return;
    const s = await this.pool.learnDelta(r.req.task_class, a.engine, a.quotaKey, a.accountId, a.before);
    if (s) console.log(`[runs] learned ${r.req.task_class}|${a.engine}: +${s.d5h.toFixed(1)} (5h) +${s.d7d.toFixed(1)} (week)`);
  }

  private async finish(r: RunRecord, status: RunStatus, out: { reply?: string; result?: unknown; error?: string }): Promise<void> {
    r.status = status;
    r.reply = out.reply;
    r.result = out.result;
    r.error = out.error;
    r.finishedAt = Date.now();
    r.queuedReason = undefined;
    r.eta = undefined;
    await this.save(r);
    await this.event(r, { type: "done", ok: status === "done", reply: out.reply, result: out.result, error: out.error });
    console.log(`[runs] ${r.id} ${status}${out.error ? " — " + out.error.slice(0, 160) : ""}`);
    if (r.req.callback_url) void this.callback(r);
    this.pump();
  }

  private async callback(r: RunRecord): Promise<void> {
    const body = JSON.stringify(publicRun(r));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.callbackSecret) headers["X-Router-Signature"] = "sha256=" + createHmac("sha256", this.opts.callbackSecret).update(body).digest("hex");
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(r.req.callback_url!, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return;
      } catch {}
      await new Promise((x) => setTimeout(x, 5000 * (i + 1)));
    }
    console.error(`[runs] callback failed for ${r.id}`);
  }

  private seq = 0;
  private async save(r: RunRecord): Promise<void> {
    const f = runFile(r.id);
    const tmp = `${f}.tmp-${process.pid}-${this.seq++}`; // 同一个 run 可能被连着存两次，tmp 不能共用
    await writeFile(tmp, JSON.stringify(r, null, 1));
    await rename(tmp, f);
  }

  private async event(r: RunRecord, ev: RunEvent): Promise<void> {
    await appendFile(eventsFile(r.id), JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
  }
}

/** 给调用方看的 run（不含 prompt/env 等原始输入，不含内部预留数据）。 */
export function publicRun(r: RunRecord) {
  return {
    run_id: r.id,
    thread_id: r.threadId,
    status: r.status,
    ok: r.status === "done",
    reply: r.reply,
    result: r.result,
    error: r.error,
    queued_reason: r.queuedReason,
    eta: r.eta ? new Date(r.eta).toISOString() : undefined,
    created_at: new Date(r.createdAt).toISOString(),
    finished_at: r.finishedAt ? new Date(r.finishedAt).toISOString() : undefined,
    attempts: r.attempts.map((a) => ({
      n: a.n,
      account: a.key, // 不透明标签，只为排查
      tier: a.tier,
      ok: a.ok,
      error: a.error,
      started_at: new Date(a.startedAt).toISOString(),
      ended_at: a.endedAt ? new Date(a.endedAt).toISOString() : undefined,
    })),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

function defaultSpawn(specPath: string, logPath: string): number {
  const fd = openSync(logPath, "a"); // spawn 要真 fd
  const child = spawn(process.execPath, [join(APP_ROOT, "dist", "runner.js"), specPath], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  return child.pid ?? 0;
}
