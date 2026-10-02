// bin/paint + bin/paint-batch 单测（2026-10-02 起两者共用 bin/paint-client.mjs）。
// 用本地假 paint 服务（PAINT_API 指过去）模拟出图：验请求体、输出格式（engine/model、
// 错误「code: message」不再 [object Object]）、批量跳过/强制/失败退出码、引擎混用提示。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAINT = new URL("../bin/paint", import.meta.url).pathname;
const BATCH = new URL("../bin/paint-batch", import.meta.url).pathname;

/** 假 paint 服务：prompt 含 SEED → seedream 出图；含 FAIL → failed；含 REJECT → 提交 400 */
async function fakePaint(t) {
  const jobs = new Map();
  const bodies = [];
  let n = 0;
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.method === "POST" && req.url === "/api/jobs") {
        const body = JSON.parse(b);
        bodies.push(body);
        if (body.prompt.includes("REJECT")) return send(400, { error: "bad size (WxH like 1024x1536, or auto/2K/4K)" });
        const id = `job${++n}`;
        jobs.set(id, body);
        return send(202, { job_id: id, status: "queued", deadline_at: new Date(Date.now() + 30_000).toISOString() });
      }
      const m = req.url.match(/^\/api\/jobs\/(\w+)$/);
      if (m) {
        const body = jobs.get(m[1]);
        const seed = body.prompt.includes("SEED");
        const engine = seed ? "seedream" : "codex";
        const model = seed ? "doubao-seedream-5-0-pro-260628" : "gpt-5.4-mini";
        if (body.prompt.includes("FAIL")) return send(200, { job_id: m[1], status: "failed", engine, model, error: { code: "seedream_error", message: "HTTP 400 InvalidParameter" } });
        return send(200, {
          job_id: m[1], status: "done", engine, model, fallback_reason: seed ? "codex quota exhausted" : null,
          result_url: `http://127.0.0.1:${srv.address().port}/results/${m[1]}?m=${seed ? "doubao-seedream" : "gpt-image-2"}`,
        });
      }
      if (req.url.startsWith("/results/")) {
        const model = new URL(req.url, "http://x").searchParams.get("m");
        res.writeHead(200);
        return res.end(Buffer.from(`\xff\xd8 <x paint:Model="${model}"/> FAKEJPEG`, "latin1"));
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const env = { ...process.env, PAINT_API: `http://127.0.0.1:${srv.address().port}`, PAINT_API_TOKEN: "t", PAINT_POLL_MS: "20" };
  const run = (bin, args) => new Promise((resolve) => {
    execFile(bin, args, { env, encoding: "utf8" }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
  });
  return { bodies, run, dir: mkdtempSync(join(tmpdir(), "paint-cli-")) };
}

test("paint：请求体（尺寸/格式/q80/engine/group）+ 输出带 engine/model", async (t) => {
  const { bodies, run, dir } = await fakePaint(t);
  const out = join(dir, "c.jpg");
  const r = await run(PAINT, ["a cover", out, "--size", "1024x1536", "--engine", "auto", "--group", "book-x"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(bodies[0], { prompt: "a cover", size: "1024x1536", format: "jpeg", compression: 80, engine: "auto", group: "book-x" });
  assert.ok(existsSync(out));
  assert.match(r.stdout, /^saved: /m);
  assert.match(r.stdout, /^result_url: http/m);
  assert.match(r.stdout, /^engine: codex \(gpt-5\.4-mini\)$/m);
  assert.match(r.stdout, /^job: job1/m);
});

test("paint：失败打印「code: message」，不再是 [object Object]", async (t) => {
  const { run, dir } = await fakePaint(t);
  const r = await run(PAINT, ["FAIL x", join(dir, "x.jpg")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /paint job failed: seedream_error: HTTP 400 InvalidParameter/);
  assert.doesNotMatch(r.stderr, /object Object/);
  const r2 = await run(PAINT, ["REJECT x", join(dir, "y.jpg")]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /paint job failed: rejected: HTTP 400 bad size/);
});

test("paint-batch：一次全提交、跳过已存在、--group 作用于没写 group 的项、逐张报 engine", async (t) => {
  const { bodies, run, dir } = await fakePaint(t);
  const m = join(dir, "m.json");
  const existing = join(dir, "p00.jpg");
  writeFileSync(existing, "old");
  const items = [{ out: existing, prompt: "old page" },
    ...Array.from({ length: 4 }, (_, i) => ({ out: join(dir, `p0${i + 1}.jpg`), prompt: `page ${i + 1}`, image: m, quality: "high" })),
    { out: join(dir, "p09.jpg"), prompt: "page 9", group: "other" }];
  writeFileSync(m, JSON.stringify(items));
  const r = await run(BATCH, [m, "--group", "book-x"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(bodies.length, 5);
  assert.match(r.stdout, /skip\s+\S*p00\.jpg/);
  assert.match(r.stdout, /5\/5 张画好/);
  assert.match(r.stdout, /ok\s+\S*p01\.jpg\s+\(\d+s, codex gpt-5\.4-mini\)/);
  assert.equal(bodies.filter((b) => b.group === "book-x").length, 4);
  assert.equal(bodies.find((b) => b.prompt === "page 9").group, "other");
  assert.equal(bodies[0].quality, "high");
  assert.ok(bodies[0].image_b64);
  // --force 才重画已存在的
  bodies.length = 0;
  await run(BATCH, [m, "--force"]);
  assert.equal(bodies.length, 6);
});

test("paint-batch：一张失败不拖垮整批（FAIL code: message，退出码 1）；引擎混用点名少数派", async (t) => {
  const { run, dir } = await fakePaint(t);
  const m = join(dir, "m.json");
  writeFileSync(m, JSON.stringify([
    { out: join(dir, "a.jpg"), prompt: "FAIL a" },
    { out: join(dir, "b.jpg"), prompt: "b" },
    { out: join(dir, "c.jpg"), prompt: "c" },
    { out: join(dir, "d.jpg"), prompt: "SEED d" },
  ]));
  const r = await run(BATCH, [m]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+\S*a\.jpg\s+\(\d+s\)\s+seedream_error: HTTP 400/);
  assert.match(r.stdout, /失败 1 张/);
  assert.match(r.stdout, /引擎混用：codex 2 \/ seedream 1。多数是 codex.*--engine codex.*d\.jpg/);
  // paint --engines 同一套对账
  const e = await run(PAINT, ["--engines", join(dir, "b.jpg"), join(dir, "c.jpg"), join(dir, "d.jpg")]);
  assert.match(e.stdout, /^seedream\s+\S*d\.jpg$/m);
  assert.match(e.stdout, /混用了！多数是 codex/);
});

test("paint-batch：清单坏了直接退出码 2", async (t) => {
  const { run, dir } = await fakePaint(t);
  const m = join(dir, "m.json");
  writeFileSync(m, JSON.stringify([{ out: join(dir, "x.jpg") }]));
  assert.equal((await run(BATCH, [m])).status, 2);
  writeFileSync(m, JSON.stringify([{ out: "same.jpg", prompt: "a" }, { out: "same.jpg", prompt: "b" }]));
  assert.equal((await run(BATCH, [m])).status, 2);
});
