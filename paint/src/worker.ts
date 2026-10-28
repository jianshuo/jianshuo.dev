import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "./config.js";
import type { JobStore, Job } from "./store.js";
import type { EventHub } from "./events.js";
import { buildArgs, parseResult, parseEventLine, isModelRejected, isRateLimited } from "./engine.js";
import { seedreamSize, refImageDataUri, seedreamGenerate, finalizeImage } from "./seedream.js";
import { deliver, type CallbackPayload } from "./callback.js";
import { buildXmp, embedXmp } from "./xmp.js";
import { httpRouter, type BatchIn, type Claim, type ImageRouter, type RouterBatch } from "./router.js";

const EXT: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };

// OpenAI 输出端内容过滤会概率性扣下已生成的图（响应正常结束但没有图片项，
// 同一 prompt 重跑大概率就过）——这类错误自动重试一次。
const RETRYABLE = new Set(["missing_image_result"]);
const MAX_ATTEMPTS = 2;
const HEARTBEAT_MS = 30_000;
const SYNC_MS = 60_000;

type EngineError = { code: string; message: string; detail?: unknown };
type LegResult = { ok: boolean; bytes: number; error?: EngineError };
export type Executed = { ok: boolean; error?: EngineError; attempts: number };
type Running = { child?: ChildProcess; stopped?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 报给 router 的错误原文：detail 里才有 usage_limit_reached / resets_at 这些原话，router 靠它判冷却多久 */
export function errorText(e: EngineError | undefined): string {
  if (!e) return "unknown: generation failed";
  const d = e.detail ? " " + String(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)).slice(0, 400) : "";
  return `${e.code}: ${e.message}${d}`;
}

