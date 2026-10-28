import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobStore, type Job } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { loadConfig } from "../src/config.ts";
import { isQuotaExhausted, isRateLimited, isModelRejected } from "../src/engine.ts";
import { seedreamSize } from "../src/seedream.ts";
import { fakeRouter } from "./fake-router.ts";

// ── 火山方舟 Seedream（2026-10-02 接入）────────────────────────────────────────
// 2026-10-28 起 paint 不再自己降级：用 codex 还是 seedream 由 engine-router 按批次定，一批不换。

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");
const FAKE_CONVERT = resolve("test/fixtures/fake-convert.mjs");
const QUOTA_ERR = {
  code: "http_error",
  message: "HTTP 429",
  detail: '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1790915206,"limit_window_minutes":300,"resets_in_seconds":8295}}',
};

test("isQuotaExhausted：只认真额度（usage_limit_reached / 带重置时刻），泛泛 429 是瞬时限流", () => {
  assert.equal(isQuotaExhausted(QUOTA_ERR), true);
  assert.equal(isQuotaExhausted({ code: "http_error", message: "HTTP 429", detail: '{"error":{"resets_in_seconds":60}}' }), true);
  const transient = { code: "http_error", message: "HTTP 429", detail: "Too Many Requests" };
  assert.equal(isQuotaExhausted(transient), false);
  assert.equal(isRateLimited(transient), true);
  assert.equal(isRateLimited({ code: "http_error", message: "rate_limit_exceeded" }), true);
  assert.equal(isRateLimited(QUOTA_ERR), false); // 真额度不归瞬时限流管
  assert.equal(isRateLimited({ code: "http_error", message: "HTTP 400" }), false);
});

