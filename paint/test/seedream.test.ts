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
import { isQuotaExhausted, isRateLimited, quotaResetAt, isModelRejected } from "../src/engine.ts";
import { seedreamSize } from "../src/seedream.ts";

// ── Codex 额度打满 → 自动降级火山方舟 Seedream（2026-10-02）─────────────────
// 那天 Plus 的 5h 窗口被打满，paint 每一单都 429 usage_limit_reached，全线出不了图。

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

test("quotaResetAt：优先 resets_in_seconds，其次 resets_at", () => {
  assert.equal(quotaResetAt(QUOTA_ERR, 1000), 1000 + 8295 * 1000);
  assert.equal(quotaResetAt({ message: "HTTP 429", detail: '{"error":{"resets_at":1790915206}}' }), 1790915206 * 1000);
  assert.equal(quotaResetAt({ message: "HTTP 429" }), undefined);
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

async function setup(env: Record<string, string> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-seedream-"));
  const cfg = loadConfig({
    API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE,
    CONVERT_BIN: FAKE_CONVERT, ...env,
  } as any);
  const store = new JobStore(cfg.jobsDir);
  const worker = new Worker(store, new EventHub(), cfg);
  return { cfg, store, worker };
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "QUOTA a cat",
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

test("codex 429 额度满 → 降级 seedream 出图，记 engine/model/原因，XMP 写方舟模型名", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker, cfg } = await setup({ ARK_API_KEY: "ark-key", ARK_BASE_URL: ark.baseUrl });
  await store.create(job("q1"));
  worker.enqueue("q1");
  const j = await settle(store, "q1");
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.model, "doubao-seedream-5-0-pro-260628");
  assert.match(j?.fallbackReason ?? "", /codex quota/);
  assert.equal(j?.attempts, 2); // codex 1 次 + seedream 1 次
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

test("额度冷却：下一单不再打 codex，直接 seedream", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await store.create(job("c1"));
  worker.enqueue("c1");
  await settle(store, "c1");
  assert.ok(worker.codexBlockedUntil > Date.now());
  await store.create(job("c2", { prompt: "a dog" })); // 不含 QUOTA：若真打了 codex 会直接成功、engine=codex
  worker.enqueue("c2");
  const j = await settle(store, "c2");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.attempts, 1);
  assert.match(j?.fallbackReason ?? "", /cooldown/);
});

test("没配 ARK key / SEEDREAM_FALLBACK=off → 额度满照旧失败", async (t) => {
  for (const env of [{}, { ARK_API_KEY: "k", SEEDREAM_FALLBACK: "off" }]) {
    const ark = await fakeArk(t);
    const { store, worker } = await setup({ ARK_BASE_URL: ark.baseUrl, ...env });
    await store.create(job("n1"));
    worker.enqueue("n1");
    const j = await settle(store, "n1");
    assert.equal(j?.status, "failed");
    assert.equal(j?.error?.code, "http_error");
    assert.equal(ark.calls.length, 0);
  }
});

test("非额度错误（普通 http_error）不降级", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await store.create(job("p1", { prompt: "please FAIL" }));
  worker.enqueue("p1");
  const j = await settle(store, "p1");
  assert.equal(j?.status, "failed");
  assert.equal(j?.engine, "codex");
  assert.equal(ark.calls.length, 0);
});

test("codex 候选模型全被账号拒 → 也降级 seedream", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, CODEX_MODELS: "badmodel-a,badmodel-b" });
  await store.create(job("r1", { prompt: "a cat" }));
  worker.enqueue("r1");
  const j = await settle(store, "r1");
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "seedream");
  assert.match(j?.fallbackReason ?? "", /rejected/);
  // 模型全拒也要冷却（2026-10-02 评审）：否则每单都先白打两枪被拒再降级
  assert.ok(worker.codexBlockedUntil > Date.now() + 20 * 60 * 1000);
  await store.create(job("r2", { prompt: "a dog" }));
  worker.enqueue("r2");
  const j2 = await settle(store, "r2");
  assert.equal(j2?.engine, "seedream");
  assert.equal(j2?.attempts, 1); // 冷却中不再打 codex
  assert.match(j2?.fallbackReason ?? "", /cooldown.*rejected/);
});

