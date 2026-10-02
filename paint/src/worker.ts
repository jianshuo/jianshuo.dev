import { spawn } from "node:child_process";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "./config.js";
import type { JobStore, Job } from "./store.js";
import type { EventHub } from "./events.js";
import { buildArgs, parseResult, parseEventLine, isModelRejected, isQuotaExhausted, isRateLimited, quotaResetAt } from "./engine.js";
import { seedreamSize, refImageDataUri, seedreamGenerate, finalizeImage } from "./seedream.js";
import { deliver, type CallbackPayload } from "./callback.js";
import { buildXmp, embedXmp } from "./xmp.js";
import { GroupStore } from "./groups.js";

const EXT: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };

// OpenAI 输出端内容过滤会概率性扣下已生成的图（响应正常结束但没有图片项，
// 同一 prompt 重跑大概率就过）——这类错误自动重试一次。
const RETRYABLE = new Set(["missing_image_result"]);
const MAX_ATTEMPTS = 2;
/** 降级 Seedream 至少要留这么多时间，不够就别花这笔钱了，直接 deadline_exceeded */
const MIN_SEEDREAM_MS = 45_000;

type EngineError = { code: string; message: string; detail?: unknown };
type LegResult = { ok: boolean; bytes: number; error?: EngineError };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * 出图的唯一调度点（2026-10-02 统一）：引擎选择、Codex 模型候选、瞬时 429 重试、
 * 额度冷却、Seedream 降级、group 粘性、整单期限——全在这里，调用方只管 POST /api/jobs。
 * 规则见 paint/USAGE.md。
 */
export class Worker {
  private queue: string[] = [];
  private active = 0;
  /** 到这个时刻（ms epoch）前，auto 单不打 codex 直接走 seedream（进程内存，重启即清） */
  codexBlockedUntil = 0;
  codexBlockedReason = "";
  readonly groups: GroupStore;

  constructor(private store: JobStore, private hub: EventHub, private cfg: Config) {
    this.groups = new GroupStore(join(cfg.dataDir, "groups.json"), cfg.groupTtlMs);
  }

  enqueue(id: string): void {
    this.queue.push(id);
    this.pump();
  }

  /** 显式 engine=seedream 能不能接（提交时就校验，免得排队半天再失败） */
  seedreamConfigured(): boolean {
    return !!this.cfg.seedream.apiKey;
  }

