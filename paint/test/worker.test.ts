import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobStore, type Job } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { loadConfig } from "../src/config.ts";
import { fakeRouter } from "./fake-router.ts";

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");

async function setup(env: Record<string, string> = {}, fr = fakeRouter(), recovered: string[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-worker-"));
  const cfg = loadConfig({ API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE, CLAIM_INTERVAL_MS: "20", ...env } as any);
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg, fr.router);
  return { cfg, store, hub, worker, fr, start: () => worker.start(recovered) };
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "a cat",
    params: { size: "2K", format: "png", quality: "high", transparent: false },
    percent: 0, error: null, createdAt: new Date().toISOString(), ...over,
  };
}

async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

test("worker completes a generate job and writes result", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await store.create(job("g1"));
  await worker.submitSingle((await store.get("g1"))!);
  await waitFor(async () => (await store.get("g1"))?.status === "done");
  const j = await store.get("g1");
  assert.equal(j?.percent, 100);
  assert.ok(j?.resultPath?.endsWith("g1.png"));
  assert.equal(await readFile(join(cfg.resultsDir, "g1.png"), "utf8"), "FAKEPNGDATA");
});

test("worker marks failed on engine error", async () => {
  const { store, worker } = await setup();
  await worker.start();
  await store.create(job("f1", { prompt: "please FAIL" }));
  await worker.submitSingle((await store.get("f1"))!);
  await waitFor(async () => (await store.get("f1"))?.status === "failed");
  const j = await store.get("f1");
  assert.equal(j?.error?.code, "http_error");
  assert.equal(j?.attempts, 1); // http_error 不可重试，只跑一次
});

test("missing_image_result 重试一次后成功", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await store.create(job("r1", { prompt: "a FLAKY cat" }));
  await worker.submitSingle((await store.get("r1"))!);
  await waitFor(async () => (await store.get("r1"))?.status === "done");
  const j = await store.get("r1");
  assert.equal(j?.attempts, 2);
  assert.equal(j?.percent, 100);
  assert.equal(await readFile(join(cfg.resultsDir, "r1.png"), "utf8"), "FAKEPNGDATA");
});

test("missing_image_result 重试后仍失败：留痕 detail + attempts", async () => {
  const { store, worker } = await setup();
  await worker.start();
  await store.create(job("r2", { prompt: "ALWAYSMISSING" }));
  await worker.submitSingle((await store.get("r2"))!);
  await waitFor(async () => (await store.get("r2"))?.status === "failed");
  const j = await store.get("r2");
  assert.equal(j?.error?.code, "missing_image_result");
  assert.equal(j?.attempts, 2);
  // 失败留痕：CLI 返回的 detail 原样存进 job JSON，下次诊断不用猜
  assert.deepEqual((j?.error as any)?.detail, { response_id: "resp_stub", output_text: "stub refusal text" });
});

test("重试失败的回调 error 只带 code/message，不带 detail", async () => {
  const { store, worker } = await setup();
  await worker.start();
  const { createServer } = await import("node:http");
  const received: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push(JSON.parse(b)); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;

  await store.create(job("r3", { prompt: "ALWAYSMISSING", callbackUrl: `http://127.0.0.1:${port}/cb` }));
  await worker.submitSingle((await store.get("r3"))!);
  await waitFor(async () => received.length > 0);
  srv.close();

  assert.equal(received[0].status, "failed");
  assert.deepEqual(received[0].error, {
    code: "missing_image_result",
    message: "The response did not include an image_generation_call result.",
  });
});

test("worker fires callback on done", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  // local callback receiver
  const { createServer } = await import("node:http");
  const received: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;

  await store.create(job("c1", { callbackUrl: `http://127.0.0.1:${port}/cb`, callbackToken: "xyz", callbackMeta: { note_id: "n1" } }));
  await worker.submitSingle((await store.get("c1"))!);
  await waitFor(async () => received.length > 0);
  srv.close();

  assert.equal(received[0].body.status, "done");
  assert.deepEqual(received[0].body.callback_meta, { note_id: "n1" });
  assert.ok(received[0].body.result_url.endsWith("/results/c1.png"));
  assert.equal(received[0].headers["authorization"], "Bearer xyz");
});

test("buildArgs failure → failed, input cleaned, pool still processes next", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await mkdir(cfg.inputsDir, { recursive: true });
  const inputPath = join(cfg.inputsDir, "te.img");
  await writeFile(inputPath, "IN");
  await store.create(job("te", { mode: "edit", inputPath, params: { size: "2K", format: "png", quality: "high", transparent: true } }));
  await worker.submitSingle((await store.get("te"))!);
  await waitFor(async () => (await store.get("te"))?.status === "failed");
  await assert.rejects(readFile(inputPath)); // input cleaned despite early buildArgs throw
  // pool still alive: a normal job completes afterward
  await store.create(job("after"));
  await worker.submitSingle((await store.get("after"))!);
  await waitFor(async () => (await store.get("after"))?.status === "done");
});