test("isQuotaExhausted：参数错 / 模型被拒 / 安全拦截 / 401 一律不算额度问题", () => {
  assert.equal(isQuotaExhausted({ code: "invalid_argument", message: "transparent output is not supported for edit (transparent+edit)" }), false);
  assert.equal(isQuotaExhausted({ code: "missing_image_result", message: "The response did not include an image_generation_call result." }), false);
  assert.equal(isQuotaExhausted({ code: "http_error", message: "HTTP 401", detail: '{"error":{"code":"refresh_token_invalidated"}}' }), false);
  assert.equal(isQuotaExhausted({ code: "http_error", message: "HTTP 400", detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account." }), false);
  assert.equal(isQuotaExhausted(undefined), false);
  // 反过来：额度错也别被当成模型被拒（那会白白换模型再打一枪）
  assert.equal(isModelRejected(QUOTA_ERR), false);
});

test("seedreamSize：够下限原样、不够等比放大、关键字给 2K/4K 不裁", () => {
  assert.deepEqual(seedreamSize("1024x1536", 921600, 16777216), { request: "1024x1536", target: { w: 1024, h: 1536 } });
  const s = seedreamSize("768x1024", 921600, 16777216);
  const [w, h] = s.request.split("x").map(Number);
  assert.ok(w * h >= 921600);
  assert.ok(Math.abs(w / h - 768 / 1024) < 0.01);
  assert.deepEqual(s.target, { w: 768, h: 1024 });
  assert.deepEqual(seedreamSize("2K", 921600, 16777216), { request: "2K" });
  assert.deepEqual(seedreamSize("4k", 921600, 16777216), { request: "4K" });
  assert.deepEqual(seedreamSize("auto", 921600, 16777216), { request: "2K" });
  const big = seedreamSize("8192x8192", 921600, 16777216);
  const [bw, bh] = big.request.split("x").map(Number);
  assert.ok(bw * bh <= 16777216);
});

/** 本地假方舟：/images/generations 回自己的 /img/1 URL；model 以 "bad" 开头回 400 */
async function fakeArk(t: any) {
  const calls: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url === "/api/v3/images/generations") {
        const body = JSON.parse(b);
        calls.push({ auth: req.headers.authorization, body });
        if (String(body.model).startsWith("bad")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "InvalidParameter", message: "stub bad", type: "BadRequest" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${(srv.address() as any).port}/img/1` }] }));
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from([0xff, 0xd8, 0x41]));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  t.after(() => srv.close());
  return { calls, baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/api/v3` };
}

async function setup(env: Record<string, string> = {}, engine: "gpt-image" | "seedream" = "seedream") {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-seedream-"));
  const cfg = loadConfig({
    API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE,
    CONVERT_BIN: FAKE_CONVERT, CLAIM_INTERVAL_MS: "20", ...env,
  } as any);
  const store = new JobStore(cfg.jobsDir);
  const fr = fakeRouter({ engine: () => engine });
  const worker = new Worker(store, new EventHub(), cfg, fr.router);
  await worker.start();
  const run = async (j: Job) => {
    await store.create(j);
    await worker.submitSingle(j);
    return settle(store, j.id);
  };
  return { cfg, store, worker, fr, run };
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "a cat",
    params: { size: "1024x1536", format: "jpeg", quality: "high", compression: 80, transparent: false },
    percent: 0, error: null, createdAt: new Date().toISOString(), ...over,
  };
}

async function settle(store: JobStore, id: string, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = await store.get(id);
    if (j?.status === "done" || j?.status === "failed") return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}

test("router 派 seedream：直接方舟出图，记 engine/model，XMP 写方舟模型名，codex 一次不跑", async (t) => {
  const ark = await fakeArk(t);
  const { cfg, run } = await setup({ ARK_API_KEY: "ark-key", ARK_BASE_URL: ark.baseUrl });
  const j = await run(job("q1"));
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.model, "doubao-seedream-5-0-pro-260628");
  assert.equal(j?.attempts, 1);
  // 发给方舟的：显式 WxH、不带 sequential_image_generation、不加水印
  assert.equal(ark.calls[0].auth, "Bearer ark-key");
  assert.equal(ark.calls[0].body.size, "1024x1536");
  assert.equal(ark.calls[0].body.watermark, false);
  assert.equal("sequential_image_generation" in ark.calls[0].body, false);
  // 裁缩到原尺寸 + jpeg q80
  const out = join(cfg.resultsDir, "q1.jpg");
  const args = JSON.parse(await readFile(out + ".args.json", "utf8"));
  assert.ok(args.includes("1024x1536^"));
  assert.equal(args[args.indexOf("-quality") + 1], "80");
  assert.ok(args[args.length - 1].startsWith("jpg:"));
  const buf = await readFile(out);
  assert.ok(buf.includes(Buffer.from('paint:Model="doubao-seedream-5-0-pro-260628"')));
});

test("router 派 codex、codex 撞额度：不降级 seedream，原文回报 router（由它冷却 / 暂停整批）", async (t) => {
  const ark = await fakeArk(t);
  const { run, fr } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl }, "gpt-image");
  const j = await run(job("n1", { prompt: "QUOTA a cat" }));
  assert.equal(j?.status, "failed");
  assert.equal(j?.engine, "codex");
  assert.equal(ark.calls.length, 0);
  assert.match(fr.completed[0].error ?? "", /usage_limit_reached/);
});

test("瞬时 429（非额度）：原地短等重试成功", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, RATE_LIMIT_RETRY_MS: "10,10" }, "gpt-image");
  const j = await run(job("rl1", { prompt: "RATELIMIT_ONCE a cat" }));
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "codex");
  assert.equal(j?.attempts, 2);
  assert.equal(ark.calls.length, 0);
});

test("瞬时 429 重试用完：这张失败，回报 router，不碰方舟", async (t) => {
  const ark = await fakeArk(t);
  const { run, fr } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, RATE_LIMIT_RETRY_MS: "10,10" }, "gpt-image");
  const j = await run(job("rl2", { prompt: "RATELIMIT a cat" }));
  assert.equal(j?.status, "failed");
  assert.equal(j?.attempts, 3); // codex 1 + 2 次原地重试
  assert.equal(ark.calls.length, 0);
  assert.match(fr.completed[0].error ?? "", /429/);
});

