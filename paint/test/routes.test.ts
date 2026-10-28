import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobStore } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { createApp, isBlockedHost } from "../src/server.ts";
import { fakeRouter } from "./fake-router.ts";

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");

async function boot(fr = fakeRouter()) {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-routes-"));
  const cfg = loadConfig({ API_TOKEN: "secret", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE, PUBLIC_BASE_URL: "http://localhost", CLAIM_INTERVAL_MS: "20" } as any);
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg, fr.router);
  await worker.start();
  const app = createApp(cfg, { store, hub, worker });
  app.on("close", () => worker.stop());
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  return { app, base, fr, cfg };
}

test("POST /api/jobs requires bearer", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  app.close();
});

test("POST /api/jobs 400 when prompt missing", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  app.close();
});

test("full generate flow: submit → poll done → fetch result", async () => {
  const { app, base } = await boot();
  const sub = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "a cat" }) });
  assert.equal(sub.status, 202);
  const { job_id } = await sub.json();
  assert.ok(job_id);

  let status = "";
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/jobs/${job_id}`, { headers: { Authorization: "Bearer secret" } });
    const j = await r.json();
    status = j.status;
    if (status === "done" || status === "failed") {
      if (status === "done") {
        assert.equal(j.attempts, 1); // API 暴露 attempts，供诊断
        const img = await fetch(`${base}${new URL(j.result_url).pathname}`);
        assert.equal(img.status, 200);
        assert.equal(await img.text(), "FAKEPNGDATA");
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(status, "done");
  app.close();
});

test("results path traversal blocked", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/results/..%2f..%2fetc%2fpasswd`);
  assert.ok(res.status === 400 || res.status === 404);
  app.close();
});

test("GET /results/<missing> returns 404", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/results/does-not-exist-0000.png`);
  assert.equal(res.status, 404);
  app.close();
});

test("isBlockedHost blocks private/loopback/link-local incl IPv4-mapped IPv6, allows public", () => {
  const blocked = ["http://127.0.0.1/","http://10.0.0.1/","http://192.168.1.1/","http://169.254.169.254/","http://172.16.0.1/","http://172.31.9.9/","http://0.0.0.0/","http://localhost/","http://[::1]/","http://[fd00::1]/","http://[fe80::1]/","http://[::ffff:169.254.169.254]/","http://[::ffff:127.0.0.1]/"];
  for (const u of blocked) assert.equal(isBlockedHost(new URL(u).hostname), true, `should block ${u}`);
  const allowed = ["http://example.com/","http://fda.gov/","http://fdic.gov/","http://172.15.0.1/","http://172.32.0.1/","http://11.0.0.1/","http://8.8.8.8/","http://jianshuo.dev/"];
  for (const u of allowed) assert.equal(isBlockedHost(new URL(u).hostname), false, `should allow ${u}`);
});

test("POST image_url to a blocked host is rejected by the SSRF guard", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "x", image_url: "http://[::ffff:169.254.169.254]/x.png" }) });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.error, "image_url host not allowed"); // gates the guard specifically, not a fetch failure
  app.close();
});

test("POST image_b64 over size cap is rejected", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-routes-"));
  const cfg = loadConfig({ API_TOKEN: "secret", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE, PUBLIC_BASE_URL: "http://localhost", MAX_INPUT_BYTES: "10" } as any);
  const store = new JobStore(cfg.jobsDir); const hub = new EventHub(); const worker = new Worker(store, hub, cfg, fakeRouter().router);
  const app = createApp(cfg, { store, hub, worker });
  await new Promise((r) => app.listen(0, r));
  const b = `http://127.0.0.1:${(app.address()).port}`;
  const big = Buffer.from("A".repeat(1000)).toString("base64");
  const res = await fetch(`${b}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "x", image_b64: big }) });
  assert.equal(res.status, 400);
  app.close();
});

test("GET /api/jobs?limit=abc does not crash", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs?limit=abc`, { headers: { Authorization: "Bearer secret" } });
  assert.equal(res.status, 200);
  app.close();
});