test("worker embeds XMP into real PNG result before done", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await store.create(job("x1", { prompt: "REALPNG a cat", xmpMeta: { magic: "1234567" } }));
  await worker.submitSingle((await store.get("x1"))!);
  await waitFor(async () => (await store.get("x1"))?.status === "done");
  const buf = await readFile(join(cfg.resultsDir, "x1.png"));
  assert.ok(buf.includes(Buffer.from("W5M0MpCehiHzreSzNTczkc9d"))); // XMP 已入文件
  assert.ok(buf.includes(Buffer.from("REALPNG a cat")));            // prompt 默认写入
  assert.ok(buf.includes(Buffer.from('paint:Magic="1234567"')));    // xmp_meta 透传
  const j = await store.get("x1");
  assert.equal(j?.bytes, buf.length); // bytes 是嵌入后的大小
});

test("worker respects xmpPrompt=false (no prompt in file)", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await store.create(job("x2", { prompt: "REALPNG secret words", xmpPrompt: false }));
  await worker.submitSingle((await store.get("x2"))!);
  await waitFor(async () => (await store.get("x2"))?.status === "done");
  const buf = await readFile(join(cfg.resultsDir, "x2.png"));
  assert.ok(buf.includes(Buffer.from("W5M0MpCehiHzreSzNTczkc9d"))); // 基础字段仍写
  assert.ok(!buf.includes(Buffer.from("secret words")));            // prompt 不写
});

test("worker still completes when result is not embeddable", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await store.create(job("x3")); // 默认 fake 写 "FAKEPNGDATA"，非 PNG → 跳过嵌入
  await worker.submitSingle((await store.get("x3"))!);
  await waitFor(async () => (await store.get("x3"))?.status === "done");
  assert.equal(await readFile(join(cfg.resultsDir, "x3.png"), "utf8"), "FAKEPNGDATA"); // 文件原样
});

test("pool drains all queued jobs", async () => {
  const { store, worker } = await setup();
  await worker.start();
  const ids = ["m1", "m2", "m3", "m4"];
  for (const id of ids) await store.create(job(id));
  for (const id of ids) await worker.submitSingle((await store.get(id))!);
  for (const id of ids) await waitFor(async () => (await store.get(id))?.status === "done");
  for (const id of ids) assert.equal((await store.get(id))?.status, "done");
});