// image_url 输入的异步下载（2026-07-25 从 submitJob 挪来）：提交方不再为跨洋原图
// 干等 5–8s 才拿 202。URL 的协议/内网黑名单校验在提交时已做过；redirect:"manual"
// 与原实现一致——3xx 直接拒，防止已过校验的 host 重定向到内网目标。
export async function downloadInput(url: string, inputPath: string, maxBytes: number, timeoutMs = 30000): Promise<void> {
  const r = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs)), redirect: "manual" });
  if (!r.ok || !r.body) throw new Error(`image_url fetch failed: ${r.status}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of r.body as any) {
    total += (c as Uint8Array).length;
    if (total > maxBytes) throw new Error("input image too large");
    chunks.push(Buffer.from(c));
  }
  await writeFile(inputPath, Buffer.concat(chunks));
}

/**
 * 出图执行器（2026-10-28 起只执行，不调度）。
 *
 * 调度全在 engine-router：job 建好后整批交过去（submitBatch），router 一批定一个引擎、按账号并发
 * 排队；这里向它领活（claim）、按它给的引擎画、画完回报（complete），画的时候每 30 秒心跳。
 * 失败的单是「这张失败」还是「放回队列 / 整批暂停」由 router 判定（它回报里给 status），
 * 这里照办：失败才回调，放回队列就把 job 改回 queued 等下次领。
 * 不再有：自动降级 Seedream、group 粘性、进程内排队——都在 router。规则见 paint/USAGE.md。
 */
export class Worker {
  readonly router: ImageRouter;
  private running = new Map<string, Running>();
  /** 已交批、还没终态的 job（sync 用：router 那边判了失败的，这边要回调） */
  private pending = new Set<string>();
  /** 建好了但还没交上 router 的单张 job（router 一时连不上），后台补交 */
  private unsubmitted = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private pumping = false;
  private pumpAgain = false;
  private claimFailing = false;

  constructor(private store: JobStore, private hub: EventHub, private cfg: Config, router?: ImageRouter) {
    const r = router ?? (cfg.router ? httpRouter(cfg.router.url, cfg.router.token) : undefined);
    if (!r) throw new Error("engine-router is required (ROUTER_URL + ROUTER_TOKEN)");
    this.router = r;
  }

  /** 启动：先把上次没画完的交还 router，补交没交上的，然后开始领活 / 心跳 / 对账。 */
  async start(recovered: string[] = []): Promise<void> {
    try {
      const n = await this.router.releaseAll();
      if (n) console.log(`[worker] 交还 router ${n} 张上次没画完的图`);
    } catch (e: any) {
      console.warn(`[worker] release-all 失败（router 3 分钟没心跳也会自己收回）：${e?.message ?? e}`);
    }
    for (const id of recovered) {
      const j = await this.store.get(id);
      if (!j || j.status !== "queued") continue;
      if (j.batchId) this.pending.add(id);
      else this.unsubmitted.add(id);
    }
    await this.flushUnsubmitted();
    this.timers.push(setInterval(() => void this.pump(), this.cfg.claimIntervalMs));
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.sync().then(() => this.flushUnsubmitted()), SYNC_MS));
    for (const t of this.timers) t.unref?.();
    void this.pump();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** 显式 engine=seedream 能不能接（提交时就校验，免得排队半天再失败） */
  seedreamConfigured(): boolean {
    return !!this.cfg.seedream.apiKey;
  }

  /** 一批 job 交给 router（job 已落盘）。交不上抛错，由调用方决定怎么办。 */
  async submitBatch(jobs: Job[], opts: Omit<BatchIn, "items">): Promise<RouterBatch> {
    const b = await this.router.submitBatch({
      ...opts,
      items: jobs.map((j) => ({ job_id: j.id, ...(j.key ? { key: j.key } : {}), ...(j.params.transparent ? { transparent: true } : {}) })),
    });
    for (const j of jobs) {
      await this.store.update(j.id, { batchId: b.batch_id });
      this.pending.add(j.id);
      this.unsubmitted.delete(j.id);
    }
    void this.pump();
    return b;
  }

  /** 单张（VoiceDrop / 网页 / POST /api/jobs）：插队优先；router 一时连不上不让调用方失败，后台补交。 */
  async submitSingle(job: Job): Promise<void> {
    try {
      await this.submitBatch([job], {
        priority: "interactive",
        ...(job.group ? { group: job.group } : {}),
        ...(job.enginePref && job.enginePref !== "auto" ? { engine: job.enginePref } : {}),
      });
    } catch (e: any) {
      console.warn(`[worker] job ${job.id} 交 router 失败，稍后补交：${e?.message ?? e}`);
      this.unsubmitted.add(job.id);
    }
  }

  private async flushUnsubmitted(): Promise<void> {
    for (const id of [...this.unsubmitted]) {
      const j = await this.store.get(id);
      if (!j || j.status !== "queued" || j.batchId) {
        this.unsubmitted.delete(id);
        continue;
      }
      await this.submitSingle(j);
    }
  }

  /** 向 router 领活，领到就开画。重入安全：正在领时再叫一次会在这一轮结束后补一轮。 */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const free = this.cfg.maxConcurrency - this.running.size;
        if (free <= 0) break;
        let claims: Claim[];
        try {
          claims = await this.router.claim(free);
          if (this.claimFailing) console.log("[worker] router 恢复了");
          this.claimFailing = false;
        } catch (e: any) {
          if (!this.claimFailing) console.warn(`[worker] 向 router 领活失败：${e?.message ?? e}`);
          this.claimFailing = true;
          break;
        }
        for (const c of claims) {
          if (this.running.has(c.job_id)) continue;
          this.running.set(c.job_id, {});
          void this.runClaim(c);
        }
        if (claims.length) this.pumpAgain = true;
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async runClaim(c: Claim): Promise<void> {
    const engine = c.engine === "seedream" ? "seedream" : "codex";
    console.log(`[worker] job ${c.job_id}: ${engine}（批次 ${c.batch_id}）`);
    let res: Executed;
    try {
      res = await this.execute(c.job_id, engine);
    } catch (e: any) {
      console.error(`[worker] job ${c.job_id} crashed`, e);
      res = { ok: false, attempts: 0, error: { code: "crash", message: e?.message ?? String(e) } };
    }
    if (this.running.get(c.job_id)?.stopped && !res.ok) res.error = { code: "cancelled", message: "batch cancelled" };
    this.running.delete(c.job_id);
    let verdict = "";
    try {
      const r = await this.router.complete(c.job_id, { ok: res.ok, ...(res.ok ? {} : { error: errorText(res.error) }) });
      verdict = r?.status ?? "";
    } catch (e: any) {
      console.warn(`[worker] job ${c.job_id} 回报 router 失败（它没心跳会自己重排）：${e?.message ?? e}`);
    }
    if (!res.ok) {
      const job = await this.store.get(c.job_id);
      if (job && verdict === "failed") {
        this.pending.delete(c.job_id);
        await this.fail(job, res.error ?? { code: "unknown", message: "generation failed" }, res.attempts);
      } else if (job) {
        // router 把它放回队列（撞墙暂停 / 被打断重排）或这会儿联系不上：等下次派活
        await this.store.update(c.job_id, { status: "queued", percent: 0, error: res.error ?? null, attempts: res.attempts });
        this.hub.publish(c.job_id, "progress", { percent: 0, phase: "queued" });
      }
    } else this.pending.delete(c.job_id);
    void this.pump();
  }

  /** 心跳：续上在画的；router 叫停的（批次取消）杀掉。 */
  private async heartbeat(): Promise<void> {
    const ids = [...this.running.keys()];
    if (!ids.length) return;
    try {
      for (const id of await this.router.heartbeat(ids)) {
        const r = this.running.get(id);
        if (!r) continue;
        r.stopped = true;
        r.child?.kill("SIGTERM");
        console.log(`[worker] job ${id}: router 叫停`);
      }
    } catch (e: any) {
      console.warn(`[worker] 心跳失败：${e?.message ?? e}`);
    }
  }

  /** 对账：router 判失败了（暂停超时 / 取消）而这边还在排队的 job，补上失败 + 回调。 */
  async sync(): Promise<void> {
    const byBatch = new Map<string, Job[]>();
    for (const id of [...this.pending]) {
      const j = await this.store.get(id);
      if (!j || j.status === "done" || j.status === "failed") {
        this.pending.delete(id);
        continue;
      }
      if (j.status !== "queued" || !j.batchId) continue;
      byBatch.set(j.batchId, [...(byBatch.get(j.batchId) ?? []), j]);
    }
    for (const [bid, jobs] of byBatch) {
      let b: RouterBatch | null;
      try {
        b = await this.router.getBatch(bid);
      } catch {
        continue; // router 一时连不上，下轮再说
      }
      for (const j of jobs) {
        const it = b?.items.find((x) => x.job_id === j.id);
        if (b && it?.status !== "failed") continue;
        this.pending.delete(j.id);
        await this.fail(j, { code: it?.error === "cancelled" ? "cancelled" : "engine_unavailable", message: it?.error ?? `batch ${bid} not found` }, j.attempts ?? 0);
      }
    }
  }

  /**
   * 用 router 指定的引擎画一张（不降级、不换引擎）。成功就地收尾（XMP、done、回调）；
   * 失败只返回错误，终判等 router（runClaim）。
   */
  async execute(id: string, engine: "codex" | "seedream"): Promise<Executed> {
    const job = await this.store.get(id);
    if (!job) return { ok: false, attempts: 0, error: { code: "not_found", message: `job ${id} not found` } };
    if (job.status === "done") return { ok: true, attempts: job.attempts ?? 0 };

    // 期限从开画算（排队在 router，不算）
    const deadline = Date.now() + this.cfg.jobDeadlineMs;
    const left = () => deadline - Date.now();

    // image_url 输入在这里才真正落地（提交时只校验了 URL）
    if (job.inputUrl && job.inputPath) {
      try {
        await downloadInput(job.inputUrl, job.inputPath, this.cfg.maxInputBytes, Math.min(30000, left()));
      } catch (e: any) {
        return { ok: false, attempts: 0, error: { code: "input_download_failed", message: e?.message ?? "input download failed" } };
      }
    }

    await mkdir(this.cfg.resultsDir, { recursive: true });
    const ext = job.params.transparent ? "png" : (EXT[job.params.format] ?? "png");
    const outPath = join(this.cfg.resultsDir, `${id}.${ext}`);

    // 参数合法性先验一次（transparent+edit 这种组合直接拒）；模型留到下面循环里填。
    try {
      buildArgs(job, outPath);
    } catch (e: any) {
      return { ok: false, attempts: 0, error: { code: "invalid_argument", message: e?.message ?? "bad args" } };
    }

    await this.store.update(id, { status: "running", startedAt: new Date().toISOString(), percent: 0, engine });
    this.hub.publish(id, "progress", { percent: 0, phase: "started" });

    let r: LegResult & { attempts: number; model: string };
    if (engine === "seedream") {
      r = !this.seedreamConfigured()
        ? { ok: false, bytes: 0, attempts: 0, model: "", error: { code: "seedream_unavailable", message: "seedream not configured (ARK_API_KEY)" } }
        : job.params.transparent
          ? { ok: false, bytes: 0, attempts: 0, model: "", error: { code: "seedream_unavailable", message: "seedream cannot do transparent output" } }
          : await this.runSeedream(id, job, outPath, deadline);
    } else r = await this.runCodex(id, job, outPath, left);

    if (!r.ok) {
      await this.store.update(id, { model: r.model, engine }); // 失败也留痕：栽在哪个引擎/模型上
      // 输入文件留着：router 可能把这张放回队列再画
      return { ok: false, attempts: r.attempts, error: r.error ?? { code: "unknown", message: "generation failed" } };
    }
    if (job.inputPath) await unlink(job.inputPath).catch(() => {});

    // 出图后、回调前：嵌 XMP 溯源。失败绝不连累任务（spec §4）。
    let bytes = r.bytes;
    try {
      const xmp = buildXmp({
        prompt: job.xmpPrompt === false ? undefined : job.prompt,
        jobId: id,
        model: engine === "seedream" ? r.model : "gpt-image-2",
        createDate: new Date().toISOString(),
        meta: job.xmpMeta,
      });
      const embed = await embedXmp(outPath, xmp);
      if (embed.embedded) bytes = (await stat(outPath)).size; // 文件变大了，bytes 取嵌入后的
      else console.log(`[worker] xmp skipped for ${id}: ${embed.reason}`);
    } catch (e) {
      console.error(`[worker] xmp embed failed for ${id}`, e);
    }

    const done = await this.store.update(id, {
      status: "done", percent: 100, doneAt: new Date().toISOString(), attempts: r.attempts, error: null,
      resultPath: outPath, format: ext === "jpg" ? "jpeg" : ext, bytes,
      size: job.params.size, model: r.model, engine,
    });
    const resultUrl = `${this.cfg.publicBaseUrl}/results/${id}.${ext}`;
    this.hub.publish(id, "done", { result_url: resultUrl, bytes, format: done.format, size: done.size, engine, model: r.model });
    await this.maybeCallback(done, "done", resultUrl, null);
    return { ok: true, attempts: r.attempts };
  }

  /** Codex：按模型候选序列走（账号不认这个模型才换下一个）；安全拦截重试一次；瞬时 429 原地短等。 */
  private async runCodex(id: string, job: Job, outPath: string, left: () => number): Promise<LegResult & { attempts: number; model: string }> {
    let attempts = 0;
    let ok = false;
    let bytes = 0;
    let error: EngineError | undefined;
    let model = this.cfg.codexModels[0];
    for (const candidate of this.cfg.codexModels) {
      model = candidate;
      const args = buildArgs(job, outPath, candidate);
      let missTries = 0;
      let rlTries = 0;
      while (true) {
        attempts++;
        ({ ok, bytes, error } = await this.attempt(id, args, outPath, left()));
        if (ok) break;
        if (error?.code === "deadline_exceeded" || error?.code === "cancelled") break;
        if (RETRYABLE.has(error?.code ?? "") && ++missTries < MAX_ATTEMPTS) {
          await this.store.update(id, { percent: 0 });
          this.hub.publish(id, "progress", { percent: 0, phase: "retrying" });
          continue;
        }
        // 瞬时 429（不是真额度）：原地短等再试
        const wait = this.cfg.rateLimitRetryMs[rlTries];
        if (isRateLimited(error) && wait !== undefined && left() > wait + 60_000) {
          rlTries++;
          console.warn(`[worker] job ${id}: codex 瞬时限流，${wait}ms 后原地重试（第 ${rlTries} 次）`);
          this.hub.publish(id, "progress", { percent: 0, phase: "rate-limited" });
          await sleep(wait);
          continue;
        }
        break;
      }
      if (ok || !isModelRejected(error)) break;
      console.warn(`[worker] job ${id}: 账号不认模型 ${candidate}，换下一个`);
      await this.store.update(id, { percent: 0 });
      this.hub.publish(id, "progress", { percent: 0, phase: "switching-model" });
    }
    return { ok, bytes, error, attempts, model };
  }

  /**
   * Seedream：按 SEEDREAM_MODELS 候选序列试，任一成功即止。
   * 只有「生成」失败才换下一个模型（那是方舟的事）；生成成功后的裁缩/转格式（本机
   * ImageMagick）失败直接 postprocess_error 收场——换模型再生成一次只会再付一次钱、再栽一次。
   */
  private async runSeedream(
    id: string,
    job: Job,
    outPath: string,
    deadline: number,
  ): Promise<LegResult & { attempts: number; model: string }> {
    const sd = this.cfg.seedream;
    const size = seedreamSize(job.params.size, sd.minPixels, sd.maxPixels);
    let image: string | undefined;
    if (job.mode === "edit" && job.inputPath) {
      try {
        image = await refImageDataUri(job.inputPath, this.cfg.convertBin);
      } catch (e: any) {
        return { ok: false, bytes: 0, attempts: 0, model: sd.models[0], error: { code: "postprocess_error", message: `reference image: ${e?.message ?? e}` } };
      }
    }
    let attempts = 0;
    let error: EngineError | undefined;
    let model = sd.models[0];
    for (const candidate of sd.models) {
      if (deadline - Date.now() <= 0) {
        return { ok: false, bytes: 0, attempts, model, error: { code: "deadline_exceeded", message: `job deadline reached during seedream (${error?.message ?? ""})` } };
      }
      model = candidate;
      attempts++;
      await this.store.update(id, { percent: 10 }).catch(() => {});
      this.hub.publish(id, "progress", { percent: 10, phase: `seedream:${candidate}` });
      let buf: Buffer;
      try {
        buf = await seedreamGenerate(sd, candidate, { prompt: job.prompt, size: size.request, image, deadline });
      } catch (e: any) {
        const timedOut = e?.name === "TimeoutError" && deadline - Date.now() <= 1000;
        error = timedOut
          ? { code: "deadline_exceeded", message: `job deadline reached during seedream ${candidate}` }
          : { code: "seedream_error", message: e?.message ?? String(e), detail: e?.detail };
        console.warn(`[worker] job ${id}: seedream ${candidate} 失败：${error.message}`);
        if (timedOut) break;
        continue;
      }
      try {
        this.hub.publish(id, "progress", { percent: 90, phase: "seedream:finalize" });
        await finalizeImage(this.cfg.convertBin, buf, outPath, {
          target: size.target, format: job.params.format, compression: job.params.compression,
        });
        return { ok: true, bytes: (await stat(outPath)).size, attempts, model };
      } catch (e: any) {
        console.error(`[worker] job ${id}: seedream 出图后处理失败（不再换模型重画）：${e?.message ?? e}`);
        return { ok: false, bytes: 0, attempts, model, error: { code: "postprocess_error", message: e?.message ?? String(e) } };
      }
    }
    return { ok: false, bytes: 0, attempts, model, error };
  }

  /** 跑一次 CLI：spawn → 进度转发 → 解析结果 → 校验产物文件。超过 timeoutMs 杀掉 = deadline_exceeded；router 叫停 = cancelled */
  private async attempt(id: string, args: string[], outPath: string, timeoutMs: number): Promise<LegResult> {
    if (timeoutMs <= 0) return { ok: false, bytes: 0, error: { code: "deadline_exceeded", message: "job deadline reached before codex attempt" } };
    const handle = this.running.get(id);
    if (handle?.stopped) return { ok: false, bytes: 0, error: { code: "cancelled", message: "batch cancelled" } };
    const env = { ...process.env };
    if (this.cfg.codexHome) env.CODEX_HOME = this.cfg.codexHome;

    const child = spawn(this.cfg.gptImageBin, args, { env });
    if (handle) handle.child = child;
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, timeoutMs);

    const rl = createInterface({ input: child.stderr });
    rl.on("line", (line) => {
      const ev = parseEventLine(line);
      if (!ev) return;
      if (typeof ev.percent === "number") this.store.update(id, { percent: ev.percent }).catch(() => {});
      this.hub.publish(id, "progress", ev);
    });

    const code: number = await new Promise((res) => {
      child.on("close", (c) => res(c ?? 1));
      child.on("error", () => res(1));
    });
    clearTimeout(timer);
    if (handle) handle.child = undefined;
    if (handle?.stopped) return { ok: false, bytes: 0, error: { code: "cancelled", message: "batch cancelled" } };
    if (killed) return { ok: false, bytes: 0, error: { code: "deadline_exceeded", message: "job deadline reached during codex attempt (killed)" } };

    const result = parseResult(stdout);
    let ok = result.ok && code === 0;
    let bytes = 0;
    if (ok) {
      try {
        bytes = (await stat(outPath)).size;
      } catch {
        ok = false;
        result.error = { code: "no_output", message: "engine reported ok but no output file" };
      }
    }
    return { ok, bytes, error: result.error };
  }

  async fail(job: Job, error: EngineError, attempts: number): Promise<void> {
    if (job.inputPath) await unlink(job.inputPath).catch(() => {});
    // detail 留在 job JSON 里做诊断留痕；对外（事件/回调）只给 code/message
    const failed = await this.store.update(job.id, { status: "failed", error, attempts, doneAt: new Date().toISOString() });
    const publicError = { code: error.code, message: error.message };
    this.hub.publish(job.id, "failed", { error: publicError, engine: failed.engine ?? null, model: failed.model ?? null });
    await this.maybeCallback(failed, "failed", null, publicError);
  }

  private async maybeCallback(
    job: Job,
    status: "done" | "failed",
    resultUrl: string | null,
    error: { code: string; message: string } | null,
  ): Promise<void> {
    if (!job.callbackUrl) return;
    const payload: CallbackPayload = {
      job_id: job.id, status, result_url: resultUrl,
      format: job.format ?? null, size: job.size ?? null, bytes: job.bytes ?? null,
      error, callback_meta: job.callbackMeta ?? null,
      engine: job.engine ?? null, model: job.model ?? null, fallback_reason: null,
    };
    const r = await deliver(job.callbackUrl, job.callbackToken, payload, this.cfg.callbackSigningSecret);
    await this.store.update(job.id, {
      callbackStatus: r.ok ? "delivered" : "failed",
      callbackAttempts: r.attempts,
      lastCallbackAt: new Date().toISOString(),
    });
  }
}