test("SSE streams to a terminal event for a generate job", async () => {
  const { app, base } = await boot();
  const sub = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "a cat" }) });
  const { job_id } = await sub.json();
  const es = await fetch(`${base}/api/jobs/${job_id}/events`, { headers: { Authorization: "Bearer secret" } });
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let buf = "", saw = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    if (buf.includes("event: done") || buf.includes("event: failed")) { saw = true; break; }
  }
  await reader.cancel().catch(() => {});
  assert.ok(saw);
  app.close();
});

test("GET /api/jobs/<missing>/events returns 404", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs/does-not-exist/events`, { headers: { Authorization: "Bearer secret" } });
  assert.equal(res.status, 404);
  app.close();
});

test("POST /api/jobs with malformed JSON returns 400", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: "{not json" });
  assert.equal(res.status, 400);
  app.close();
});

test("GET /log renders a jobs table with prompts", async () => {
  const { app, base } = await boot();
  await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "LOGTEST-PROMPT-xyz" }) });
  const res = await fetch(`${base}/log`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /paint 任务日志/);
  assert.match(html, /LOGTEST-PROMPT-xyz/);
  app.close();
});

test("POST /api/jobs accepts xmp_prompt and xmp_meta", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
    body: JSON.stringify({ prompt: "a cat", xmp_prompt: false, xmp_meta: { magic: "1234567" } }),
  });
  assert.equal(res.status, 202);
  app.close();
});

test("POST /api/jobs 400 on bad xmp_meta", async () => {
  const { app, base } = await boot();
  const post = (body: unknown) =>
    fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify(body),
    });
  // 非对象
  assert.equal((await post({ prompt: "a cat", xmp_meta: "nope" })).status, 400);
  // 坏 key（带连字符）
  assert.equal((await post({ prompt: "a cat", xmp_meta: { "bad-key": "v" } })).status, 400);
  // 非字符串值
  assert.equal((await post({ prompt: "a cat", xmp_meta: { magic: 123 } })).status, 400);
  // 总量超 4KB
  assert.equal((await post({ prompt: "a cat", xmp_meta: { big: "x".repeat(5000) } })).status, 400);
  // key 以数字开头（非法 XML 属性名）
  assert.equal((await post({ prompt: "a cat", xmp_meta: { "7days": "v" } })).status, 400);
  // key 与保留字段 jobId 大小写不敏感碰撞
  assert.equal((await post({ prompt: "a cat", xmp_meta: { jobId: "x" } })).status, 400);
  // 两个 key 大写化后互相碰撞
  assert.equal((await post({ prompt: "a cat", xmp_meta: { magic: "1", Magic: "2" } })).status, 400);
  app.close();
});

test("POST /api/jobs 校验 engine：非法值 400、seedream+transparent 400", async () => {
  const { app, base } = await boot();
  const post = (b: unknown) => fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify(b) });
  assert.equal((await post({ prompt: "a cat", engine: "dalle" })).status, 400);
  assert.equal((await post({ prompt: "a cat", engine: "seedream", transparent: true })).status, 400);
  app.close();
});

test("POST /api/jobs：engine=seedream 但服务端没配 ARK_API_KEY → 提交即 400（不排队再失败）", async () => {
  const { app, base } = await boot();
  const post = (b: unknown) => fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify(b) });
  const r = await post({ prompt: "a cat", engine: "seedream" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /ARK_API_KEY/);
  assert.equal((await post({ prompt: "a cat", engine: "auto" })).status, 202); // auto 照收
  app.close();
});

test("POST /api/jobs：size 服务端规整、group 校验；单张插队交给 router；GET 回 engine/model/group/batch_id", async () => {
  const { app, base, fr } = await boot();
  const H = { "Content-Type": "application/json", Authorization: "Bearer secret" };
  const post = (b: unknown) => fetch(`${base}/api/jobs`, { method: "POST", headers: H, body: JSON.stringify(b) });
  assert.equal((await post({ prompt: "a cat", size: "garbage" })).status, 400);
  assert.equal((await post({ prompt: "a cat", group: "bad group!" })).status, 400);
  const sub = await post({ prompt: "a cat", size: "1365x1024", group: "book-abc" });
  assert.equal(sub.status, 202);
  const s = await sub.json();
  assert.equal(s.size, "1360x1024");
  assert.equal(s.deadline_at, null, "排队在 router，期限从开画算");
  let j: any;
  for (let i = 0; i < 200; i++) {
    j = await (await fetch(`${base}/api/jobs/${s.job_id}`, { headers: H })).json();
    if (j.status === "done" || j.status === "failed") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(j.status, "done");
  assert.equal(j.size, "1360x1024");
  assert.equal(j.engine, "codex");
  assert.equal(j.model, "gpt-5.4-mini");
  assert.equal(j.fallback_reason, null);
  assert.equal(j.group, "book-abc");
  assert.equal(j.engine_pref, "auto");
  assert.equal(j.batch_id, "b_1");
  assert.equal(fr.batches[0].priority, "interactive");
  assert.equal(fr.batches[0].group, "book-abc");
  app.close();
});

const H = { "Content-Type": "application/json", Authorization: "Bearer secret" };

test("POST /api/batches：整批一次交 router；共用参考图只传一次（inputs + image_ref）；GET 进度带每张 result_url", async () => {
  const { app, base, fr, cfg } = await boot();
  const ref = Buffer.from("REFIMG").toString("base64");
  const items = ["p01", "p02", "p03"].map((k) => ({ key: `/w/${k}.jpg`, prompt: `page ${k}`, image_ref: "refs", size: "1024x1024", format: "jpeg" }));
  const r = await fetch(`${base}/api/batches`, { method: "POST", headers: H, body: JSON.stringify({ group: "book-b", label: "《书》", inputs: { refs: ref }, items }) });
  assert.equal(r.status, 202);
  const b = await r.json();
  assert.equal(b.batch_id, "b_1");
  assert.equal(fr.batches.length, 1, "一批只交一次");
  assert.equal(fr.batches[0].items.length, 3);
  assert.equal(fr.batches[0].group, "book-b");
  assert.equal(fr.batches[0].priority, "batch");
  let v: any;
  for (let i = 0; i < 200; i++) {
    v = await (await fetch(`${base}/api/batches/${b.batch_id}`, { headers: H })).json();
    if (v.items.every((x: any) => x.status === "done")) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.deepEqual(v.items.map((x: any) => x.key), ["/w/p01.jpg", "/w/p02.jpg", "/w/p03.jpg"]);
  assert.ok(v.items.every((x: any) => x.status === "done" && x.result_url && x.engine === "codex"));
  assert.equal(v.engine, "codex");
  void cfg;
  app.close();
});

test("POST /api/batches：任何一项不合法整批 400 不建 job；image_ref 找不到 400；router 拒收 503", async () => {
  const { app, base } = await boot();
  const post = (b: unknown) => fetch(`${base}/api/batches`, { method: "POST", headers: H, body: JSON.stringify(b) });
  assert.equal((await post({ items: [] })).status, 400);
  const bad = await post({ items: [{ prompt: "ok" }, { prompt: "" }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /items\[1\]/);
  assert.equal((await post({ items: [{ prompt: "x", image_ref: "nope" }] })).status, 400);
  app.close();
  const down = await boot(fakeRouter({ down: () => true }));
  const r = await fetch(`${down.base}/api/batches`, { method: "POST", headers: H, body: JSON.stringify({ items: [{ prompt: "x" }] }) });
  assert.equal(r.status, 503);
  down.app.close();
});

test("POST /api/batches/:id/cancel 转给 router；不存在的批次 404", async () => {
  const { app, base, fr } = await boot(fakeRouter({ engine: () => "gpt-image" }));
  const r = await fetch(`${base}/api/batches`, { method: "POST", headers: H, body: JSON.stringify({ items: [{ prompt: "SLOW a" }, { prompt: "SLOW b" }] }) });
  const b = await r.json();
  const c = await fetch(`${base}/api/batches/${b.batch_id}/cancel`, { method: "POST", headers: H });
  assert.equal(c.status, 200);
  assert.ok([...fr.items.values()].every((i) => i.status === "failed" || fr.stop.has(i.job_id)));
  assert.equal((await fetch(`${base}/api/batches/b_nope`, { headers: H })).status, 404);
  app.close();
});
