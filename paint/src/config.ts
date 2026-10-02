import { join } from "node:path";

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  dataDir: string;
  jobsDir: string;
  resultsDir: string;
  inputsDir: string;
  apiToken: string;
  callbackSigningSecret: string;
  maxConcurrency: number;
  retentionDays: number;
  gptImageBin: string;
  codexHome?: string;
  /**
   * Codex 外层模型的候选序列，按顺序试，前一个被账号拒了就换下一个。
   * CLI 自带的默认会随 CLI 升级和账号权限两头漂（v0.7.1 是 gpt-5.4，
   * codex-cli 0.142.5 已升到 gpt-5.5，而 5.5 这个账号根本没有）——2026-09-06 全线
   * 出图失败就是这么来的：`HTTP 400 The 'gpt-5.4' model is not supported when
   * using Codex with a ChatGPT account`，而 systemctl 照样 active、journalctl
   * 一声不吭（错误只落进 data/jobs/<id>.json）。所以模型必须自己钉死 + 留后路。
   * 出图的其实是 image_generation 工具委托的 gpt-image-2，外层模型只管调工具。
   */
  codexModels: string[];
  maxInputBytes: number;
  maxPromptChars: number;
  /**
   * Codex 额度打满（429 usage_limit_reached）时的自动降级：火山方舟 Seedream。
   * 2026-10-02 起。enabled=false 或没配 apiKey 就不降级（原样失败）。
   */
  seedream: SeedreamConfig;
  /** ImageMagick `convert`：Seedream 出图后裁/缩到调用方要的尺寸 + 转格式 */
  convertBin: string;
}

export interface SeedreamConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  /** 按顺序试，前一个失败换下一个（env SEEDREAM_MODELS 逗号分隔） */
  models: string[];
  /** 方舟要求 宽×高 ≥ 921,600（2026-10-02 实测 5.0 pro / 4.0 同一个下限） */
  minPixels: number;
  maxPixels: number;
  timeoutMs: number;
}

/**
 * 2026-10-02 实测账号已开通：5.0 pro ✅、4.0 ✅；4.5 / 5.0-flash ❌ 404 ModelNotOpen。
 * 5.0 pro 不收 sequential_image_generation（400），别传。
 */
const DEFAULT_SEEDREAM_MODELS = ["doubao-seedream-5-0-pro-260628", "doubao-seedream-4-0-20260415"];

/**
 * 候选序列。账号能开哪些模型**会变**，所以这里记的是「最后一次实测」而非定论：
 *   2026-09-06  gpt-5.4 被拒（400），当时只有 gpt-5.4-mini 能用 → 才有了这个序列
 *   2026-09-07  逐个复测：gpt-5.4-mini ✅ / gpt-5.4 ✅（已恢复）/ gpt-5.5 ❌ 404
 *               / gpt-5.6、-mini、-codex ❌ 400（CLI 连元数据都没有）
 * 所以两条候选目前都活着；上限是 gpt-5.4。真要探只能逐个 `-m` 真跑一次——
 * `models list` 只列本地预设，不反映账号真实可用集。
 */
const DEFAULT_CODEX_MODELS = ["gpt-5.4-mini", "gpt-5.4"];

function parseModels(raw: string | undefined, fallback: string[] = DEFAULT_CODEX_MODELS): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.API_TOKEN;
  const callbackSigningSecret = env.CALLBACK_SIGNING_SECRET;
  if (!apiToken) throw new Error("Missing required env API_TOKEN");
  if (!callbackSigningSecret) throw new Error("Missing required env CALLBACK_SIGNING_SECRET");
  const dataDir = env.DATA_DIR ?? "/opt/paint/data";
  return {
    port: Number(env.PORT ?? 8788),
    host: env.HOST ?? "127.0.0.1",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "https://paint.jianshuo.dev").replace(/\/$/, ""),
    dataDir,
    jobsDir: join(dataDir, "jobs"),
    resultsDir: join(dataDir, "results"),
    inputsDir: join(dataDir, "inputs"),
    apiToken,
    callbackSigningSecret,
    maxConcurrency: Number(env.MAX_CONCURRENCY ?? 3),
    retentionDays: Number(env.RETENTION_DAYS ?? 30),
    gptImageBin: env.GPT_IMAGE_BIN ?? "gpt-image-2-skill",
    codexHome: env.CODEX_HOME,
    codexModels: parseModels(env.CODEX_MODELS),
    maxInputBytes: Number(env.MAX_INPUT_BYTES ?? 26214400),
    maxPromptChars: Number(env.MAX_PROMPT_CHARS ?? 4000),
    seedream: {
      enabled: !/^(0|false|off|no)$/i.test(env.SEEDREAM_FALLBACK ?? "on"),
      apiKey: env.ARK_API_KEY || undefined,
      baseUrl: (env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""),
      models: parseModels(env.SEEDREAM_MODELS, DEFAULT_SEEDREAM_MODELS),
      minPixels: Number(env.SEEDREAM_MIN_PIXELS ?? 921600),
      maxPixels: Number(env.SEEDREAM_MAX_PIXELS ?? 4096 * 4096),
      timeoutMs: Number(env.SEEDREAM_TIMEOUT_MS ?? 300000),
    },
    convertBin: env.CONVERT_BIN ?? "convert",
  };
}