test("瞬时 429（非额度）：原地短等重试成功，不冷却、不降级", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, RATE_LIMIT_RETRY_MS: "10,10" });
  await store.create(job("rl1", { prompt: "RATELIMIT_ONCE a cat" }));
  worker.enqueue("rl1");
  const j = await settle(store, "rl1");
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "codex");
  assert.equal(j?.attempts, 2);
  assert.equal(worker.codexBlockedUntil, 0);
  assert.equal(ark.calls.length, 0);
});

test("瞬时 429 重试用完：只这一单降级 seedream，不设长冷却", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, RATE_LIMIT_RETRY_MS: "10,10" });
  await store.create(job("rl2", { prompt: "RATELIMIT a cat" }));
  worker.enqueue("rl2");
  const j = await settle(store, "rl2");
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.attempts, 4); // codex 1 + 2 次原地重试 + seedream 1
  assert.match(j?.fallbackReason ?? "", /rate-limited.*this job only/);
  assert.equal(worker.codexBlockedUntil, 0);
  // 下一单照常先打 codex
  await store.create(job("rl3", { prompt: "a dog" }));
  worker.enqueue("rl3");
  assert.equal((await settle(store, "rl3"))?.engine, "codex");
});

test("engine=codex 显式：瞬时 429 用完也不降级", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, RATE_LIMIT_RETRY_MS: "10" });
  await store.create(job("rl4", { prompt: "RATELIMIT a cat", enginePref: "codex" }));
  worker.enqueue("rl4");
  const j = await settle(store, "rl4");
  assert.equal(j?.status, "failed");
  assert.equal(ark.calls.length, 0);
});

test("seedream 出图后处理（convert）失败：postprocess_error，不再换模型二次付费", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, SEEDREAM_MODELS: "sd-a,sd-b" });
  await store.create(job("convfail1", { prompt: "a cat", enginePref: "seedream" }));
  worker.enqueue("convfail1");
  const j = await settle(store, "convfail1");
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "postprocess_error");
  assert.equal(ark.calls.length, 1); // 只调了一次方舟
  assert.equal(j?.model, "sd-a");
});

test("group 粘性：组里一张走了 seedream，后续 auto 单直走 seedream；落盘，重启（新 Worker）后仍生效", async (t) => {
  const ark = await fakeArk(t);
  const env = { ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl };
  const { store, worker, cfg } = await setup(env);
  await store.create(job("g1", { prompt: "a cat", enginePref: "seedream", group: "book-x" }));
  worker.enqueue("g1");
  assert.equal((await settle(store, "g1"))?.engine, "seedream");
  const saved = JSON.parse(await readFile(join(cfg.dataDir, "groups.json"), "utf8"));
  assert.equal(saved["book-x"].engine, "seedream");

  // 新 Worker = 模拟重启（进程内冷却清零，但 group 粘性在盘上）
  const worker2 = new Worker(store, new EventHub(), cfg);
  await store.create(job("g2", { prompt: "a dog", group: "book-x" }));
  worker2.enqueue("g2");
  const j2 = await settle(store, "g2");
  assert.equal(j2?.engine, "seedream");
  assert.equal(j2?.attempts, 1);
  assert.match(j2?.fallbackReason ?? "", /group "book-x" sticky/);

  // 别的组 / 不带组：照常 codex；显式 engine=codex 不受粘性影响
  await store.create(job("g3", { prompt: "a dog", group: "book-y" }));
  worker2.enqueue("g3");
  assert.equal((await settle(store, "g3"))?.engine, "codex");
  await store.create(job("g4", { prompt: "a dog", group: "book-x", enginePref: "codex" }));
  worker2.enqueue("g4");
  assert.equal((await settle(store, "g4"))?.engine, "codex");
});

test("回调带 engine / model / fallback_reason", async (t) => {
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
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await store.create(job("cb1", { callbackUrl: cb })); // QUOTA → 降级
  worker.enqueue("cb1");
  await settle(store, "cb1");
  await store.create(job("cb2", { prompt: "a dog", callbackUrl: cb, enginePref: "codex" }));
  worker.enqueue("cb2");
  await settle(store, "cb2");
  for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  const a = received.find((r) => r.job_id === "cb1");
  assert.equal(a.engine, "seedream");
  assert.equal(a.model, "doubao-seedream-5-0-pro-260628");
  assert.match(a.fallback_reason, /quota/);
  const b = received.find((r) => r.job_id === "cb2");
  assert.equal(b.engine, "codex");
  assert.equal(b.model, "gpt-5.4-mini");
  assert.equal(b.fallback_reason, null);
});