test("seedream 出图后处理（convert）失败：postprocess_error，不再换模型二次付费", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, SEEDREAM_MODELS: "sd-a,sd-b" });
  const j = await run(job("convfail1"));
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "postprocess_error");
  assert.equal(ark.calls.length, 1); // 只调了一次方舟
  assert.equal(j?.model, "sd-a");
});

test("回调带 engine / model；fallback_reason 恒为 null（不再降级）", async (t) => {
  const ark = await fakeArk(t);
  const received: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push(JSON.parse(b)); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  t.after(() => srv.close());
  const cb = `http://127.0.0.1:${(srv.address() as any).port}/cb`;
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await run(job("cb1", { callbackUrl: cb }));
  for (let i = 0; i < 100 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(received[0].engine, "seedream");
  assert.equal(received[0].model, "doubao-seedream-5-0-pro-260628");
  assert.equal(received[0].fallback_reason, null);
});

test("执行期限：codex 卡住被杀 → deadline_exceeded", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, JOB_DEADLINE_MS: "800" }, "gpt-image");
  const j = await run(job("dl1", { prompt: "SLOW a cat" }));
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "deadline_exceeded");
  assert.equal(ark.calls.length, 0);
});

test("执行期限从开画算：在 router 排队排了很久的单照样画", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, JOB_DEADLINE_MS: "60000" }, "gpt-image");
  const j = await run(job("dl2", { createdAt: new Date(Date.now() - 3600_000).toISOString() }));
  assert.equal(j?.status, "done");
});

test("seedream 第一个模型失败 → 换下一个", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, SEEDREAM_MODELS: "bad-sd,good-sd" });
  const j = await run(job("s1"));
  assert.equal(j?.status, "done");
  assert.equal(j?.model, "good-sd");
  assert.deepEqual(ark.calls.map((c) => c.body.model), ["bad-sd", "good-sd"]);
});

test("seedream 全失败 → failed，错误是 seedream_error，引擎留痕", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, SEEDREAM_MODELS: "bad-1,bad-2" });
  const j = await run(job("s2"));
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "seedream_error");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.model, "bad-2");
});

test("seedream 改图：参考图以 data URI 发出；小尺寸放大后再裁回；输入文件清掉", async (t) => {
  const ark = await fakeArk(t);
  const { cfg, run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await mkdir(cfg.inputsDir, { recursive: true });
  const inputPath = join(cfg.inputsDir, "e1.img");
  await writeFile(inputPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const j = await run(job("e1", {
    prompt: "a dog", mode: "edit", inputPath,
    params: { size: "768x1024", format: "png", quality: "high", transparent: false },
  }));
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.attempts, 1);
  assert.match(ark.calls[0].body.image, /^data:image\/png;base64,/);
  const [w, h] = ark.calls[0].body.size.split("x").map(Number);
  assert.ok(w * h >= 921600);
  const args = JSON.parse(await readFile(join(cfg.resultsDir, "e1.png.args.json"), "utf8"));
  assert.ok(args.includes("768x1024^"));
  assert.ok(!args.includes("-quality")); // png 不传质量
  await assert.rejects(readFile(inputPath)); // 输入文件照样清掉
});

test("透明图派给 seedream（router 不该这么派）→ 失败，不调方舟", async (t) => {
  const ark = await fakeArk(t);
  const { run } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  const j = await run(job("tp", { params: { size: "1024x1024", format: "png", quality: "high", transparent: true } }));
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "seedream_unavailable");
  assert.equal(ark.calls.length, 0);
});

test("一批里每张都用 router 定的同一个引擎", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker, fr } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  const jobs = ["b1", "b2", "b3"].map((id) => job(id, { group: "book-q", key: `/w/${id}.jpg` }));
  for (const j of jobs) await store.create(j);
  await worker.submitBatch(jobs, { group: "book-q", label: "《测试》", priority: "batch" });
  for (const j of jobs) assert.equal((await settle(store, j.id))?.engine, "seedream");
  assert.equal(fr.batches.length, 1);
  assert.deepEqual(fr.batches[0].items.map((i) => i.key), ["/w/b1.jpg", "/w/b2.jpg", "/w/b3.jpg"]);
  assert.equal(ark.calls.length, 3);
});
