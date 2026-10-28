// bin/paint 单测（2026-10-28 起一切出图都是批次，客户端 bin/paint-client.mjs）。
// 用本地假 paint 服务（PAINT_API 指过去）模拟 /api/batches：验请求体（共用参考图只传一次）、
// 跳过已有、没等完退出码 3 + 重跑接着等同一批、失败退出码 1、错误「code: message」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAINT = new URL("../bin/paint", import.meta.url).pathname;

/** 假 paint：每次 GET 批次推进一张；prompt 含 FAIL → 那张失败；REJECT → 交批 400；polls 次之后才开始画 */
async function fakePaint(t, { startAfterPolls = 0 } = {}) {
  const batches = new Map();
  const posts = [];
  let n = 0;
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const send = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      const port = srv.address().port;
      if (req.method === "POST" && req.url === "/api/batches") {
        const body = JSON.parse(b);
        posts.push(body);
        if (body.items.some((i) => i.prompt.includes("REJECT"))) return send(400, { error: "items[0]: bad size" });
        const id = `b_${++n}`;
        batches.set(id, { body, polls: 0, items: body.items.map((it, k) => ({ key: it.key, job_id: `${id}-${k}`, status: "queued", prompt: it.prompt })) });
        return send(202, view(id, port));
      }
      const m = req.url.match(/^\/api\/batches\/(\w+)$/);
      if (m && batches.has(m[1])) {
        const bt = batches.get(m[1]);
        if (++bt.polls > startAfterPolls) {
          const next = bt.items.find((i) => i.status === "queued");
          if (next) next.status = next.prompt.includes("FAIL") ? "failed" : "done";
        }
        return send(200, view(m[1], port));
      }
      if (m) return send(404, { error: "batch not found" });
      if (req.url.startsWith("/results/")) {
        res.writeHead(200);
        return res.end("FAKEJPEG");
      }
      send(404, { error: "not found" });
    });
  });
  function view(id, port) {
    const bt = batches.get(id);
    const c = (s) => bt.items.filter((i) => i.status === s).length;
    const allDone = !c("queued");
    return {
      batch_id: id, status: allDone ? (c("failed") ? "failed" : "done") : "running", engine: "codex", decided_reason: "5h 10% · week 2% / cap 90",
      paused_until: null, pause_reason: null, counts: { total: bt.items.length, done: c("done"), failed: c("failed"), queued: c("queued"), running: 0 },
      items: bt.items.map((i) => ({
        key: i.key, job_id: i.job_id, status: i.status, engine: i.status === "done" ? "codex" : null, model: i.status === "done" ? "gpt-6-astra" : null,
        result_url: i.status === "done" ? `http://127.0.0.1:${port}/results/${i.job_id}.jpg` : null,
        error: i.status === "failed" ? { code: "missing_image_result", message: "no image" } : null,
      })),
    };
  }
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const run = (args, extra = {}) => new Promise((resolve) => {
    const env = { ...process.env, PAINT_API: `http://127.0.0.1:${srv.address().port}`, PAINT_API_TOKEN: "t", PAINT_POLL_MS: "10", ...extra };
    execFile(PAINT, args, { env, encoding: "utf8" }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }));
  });
  return { posts, batches, run, dir: mkdtempSync(join(tmpdir(), "paint-cli-")) };
}

