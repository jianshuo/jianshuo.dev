// 侧栏回看 engine-router 的书（2026-10-28）。钉的是：列表按调用方 token 去要、
// transcript 按本地镜像长度续取只追加新字节、router 那边文件被重写（offset 回 0）就整份重来。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "router-sess-"));
const sock = join(dir, "router.sock");
process.env.ROUTER_URL = `unix:${sock}`;
process.env.ROUTER_TOKEN = "tok-test-0123456789";
process.env.ROUTER_MIRROR_DIR = join(dir, "mirror");

let remote = '{"a":1}\n{"a":2}\n';
const seen = [];
const server = createServer((req, res) => {
  seen.push(req.url);
  assert.equal(req.headers.authorization, "Bearer tok-test-0123456789");
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/v1/runs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ runs: [{ run_id: "r_abcdefgh", status: "running", label: "写书 · 测试", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), sessions: [{ attempt: 1, engine: "kimi", account: "kimi-1", sessionId: "s-123456789" }] }] }));
  }
  const buf = Buffer.from(remote);
  let off = Number(u.searchParams.get("offset")) || 0;
  if (off > buf.length) off = 0;
  res.writeHead(200, { "X-Transcript-Offset": String(off), "X-Transcript-Size": String(buf.length) });
  res.end(buf.subarray(off));
});
await new Promise((r) => server.listen(sock, r));
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const { listRouterRuns, getRouterRun, syncTranscript, ROUTER_RUN_ID_RE } = await import("../dist/router-sessions.js");

test("列表 + 增量镜像 + 重写后整份重来", async () => {
  const runs = await listRouterRuns();
  assert.equal(runs[0].label, "写书 · 测试");
  assert.ok(await getRouterRun("r_abcdefgh"));
  assert.ok(ROUTER_RUN_ID_RE.test("r_28R_cMjisKuf") && !ROUTER_RUN_ID_RE.test("4021e239-5a93-4cd6-a053-18804942e56a"));

  const p = await syncTranscript("r_abcdefgh", 1);
  assert.equal(await readFile(p, "utf8"), remote);
  remote += '{"a":3}\n';
  await syncTranscript("r_abcdefgh", 1);
  assert.equal(await readFile(p, "utf8"), remote);
  assert.match(seen.at(-1), /offset=16$/, "第二次只要新增的字节");

  remote = '{"b":1}\n'; // router 那边变短了
  await syncTranscript("r_abcdefgh", 1);
  assert.equal(await readFile(p, "utf8"), remote);
});