test("inputUrl 的下载挪到 worker：起跑时拉取成功 → 正常出图", async (t) => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  // 本地 HTTP 服务当"远端原图"
  const { createServer } = await import("node:http");
  const srv = createServer((_req, res) => { res.writeHead(200); res.end("IMGBYTES"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  t.after(() => srv.close());
  const port = (srv.address() as any).port;
  await mkdir(cfg.inputsDir, { recursive: true });
  const inputPath = join(cfg.inputsDir, "d1.img");
  await store.create(job("d1", { mode: "edit", inputPath, inputUrl: `http://127.0.0.1:${port}/x.png` }));
  await worker.submitSingle((await store.get("d1"))!);
  await waitFor(async () => (await store.get("d1"))?.status === "done");
  const j = await store.get("d1");
  assert.equal(j?.percent, 100); // 下载成功且引擎拿到了输入文件
});

test("inputUrl 下载失败 → job 直接 failed（input_download_failed），不进引擎", async () => {
  const { store, worker, cfg } = await setup();
  await worker.start();
  await mkdir(cfg.inputsDir, { recursive: true });
  const inputPath = join(cfg.inputsDir, "d2.img");
  // 无人监听的端口：连接拒绝
  await store.create(job("d2", { mode: "edit", inputPath, inputUrl: "http://127.0.0.1:1/x.png" }));
  await worker.submitSingle((await store.get("d2"))!);
  await waitFor(async () => (await store.get("d2"))?.status === "failed");
  const j = await store.get("d2");
  assert.equal(j?.error?.code, "input_download_failed");
});

// ── 模型被账号拒绝 → 自动换下一个（2026-09-06）──────────────────────────
// CLI 自带的默认模型会随账号能开的东西漂：那天 gpt-5.4 突然 400，paint 全线出不了
// 图，而服务 active、journalctl 无声。所以模型钉死在 config，并且拒了要能换。
test("账号不认第一个模型 → 换到下一个并出图", async () => {
  const { store, worker } = await setup({ CODEX_MODELS: "badmodel-a,goodmodel" });
  await worker.start();
  await store.create(job("m1"));
  await worker.submitSingle((await store.get("m1"))!);
  await waitFor(async () => (await store.get("m1"))?.status === "done");
  const j = await store.get("m1");
  assert.equal(j?.model, "goodmodel");
  assert.equal(j?.attempts, 2); // 坏模型 1 次 + 好模型 1 次
});

test("候选全被拒 → 老老实实失败，错误留的是最后一个模型", async () => {
  const { store, worker } = await setup({ CODEX_MODELS: "badmodel-a,badmodel-b" });
  await worker.start();
  await store.create(job("m2"));
  await worker.submitSingle((await store.get("m2"))!);
  await waitFor(async () => (await store.get("m2"))?.status === "failed");
  const j = await store.get("m2");
  assert.equal(j?.model, "badmodel-b");
  assert.equal(j?.error?.code, "http_error");
});

test("不是模型问题就别换模型——普通 http_error 只跑第一个候选", async () => {
  const { store, worker } = await setup({ CODEX_MODELS: "goodmodel,other" });
  await worker.start();
  await store.create(job("m3", { prompt: "please FAIL" }));
  await worker.submitSingle((await store.get("m3"))!);
  await waitFor(async () => (await store.get("m3"))?.status === "failed");
  const j = await store.get("m3");
  assert.equal(j?.attempts, 1);
  assert.equal(j?.model, "goodmodel");
});

// ── engine-router 调度（2026-10-28）：paint 只执行，失败怎么算听 router 的 ──────────

test("失败回报 router 带报错原文；router 判「放回队列」→ job 回到 queued，不回调", async () => {
  const fr = fakeRouter({ verdict: (_id, err) => (/usage_limit/.test(err) ? "queued" : "failed") });
  const { store, worker } = await setup({}, fr);
  await worker.start();
  await store.create(job("q1", { prompt: "QUOTA a cat", callbackUrl: "http://127.0.0.1:1/cb" }));
  await worker.submitSingle((await store.get("q1"))!);
  await waitFor(async () => fr.completed.length > 0);
  await waitFor(async () => (await store.get("q1"))?.status === "queued");
  assert.match(fr.completed[0].error ?? "", /usage_limit_reached/, "detail 原文带给 router 判冷却");
  const j = await store.get("q1");
  assert.equal(j?.callbackStatus, undefined, "没终判就不回调");
  assert.equal(j?.engine, "codex");
});

test("单张交批：插队优先、带 group 和点名引擎；router 连不上先记着，恢复后补交", async () => {
  let down = true;
  const fr = fakeRouter({ down: () => down });
  const { store, worker } = await setup({}, fr);
  await worker.start();
  await store.create(job("u1", { group: "book-z", enginePref: "codex" }));
  await worker.submitSingle((await store.get("u1"))!);
  assert.equal(fr.batches.length, 0);
  assert.equal((await store.get("u1"))?.status, "queued");
  down = false;
  await (worker as any).flushUnsubmitted();
  assert.equal(fr.batches[0].priority, "interactive");
  assert.equal(fr.batches[0].group, "book-z");
  assert.equal(fr.batches[0].engine, "codex");
  await waitFor(async () => (await store.get("u1"))?.status === "done");
  assert.equal((await store.get("u1"))?.batchId, "b_1");
});

test("router 派 seedream 就走方舟；没配 ARK key → 这张失败（不偷偷换 codex）", async () => {
  const fr = fakeRouter({ engine: () => "seedream" });
  const { store, worker } = await setup({}, fr);
  await worker.start();
  await store.create(job("sd1"));
  await worker.submitSingle((await store.get("sd1"))!);
  await waitFor(async () => (await store.get("sd1"))?.status === "failed");
  const j = await store.get("sd1");
  assert.equal(j?.error?.code, "seedream_unavailable");
  assert.equal(j?.engine, "seedream");
});

test("心跳：批次被取消 → 杀掉在画的进程，回报 cancelled", async () => {
  const fr = fakeRouter();
  const { store, worker } = await setup({ CODEX_MODELS: "m" }, fr);
  await worker.start();
  await store.create(job("k1", { prompt: "SLOW a cat" }));
  await worker.submitSingle((await store.get("k1"))!);
  await waitFor(async () => (await store.get("k1"))?.status === "running");
  await fr.router.cancelBatch("b_1");
  await (worker as any).heartbeat();
  await waitFor(async () => (await store.get("k1"))?.status === "failed");
  assert.equal((await store.get("k1"))?.error?.code, "cancelled");
  assert.match(fr.completed[0].error ?? "", /cancelled/);
});

test("启动：先 release-all；重启前没交上的补交，交过的等 router 再派", async () => {
  const fr = fakeRouter();
  const { store, worker } = await setup({}, fr, ["s1", "s2"]);
  await store.create(job("s1"));
  await store.create(job("s2", { batchId: "b_old" }));
  await worker.start(["s1", "s2"]);
  assert.equal(fr.released(), 1);
  assert.deepEqual(fr.batches.map((b) => b.items.map((i) => i.job_id)), [["s1"]]);
  await waitFor(async () => (await store.get("s1"))?.status === "done");
});

test("对账：router 判失败（暂停超时 / 取消）而 paint 这边还在排队的 → 补失败 + 回调", async () => {
  const fr = fakeRouter({ verdict: () => "queued" });
  const { store, worker } = await setup({}, fr);
  await worker.start();
  await store.create(job("y1", { prompt: "please FAIL" }));
  await worker.submitSingle((await store.get("y1"))!);
  await waitFor(async () => fr.completed.length > 0);
  await waitFor(async () => (await store.get("y1"))?.status === "queued");
  const it = fr.items.get("y1")!;
  it.status = "failed";
  it.error = "paused over 2h: codex/codex-1 cooling down";
  await worker.sync();
  const j = await store.get("y1");
  assert.equal(j?.status, "failed");
  assert.equal(j?.error?.code, "engine_unavailable");
  assert.match(j?.error?.message ?? "", /paused over 2h/);
});