test("清单整批一次交：共用参考图只传一次（inputs + image_ref），group/label/engine 带上，画好逐张下载", async (t) => {
  const f = await fakePaint(t);
  const refs = join(f.dir, "refs.png");
  writeFileSync(refs, "REF");
  const items = ["p01", "p02", "p03"].map((k) => ({ out: join(f.dir, `${k}.jpg`), prompt: `page ${k}`, image: refs }));
  const manifest = join(f.dir, "paint.json");
  writeFileSync(manifest, JSON.stringify(items));
  const r = await f.run([manifest, "--group", "book-a", "--label", "《书》", "--engine", "codex"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(f.posts.length, 1);
  const body = f.posts[0];
  assert.deepEqual(Object.keys(body.inputs), ["i0"]);
  assert.equal(Buffer.from(body.inputs.i0, "base64").toString(), "REF");
  assert.ok(body.items.every((i) => i.image_ref === "i0" && !i.image_b64));
  assert.equal(body.group, "book-a");
  assert.equal(body.label, "《书》");
  assert.equal(body.engine, "codex");
  assert.equal(body.items[0].format, "jpeg");
  assert.equal(body.items[0].compression, 80);
  assert.equal(body.items[0].quality, "medium");
  for (const it of items) assert.equal(readFileSync(it.out, "utf8"), "FAKEJPEG");
  assert.match(r.stdout, /ok {4}.*p01\.jpg {2}\(codex gpt-6-astra\)/);
  assert.match(r.stdout, /— 3\/3 张画好/);
  assert.equal(existsSync(manifest + ".batch"), false, "结束后状态文件清掉");
});

test("已存在的跳过，只交缺的；全都有就不交", async (t) => {
  const f = await fakePaint(t);
  const items = ["a", "b"].map((k) => ({ out: join(f.dir, `${k}.jpg`), prompt: k }));
  writeFileSync(items[0].out, "OLD");
  const manifest = join(f.dir, "m.json");
  writeFileSync(manifest, JSON.stringify(items));
  const r = await f.run([manifest]);
  assert.equal(r.status, 0);
  assert.equal(f.posts[0].items.length, 1);
  assert.equal(readFileSync(items[0].out, "utf8"), "OLD");
  assert.match(r.stdout, /skip {2}.*a\.jpg/);
  const again = await f.run([manifest]);
  assert.equal(again.status, 0);
  assert.equal(f.posts.length, 1, "都有了不再交批");
});

test("没等完：退出码 3、留状态文件；原样重跑接着等同一批，不重复交", async (t) => {
  const f = await fakePaint(t, { startAfterPolls: 1000 });
  const items = [{ out: join(f.dir, "x.jpg"), prompt: "x" }];
  const manifest = join(f.dir, "slow.json");
  writeFileSync(manifest, JSON.stringify(items));
  const r = await f.run([manifest], { PAINT_WAIT_MS: "100" });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /原样重跑这条命令接着等同一批/);
  assert.equal(JSON.parse(readFileSync(manifest + ".batch", "utf8")).batch_id, "b_1");
  f.batches.get("b_1").polls = 2000; // 现在开始画
  const r2 = await f.run([manifest]);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(f.posts.length, 1, "没有再交一批");
  assert.equal(readFileSync(items[0].out, "utf8"), "FAKEJPEG");
});

test("有图失败：逐张报 FAIL code: message，退出码 1；交批被拒也是 code: message", async (t) => {
  const f = await fakePaint(t);
  const items = [{ out: join(f.dir, "ok.jpg"), prompt: "fine" }, { out: join(f.dir, "bad.jpg"), prompt: "FAIL me" }];
  const manifest = join(f.dir, "f.json");
  writeFileSync(manifest, JSON.stringify(items));
  const r = await f.run([manifest]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}.*bad\.jpg {2}missing_image_result: no image/);
  assert.match(r.stdout, /失败 1 张/);
  assert.ok(!/object Object/.test(r.stdout + r.stderr));
  const rej = await f.run(["REJECT this", join(f.dir, "r.jpg")]);
  assert.equal(rej.status, 1);
  assert.match(rej.stderr, /paint job failed: rejected: HTTP 400 items\[0\]: bad size/);
});

test("单张 = 1 张的批次：saved / engine / job 三行", async (t) => {
  const f = await fakePaint(t);
  const out = join(f.dir, "one.png");
  const r = await f.run(["a cat", out, "--size", "1024x1536", "--group", "g", "--transparent"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.posts[0].items.length, 1);
  assert.equal(f.posts[0].items[0].transparent, true);
  assert.equal(f.posts[0].items[0].format, "png");
  assert.equal(f.posts[0].group, "g");
  assert.match(r.stdout, /saved: .*one\.png\nresult_url: http:\/\/127\.0\.0\.1:\d+\/results\/b_1-0\.jpg\nengine: codex \(gpt-6-astra\)\njob: b_1-0/);
});

test("用法错：退出码 2；清单项缺 out / image 不存在 / out 重复都当场拒", async (t) => {
  const f = await fakePaint(t);
  assert.equal((await f.run([])).status, 2);
  assert.equal((await f.run(["only-prompt"])).status, 2);
  assert.equal((await f.run(["p", "o.jpg", "--bogus"])).status, 2);
  for (const bad of [[{ prompt: "x" }], [{ out: "a.jpg", prompt: "x", image: "/nope.png" }], [{ out: "a.jpg", prompt: "x" }, { out: "a.jpg", prompt: "y" }]]) {
    const m = join(f.dir, `bad${Math.random()}.json`);
    writeFileSync(m, JSON.stringify(bad));
    const r = await f.run([m]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /清单读不了/);
  }
  assert.equal(f.posts.length, 0);
});