test("整单期限：codex 卡住被杀 → deadline_exceeded，不降级花钱", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, JOB_DEADLINE_MS: "800" });
  await store.create(job("dl1", { prompt: "SLOW a cat" }));
  worker.enqueue("dl1");
  const j = await settle(store, "dl1");
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "deadline_exceeded");
  assert.equal(ark.calls.length, 0);
});

test("整单期限从提交算：排队排过了期限的单直接 deadline_exceeded，不出图", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, JOB_DEADLINE_MS: "60000" });
  await store.create(job("dl2", { prompt: "a cat", createdAt: new Date(Date.now() - 61_000).toISOString() }));
  worker.enqueue("dl2");
  const j = await settle(store, "dl2");
  assert.equal(j?.error?.code, "deadline_exceeded");
  assert.equal(j?.attempts, 0);
});

test("降级时剩余时间不够 seedream：deadline_exceeded，不调方舟", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, JOB_DEADLINE_MS: "60000" });
  // 提交于 30s 前：codex 立刻 429 额度满，剩 ~30s < 45s 的 seedream 最低预算
  await store.create(job("dl3", { createdAt: new Date(Date.now() - 30_000).toISOString() }));
  worker.enqueue("dl3");
  const j = await settle(store, "dl3");
  assert.equal(j?.error?.code, "deadline_exceeded");
  assert.equal(ark.calls.length, 0);
});

test("seedream 第一个模型失败 → 换下一个", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, SEEDREAM_MODELS: "bad-sd,good-sd" });
  await store.create(job("s1"));
  worker.enqueue("s1");
  const j = await settle(store, "s1");
  assert.equal(j?.status, "done");
  assert.equal(j?.model, "good-sd");
  assert.deepEqual(ark.calls.map((c) => c.body.model), ["bad-sd", "good-sd"]);
});

test("seedream 全失败 → failed，错误是 seedream_error，引擎留痕", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl, SEEDREAM_MODELS: "bad-1,bad-2" });
  await store.create(job("s2"));
  worker.enqueue("s2");
  const j = await settle(store, "s2");
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "seedream_error");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.model, "bad-2");
});

test("enginePref=seedream：不碰 codex；edit 的参考图以 data URI 发出；小尺寸放大后再裁回", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker, cfg } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await mkdir(cfg.inputsDir, { recursive: true });
  const inputPath = join(cfg.inputsDir, "e1.img");
  await writeFile(inputPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await store.create(job("e1", {
    prompt: "a dog", mode: "edit", inputPath, enginePref: "seedream",
    params: { size: "768x1024", format: "png", quality: "high", transparent: false },
  }));
  worker.enqueue("e1");
  const j = await settle(store, "e1");
  assert.equal(j?.status, "done");
  assert.equal(j?.engine, "seedream");
  assert.equal(j?.attempts, 1);
  assert.equal(j?.fallbackReason, undefined);
  assert.match(ark.calls[0].body.image, /^data:image\/png;base64,/);
  const [w, h] = ark.calls[0].body.size.split("x").map(Number);
  assert.ok(w * h >= 921600);
  const args = JSON.parse(await readFile(join(cfg.resultsDir, "e1.png.args.json"), "utf8"));
  assert.ok(args.includes("768x1024^"));
  assert.ok(!args.includes("-quality")); // png 不传质量
  await assert.rejects(readFile(inputPath)); // 输入文件照样清掉
});

test("透明图不降级（方舟没有透明背景）", async (t) => {
  const ark = await fakeArk(t);
  const { store, worker } = await setup({ ARK_API_KEY: "k", ARK_BASE_URL: ark.baseUrl });
  await store.create(job("tp", { params: { size: "1024x1024", format: "png", quality: "high", transparent: true } }));
  worker.enqueue("tp");
  const j = await settle(store, "tp");
  assert.equal(j?.status, "failed");
  assert.equal(ark.calls.length, 0);
});
