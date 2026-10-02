import type { Job } from "./store.js";

/**
 * 「这个模型你的账号用不了」——换模型重试的判据，别的错一律不换（换了也是白换）。
 * 上游有两种长相（措辞和状态码都不同，两种都要认）：
 *   {code:"http_error", message:"HTTP 400", detail:'{"detail":"The \'gpt-5.6\' model is
 *     not supported when using Codex with a ChatGPT account."}'}
 *   {code:"http_error", message:"HTTP 404", detail:"The model `gpt-5.5` does not exist
 *     or you do not have access to it."}
 */
const MODEL_REJECTED: RegExp[] = [
  /model.{0,40}is not supported/i,
  /model.{0,40}does not exist/i,
  /do not have access to it/i,
  /model[ _-]?not[ _-]?found/i,
];

export function isModelRejected(error?: { code?: string; message?: string; detail?: unknown }): boolean {
  if (!error) return false;
  const blob = errorBlob(error);
  // 「模型被账号拒」有两种措辞、两种状态码（2026-09-07 在 VPS 上逐个实测）：
  //   400  The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.
  //   404  The model `gpt-5.5` does not exist or you do not have access to it.
  // 只认前一种会漏掉一半——lab 的写书三腿链正是漏了 404 这条，2026-09-07
  // 一天 5 单整单失败退款（同款判据见 claude-agent/src/book-legs.ts）。
  // 全部限定在 model 一词附近：engine 自己就会抛 "transparent output is not
  // supported for edit"，泛泛的 /is not supported/ 会把它误判成模型问题，
  // 于是拿下一个模型再跑一遍必然的失败。单测钉了这条边界。
  return MODEL_REJECTED.some((re) => re.test(blob));
}

function errorBlob(error: { message?: string; detail?: unknown }): string {
  return `${error.message ?? ""} ${typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail ?? "")}`;
}

/**
 * 「Codex 额度打满了」——自动降级到 Seedream 的判据（2026-10-02）。长相：
 *   {code:"http_error", message:"HTTP 429", detail:'{"error":{"type":"usage_limit_reached",
 *     "message":"The usage limit has been reached","plan_type":"plus","resets_at":1790915206,
 *     "limit_window_minutes":300,"resets_in_seconds":8295}}'}
 * 只认「真额度」：usage_limit_reached 字样，或响应里带了重置时刻（resets_at / resets_in_seconds）。
 * 泛泛的 HTTP 429 / too many requests 是瞬时限流（见 isRateLimited），不能据此长冷却——
 * 那会让后面一串单白白走 Seedream 花钱（2026-10-02 评审）。
 * 调用方参数错（invalid_argument / transparent+edit 等）绝不降级。
 */
const QUOTA_EXHAUSTED: RegExp[] = [
  /usage_limit_reached/i,
  /usage limit has been reached/i,
  /"resets_(at|in_seconds)"\s*:/i,
];

export function isQuotaExhausted(error?: { code?: string; message?: string; detail?: unknown }): boolean {
  if (!error) return false;
  const blob = errorBlob(error).replace(/\\"/g, '"');
  return QUOTA_EXHAUSTED.some((re) => re.test(blob));
}

/** 瞬时限流：429 / too many requests / rate limit，但不是真额度。原地短等重试，不进长冷却。 */
const RATE_LIMITED: RegExp[] = [/\bHTTP 429\b/, /too many requests/i, /rate[_ ]limit/i];

export function isRateLimited(error?: { code?: string; message?: string; detail?: unknown }): boolean {
  if (!error || isQuotaExhausted(error)) return false;
  return RATE_LIMITED.some((re) => re.test(errorBlob(error)));
}

/** 额度错误里带的重置时刻（ms epoch）；拿不到返回 undefined */
export function quotaResetAt(error: { message?: string; detail?: unknown } | undefined, now = Date.now()): number | undefined {
  if (!error) return undefined;
  const blob = errorBlob(error).replace(/\\"/g, '"');
  const secs = blob.match(/"resets_in_seconds"\s*:\s*(\d+)/);
  if (secs) return now + Number(secs[1]) * 1000;
  const at = blob.match(/"resets_at"\s*:\s*(\d+)/);
  if (at) return Number(at[1]) * 1000;
  return undefined;
}

export function buildArgs(job: Job, outPath: string, model?: string): string[] {
  const { prompt, mode, params } = job;
  // `--provider` is a GLOBAL option and must precede the subcommand (verified against
  // gpt-image-2-skill v0.7.1 `--help`): the `images generate|edit` / `transparent generate`
  // subcommands reject `--provider` if it appears after them.
  const globals = ["--json", "--json-events", "--provider", "codex"];
  // `-m` 是子命令选项（generate/edit/transparent generate 三个都收），跟 --provider
  // 那个全局选项不是一回事，位置别搞反。不给就吃 CLI 的默认——那正是会漂的东西。
  const common = ["--prompt", prompt, "--out", outPath, ...(model ? ["-m", model] : [])];
  const sizeQuality = ["--size", params.size, "--quality", params.quality];

  if (params.transparent) {
    if (mode === "edit") {
      throw new Error("transparent output is not supported for edit (transparent+edit)");
    }
    return [...globals, "transparent", "generate", ...common, ...sizeQuality];
  }

  const fmt = ["--format", params.format];
  const comp = params.compression != null ? ["--compression", String(params.compression)] : [];

  if (mode === "edit") {
    if (!job.inputPath) throw new Error("edit mode requires inputPath");
    return [...globals, "images", "edit", ...common, "--ref-image", job.inputPath, ...fmt, ...sizeQuality, ...comp];
  }
  return [...globals, "images", "generate", ...common, ...fmt, ...sizeQuality, ...comp];
}

export function parseResult(stdout: string): { ok: boolean; error?: { code: string; message: string; detail?: unknown } } {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return { ok: false, error: { code: "parse_error", message: "no JSON on stdout" } };
  try {
    const obj = JSON.parse(stdout.slice(start, end + 1));
    if (obj?.ok === true) return { ok: true };
    return { ok: false, error: obj?.error ?? { code: "unknown", message: "engine reported failure" } };
  } catch {
    return { ok: false, error: { code: "parse_error", message: "stdout not valid JSON" } };
  }
}

export function parseEventLine(line: string): { percent?: number; phase?: string } | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const ev = JSON.parse(t);
    if (ev?.kind === "sse") return null;
    const out: { percent?: number; phase?: string } = {};
    if (typeof ev?.data?.percent === "number") out.percent = ev.data.percent;
    if (typeof ev?.data?.phase === "string") out.phase = ev.data.phase;
    else if (typeof ev?.type === "string") out.phase = ev.type;
    if (out.percent === undefined && out.phase === undefined) return null;
    return out;
  } catch {
    return null;
  }
}
