// HTTP 层：Unix socket 上起服务，用 client.ts 的 runTask 走一遍（顺带验证客户端）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const root = await mkdtemp(join(tmpdir(), "router-srv-"));
process.env.APP_ROOT = root;
process.env.STATE_DIR = join(root, "state");
process.env.WORK_ROOT = join(root, "work");
process.env.WORKDIR_ROOTS = join(root, "work");
process.env.CONFIG_PATH = join(root, "config.json");
process.env.SECRETS_PATH = join(root, ".env");
const SOCK = join(root, "router.sock");
const TOKEN = "tok-book-runner-0123456789";
await writeFile(process.env.CONFIG_PATH, JSON.stringify({ engines: { kimi: { accounts: [{ id: "kimi-1", key_env: "K" }] } } }));
await writeFile(process.env.SECRETS_PATH, `ROUTER_TOKENS=book-runner:${TOKEN},admin:tok-admin-0123456789abc\nK=kk\n`);

const { Pool } = await import("../src/pool.ts");
const { ThreadStore } = await import("../src/threads.ts");
const { Runs } = await import("../src/runs.ts");
const { createRouterServer, parseTokens } = await import("../src/server.ts");
const { runTask, getRun } = await import("../src/client.ts");
const { RUNS_DIR } = await import("../src/env.ts");

const pool = new Pool(process.env.CONFIG_PATH, process.env.SECRETS_PATH, join(root, "state", "pool.json"));
pool.probe = async () => undefined;
pool.selectState().usage["kimi/kimi-1"] = { used5h: 10, reset5h: Date.now() + 3600_000, used7d: 5, reset7d: Date.now() + 3 * 86400_000, healthy: true, probedAt: Date.now() };
const threads = new ThreadStore();
const runs = new Runs(pool, threads, {
  pidAlive: () => true,
  spawnRunner: (specPath) => {
    void (async () => {
      const spec = JSON.parse(await readFile(specPath, "utf8"));
      const ev = join(RUNS_DIR, `${spec.runId}.jsonl`);
      const { appendFile } = await import("node:fs/promises");
      await appendFile(ev, JSON.stringify({ ts: Date.now(), type: "text", text: "正在写第一章" }) + "\n");
      await new Promise((r) => setTimeout(r, 300));
      await writeFile(join(RUNS_DIR, `${spec.runId}.result-${spec.attempt}.json`), JSON.stringify({ ok: true, reply: "全书写完", error: "", sessionId: "s1" }));
    })();
    return 99;
  },
});
await runs.load();
runs.start();
const server = createRouterServer(pool, runs, threads);
await new Promise<void>((r) => server.listen(SOCK, r));
after(() => {
  runs.stop();
  server.close();
});

function raw(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: SOCK, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("parseTokens：名字:token，太短的 token 丢弃", () => {
  const m = parseTokens("a:0123456789abcdef,b:short,:x");
  assert.equal(m.get("0123456789abcdef"), "a");
  assert.equal(m.size, 1);
});

test("没有 token → 401；状态页不需要 token（Caddy basic_auth 守门）", async () => {
  assert.equal((await raw("GET", "/v1/status")).status, 401);
  assert.equal((await raw("GET", "/v1/status", { Authorization: "Bearer wrong-token-0123456789" })).status, 401);
  const page = await raw("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /Engine Router/);
  assert.match(page.body, /kimi-1/);
  assert.equal((await raw("GET", "/router/")).status, 200, "直连 socket 带 /router 前缀也行");
});

test("runTask：提交 → 跟随事件 → 拿到结果；thread 可查；别人看不到", async () => {
  const conn = { url: `unix:${SOCK}`, token: TOKEN };
  const seen: string[] = [];
  const out = await runTask({ prompt: "写一本书", task_class: "book" }, (ev) => seen.push(ev.type), conn);
  assert.equal(out.ok, true);
  assert.equal(out.reply, "全书写完");
  assert.ok(seen.includes("started") && seen.includes("text") && seen.includes("done"), seen.join(","));
  const t = await raw("GET", `/v1/threads/${out.thread_id}`, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(JSON.parse(t.body).turns[0].reply, "全书写完");
  const run = await getRun(out.run_id, conn);
  assert.equal(run.attempts[0].account, "kimi/kimi-1");
  // admin 能看，别的 token 不能
  assert.equal((await raw("GET", `/v1/runs/${out.run_id}`, { Authorization: "Bearer tok-admin-0123456789abc" })).status, 200);
});

test("SSE 从偏移续传：from=上次的 id 只拿到之后的事件", async () => {
  const conn = { url: `unix:${SOCK}`, token: TOKEN };
  const out = await runTask({ prompt: "再写一本" }, undefined, conn);
  const all = await raw("GET", `/v1/runs/${out.run_id}/events`, { Authorization: `Bearer ${TOKEN}` });
  const ids = [...all.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(ids.length >= 3);
  const tail = await raw("GET", `/v1/runs/${out.run_id}/events?from=${ids[1]}`, { Authorization: `Bearer ${TOKEN}` });
  const tailIds = [...tail.body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.deepEqual(tailIds, ids.slice(2));
});

test("干跑 /v1/select 返回选中账号和理由", async () => {
  const r = await new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: SOCK, path: "/v1/select", method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(JSON.parse(b)));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ prompt: "x" }));
  });
  assert.equal(r.pick.key, "kimi/kimi-1");
  assert.match(r.candidates[0].reason, /5h/);
});