  private pump(): void {
    while (this.active < this.cfg.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.active++;
      this.run(id)
        .catch((e) => console.error(`[worker] job ${id} crashed`, e))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private blockCodex(until: number, reason: string): void {
    this.codexBlockedUntil = Math.max(this.codexBlockedUntil, Math.min(until, Date.now() + 7 * 24 * 3600 * 1000));
    this.codexBlockedReason = reason;
  }

  private async run(id: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job || job.status === "done" || job.status === "failed") return;

    // 整单期限从提交时刻算（含排队）：调用方等的就是这么久，超了再画也没人收。
    const deadline = Date.parse(job.createdAt) + this.cfg.jobDeadlineMs;
    const left = () => deadline - Date.now();
    const deadlineError = (where: string): EngineError => ({
      code: "deadline_exceeded",
      message: `job exceeded ${Math.round(this.cfg.jobDeadlineMs / 1000)}s deadline (${where})`,
    });
    if (left() <= 0) {
      if (job.inputPath) await unlink(job.inputPath).catch(() => {});
      await this.fail(job, deadlineError("still queued"), 0);
      return;
    }

    // image_url 输入在这里才真正落地（提交时只校验了 URL）。失败 = job 失败走回调，
    // 提交方（VoiceDrop）的失败分支会把原图写回占位 key，文章不烂。
    if (job.inputUrl && job.inputPath) {
      try {
        await downloadInput(job.inputUrl, job.inputPath, this.cfg.maxInputBytes, Math.min(30000, left()));
      } catch (e: any) {
        await this.fail(job, { code: "input_download_failed", message: e?.message ?? "input download failed" }, 0);
        return;
      }
    }

    await mkdir(this.cfg.resultsDir, { recursive: true });
    const ext = job.params.transparent ? "png" : (EXT[job.params.format] ?? "png");
    const outPath = join(this.cfg.resultsDir, `${id}.${ext}`);

    // 参数合法性先验一次（transparent+edit 这种组合直接拒）；模型留到下面循环里填。
    try {
      buildArgs(job, outPath);
    } catch (e: any) {
      if (job.inputPath) await unlink(job.inputPath).catch(() => {});
      await this.fail(job, { code: "invalid_argument", message: e?.message ?? "bad args" }, 0);
      return;
    }

    await this.store.update(id, { status: "running", startedAt: new Date().toISOString(), percent: 0 });
    this.hub.publish(id, "progress", { percent: 0, phase: "queued" });

    const pref = job.enginePref ?? "auto";
    const sd = this.cfg.seedream;
    // seedream 能不能接：有 key + 不是透明图（方舟没有透明背景）
    const seedreamReady = this.seedreamConfigured() && !job.params.transparent;
    // auto 单能不能自动降级：再加上 SEEDREAM_FALLBACK 开关
    const canFallback = pref === "auto" && sd.enabled && seedreamReady;

    let attempts = 0;
    let ok = false;
    let bytes = 0;
    let error: EngineError | undefined;
    let model = this.cfg.codexModels[0];
    let engine: "codex" | "seedream" = "codex";
    let fallbackReason: string | undefined;

    let runCodex = pref !== "seedream";
    if (runCodex && canFallback) {
      const sticky = await this.groups.get(job.group).catch(() => undefined);
      if (sticky) {
        // 风格一致性：这组已经有图是 seedream 出的，别再混进 codex 画风
        runCodex = false;
        fallbackReason = `group "${job.group}" sticky on seedream since ${sticky.since}`;
      } else if (Date.now() < this.codexBlockedUntil) {
        // 冷却中：刚被真额度/模型全拒打回来过，重置前别再白打一枪 codex
        runCodex = false;
        fallbackReason = `codex cooldown until ${new Date(this.codexBlockedUntil).toISOString()} (${this.codexBlockedReason})`;
      }
    }

    if (runCodex) {
      // 外层按模型候选序列走：账号说「这个模型你用不了」就换下一个，其它错一律不换。
      for (const candidate of this.cfg.codexModels) {
        model = candidate;
        const args = buildArgs(job, outPath, candidate);
        let missTries = 0;
        let rlTries = 0;
        while (true) {
          attempts++;
          ({ ok, bytes, error } = await this.attempt(id, args, outPath, left()));
          if (ok) break;
          if (error?.code === "deadline_exceeded") break;
          if (RETRYABLE.has(error?.code ?? "") && ++missTries < MAX_ATTEMPTS) {
            await this.store.update(id, { percent: 0 });
            this.hub.publish(id, "progress", { percent: 0, phase: "retrying" });
            continue;
          }
          // 瞬时 429（不是真额度）：原地短等再试，不冷却、不连累别的单
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

      if (!ok) {
        // 冷却是关于 codex 本身的事实，不论这单的 pref 都记下（影响的只是之后的 auto 单）
        if (isQuotaExhausted(error)) {
          const until = quotaResetAt(error) ?? Date.now() + this.cfg.quotaCooldownMs;
          this.blockCodex(until, `quota: ${error?.message ?? ""}`);
          if (canFallback) fallbackReason = `codex quota exhausted (cooldown until ${new Date(this.codexBlockedUntil).toISOString()})`;
        } else if (isModelRejected(error)) {
          this.blockCodex(Date.now() + this.cfg.modelRejectedCooldownMs, `all codex models rejected: ${error?.message ?? ""}`);
          if (canFallback) fallbackReason = `codex models all rejected (cooldown until ${new Date(this.codexBlockedUntil).toISOString()})`;
        } else if (isRateLimited(error) && canFallback) {
          // 原地重试用完仍限流：只这一单降级，不设长冷却
          fallbackReason = `codex rate-limited after ${this.cfg.rateLimitRetryMs.length} retries (this job only)`;
        }
        // 参数错、安全拦截（missing_image_result）、401、超时等一律原样失败，绝不降级
      }
    }

    if (!ok && (pref === "seedream" || fallbackReason)) {
      if (!seedreamReady) {
        error = { code: "seedream_unavailable", message: job.params.transparent ? "seedream cannot do transparent output" : "seedream not configured (ARK_API_KEY)" };
      } else if (left() < MIN_SEEDREAM_MS) {
        error = deadlineError(`no time left for seedream after codex: ${error?.message ?? ""}`);
      } else {
        engine = "seedream";
        if (fallbackReason) console.warn(`[worker] job ${id}: 走 seedream —— ${fallbackReason}`);
        const r = await this.runSeedream(id, job, outPath, deadline);
        attempts += r.attempts;
        ({ ok, bytes, error } = r);
        model = r.model;
      }
    }

    // 输入文件要等重试全部结束再清（edit 的第二次尝试 / seedream 降级还要用它）
    if (job.inputPath) await unlink(job.inputPath).catch(() => {});

    if (!ok) {
      await this.store.update(id, { model, engine, fallbackReason });   // 失败也留痕：栽在哪个引擎/模型上
      await this.fail(job, error ?? { code: "unknown", message: "generation failed" }, attempts);
      return;
    }

    // 组里有一张走了 seedream：整组粘到 seedream（落盘，重启不丢）
    if (engine === "seedream" && job.group) {
      await this.groups.stick(job.group).catch((e) => console.error(`[worker] group stick failed`, e));
    }

    // 出图后、回调前：嵌 XMP 溯源。失败绝不连累任务（spec §4）。
    try {
      const xmp = buildXmp({
        prompt: job.xmpPrompt === false ? undefined : job.prompt,
        jobId: id,
        model: engine === "seedream" ? model : "gpt-image-2",
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
      status: "done", percent: 100, doneAt: new Date().toISOString(), attempts,
      resultPath: outPath, format: ext === "jpg" ? "jpeg" : ext, bytes,
      size: job.params.size, model, engine, fallbackReason,
    });
    const resultUrl = `${this.cfg.publicBaseUrl}/results/${id}.${ext}`;
    this.hub.publish(id, "done", { result_url: resultUrl, bytes, format: done.format, size: done.size, engine, model });
    await this.maybeCallback(done, "done", resultUrl, null);
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

  /** 跑一次 CLI：spawn → 进度转发 → 解析结果 → 校验产物文件。超过 timeoutMs 杀掉 = deadline_exceeded */
  private async attempt(id: string, args: string[], outPath: string, timeoutMs: number): Promise<LegResult> {
    if (timeoutMs <= 0) return { ok: false, bytes: 0, error: { code: "deadline_exceeded", message: "job deadline reached before codex attempt" } };
    const env = { ...process.env };
    if (this.cfg.codexHome) env.CODEX_HOME = this.cfg.codexHome;

    const child = spawn(this.cfg.gptImageBin, args, { env });
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

  private async fail(job: Job, error: EngineError, attempts: number): Promise<void> {
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
      engine: job.engine ?? null, model: job.model ?? null, fallback_reason: job.fallbackReason ?? null,
    };
    const r = await deliver(job.callbackUrl, job.callbackToken, payload, this.cfg.callbackSigningSecret);
    await this.store.update(job.id, {
      callbackStatus: r.ok ? "delivered" : "failed",
      callbackAttempts: r.attempts,
      lastCallbackAt: new Date().toISOString(),
    });
  }
}
