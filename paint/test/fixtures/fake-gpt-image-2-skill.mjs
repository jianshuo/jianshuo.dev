#!/usr/bin/env node
// 打桩版 gpt-image-2-skill：不联网。--out 写个假文件，stderr 吐 JSONL 进度，
// stdout 吐 --json 信封。prompt 含 "FAIL" 则返回错误信封 + 退出码 1。
// prompt 含 "FLAKY"：第一次调用报 missing_image_result，第二次成功（用 out 旁的
// marker 文件记次数）。prompt 含 "ALWAYSMISSING"：每次都报 missing_image_result。
// prompt 含 "REALPNG"：写一张真实 1×1 PNG（测 XMP 嵌入用）。
// prompt 含 "QUOTA"：429 usage_limit_reached（测 seedream 降级）。
import { writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const promptIdx = args.indexOf("--prompt");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
const modelIdx = args.indexOf("-m");
const model = modelIdx >= 0 ? args[modelIdx + 1] : null;

// 模型名以 "badmodel" 开头 → 复刻账号拒绝那一幕（2026-09-06 的 gpt-5.4 400）。
if (model && model.startsWith("badmodel")) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: "http_error",
      message: "HTTP 400",
      detail: `{"detail":"The '${model}' model is not supported when using Codex with a ChatGPT account."}`,
    },
  }));
  process.exit(1);
}

process.stderr.write(JSON.stringify({ data: { percent: 0, phase: "request_started" }, kind: "progress", type: "request_started" }) + "\n");
process.stderr.write(JSON.stringify({ kind: "sse", type: "keepalive", data: {} }) + "\n");
process.stderr.write(JSON.stringify({ data: { percent: 95, phase: "request_completed" }, kind: "progress", type: "request_completed" }) + "\n");

// prompt 含 "QUOTA" → 复刻 2026-10-02 那一幕：Plus 额度打满，429 usage_limit_reached。
if (prompt.includes("QUOTA")) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: "http_error",
      message: "HTTP 429",
      detail: '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1790915206,"limit_window_minutes":300,"resets_in_seconds":8295}}',
    },
  }));
  process.exit(1);
}

// prompt 含 "RATELIMIT"：泛泛的 HTTP 429（不带 usage_limit_reached / resets_*）= 瞬时限流。
// "RATELIMIT_ONCE"：第一次 429，第二次成功（out 旁 marker 记次数）。
if (prompt.includes("RATELIMIT")) {
  const marker = out + ".rl-marker";
  if (!prompt.includes("RATELIMIT_ONCE") || !existsSync(marker)) {
    writeFileSync(marker, "1");
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "http_error", message: "HTTP 429", detail: "Too Many Requests" } }));
    process.exit(1);
  }
}

// prompt 含 "SLOW"：卡 3 秒（测整单期限会把它杀掉）
if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 3000));

if (prompt.includes("FAIL")) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "http_error", message: "stub failure" } }));
  process.exit(1);
}

const missing = {
  ok: false,
  error: {
    code: "missing_image_result",
    message: "The response did not include an image_generation_call result.",
    detail: { response_id: "resp_stub", output_text: "stub refusal text" },
  },
};

if (prompt.includes("ALWAYSMISSING")) {
  process.stdout.write(JSON.stringify(missing));
  process.exit(1);
}

if (prompt.includes("FLAKY")) {
  const marker = out + ".flaky-marker";
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    process.stdout.write(JSON.stringify(missing));
    process.exit(1);
  }
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
if (out) writeFileSync(out, prompt.includes("REALPNG") ? TINY_PNG : "FAKEPNGDATA");
process.stderr.write(JSON.stringify({ data: { percent: 100, phase: "output_saved" }, kind: "progress", type: "output_saved" }) + "\n");
process.stdout.write(JSON.stringify({ ok: true, output: { path: out, bytes: 11 } }));
process.exit(0);
