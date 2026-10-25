// 调度全流程：假 runner 按账号返回预设结果。覆盖成功、撞墙换账号、认输、幂等、
// 全满即失败、会话续接（1 档 / 3 档）、重启接手。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "router-"));
process.env.APP_ROOT = root;
process.env.STATE_DIR = join(root, "state");
process.env.WORK_ROOT = join(root, "work");
process.env.WORKDIR_ROOTS = join(root, "work");
process.env.CONFIG_PATH = join(root, "config.json");
process.env.SECRETS_PATH = join(root, ".env");

const { Pool } = await import("../src/pool.ts");
const { ThreadStore } = await import("../src/threads.ts");
const { Runs } = await import("../src/runs.ts");
const { RUNS_DIR } = await import("../src/env.ts");

const NOW = Date.now();
const fresh = (used5h: number, used7d = 5) => ({ used5h, reset5h: NOW + 3600_000, used7d, reset7d: NOW + 3.5 * 86400_000, healthy: true, probedAt: NOW });

before(async () => {
  await writeFile(
    process.env.CONFIG_PATH!,
    JSON.stringify({
      engines: {
        kimi: { accounts: [{ id: "kimi-1", key_env: "K" }] },
        codex: { accounts: [{ id: "codex-1", codex_home: "/nope" }] },
        claude: { accounts: [{ id: "claude-1", token_env: "C" }] },
      },
      policies: { default: { engines: "failover", keys: "headroom", order: ["kimi", "codex", "claude"] } },
    }),
  );
});

type Behavior = (spec: any) => { ok: boolean; reply?: string; error?: string; sessionId?: string };

function setup(behavior: Behavior) {
  const pool = new Pool(process.env.CONFIG_PATH!, process.env.SECRETS_PATH!, join(root, "state", "pool.json"));
  pool.probe = async () => undefined; // 测试里不发真请求
  const st = pool.selectState();
  for (const k of Object.keys(st.cooldown)) delete st.cooldown[k]; // 别继承上一个测试落盘的冷却
  st.usage["kimi/kimi-1"] = fresh(10);
  st.usage["codex/codex-1"] = fresh(20);
  st.usage["claude/claude-1"] = fresh(30);
  const specs: any[] = [];
  let pid = 1000;
  const runs = new Runs(pool, new ThreadStore(), {
    pidAlive: () => true,
    spawnRunner: (specPath) => {
      void (async () => {
        const spec = JSON.parse(await readFile(specPath, "utf8"));
        specs.push(spec);
        const b = behavior(spec);
        await new Promise((r) => setTimeout(r, 20));
        await writeFile(join(RUNS_DIR, `${spec.runId}.result-${spec.attempt}.json`), JSON.stringify({ reply: "", error: "", sessionId: `s-${spec.engine}-${spec.attempt}`, ...b }));
      })();
      return ++pid;
    },
  });
  return { pool, runs, specs };
}

async function until(runs: any, id: string, statuses = ["done", "failed", "cancelled"]) {
  for (let i = 0; i < 200; i++) {
    await runs.watch();
    const r = runs.get(id);
    if (statuses.includes(r.status)) return r;
    await new Promise((x) => setTimeout(x, 20));
  }
  throw new Error("timeout: " + runs.get(id)?.status);
}

test("成功：failover 选 kimi，结果回到 run，事件文件有 started/done", async () => {
  const { runs, specs } = setup(() => ({ ok: true, reply: "写好了" }));
  await runs.load();
  const { run } = await runs.submit({ prompt: "写一本书", task_class: "book" }, "book-runner");
  const r = await until(runs, run.id);
  assert.equal(r.status, "done");
  assert.equal(r.reply, "写好了");
  assert.equal(specs[0].engine, "kimi");
  assert.equal(specs[0].model, "k3");
  const ev = (await readFile(join(RUNS_DIR, run.id + ".jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
  assert.deepEqual(ev, ["queued", "started", "done"]);
});

test("撞墙换账号：kimi 403 配额 → 冷却 kimi、换 codex 写完；续跑 prompt 带提示", async () => {
  const { runs, specs, pool } = setup((s) =>
    s.engine === "kimi" ? { ok: false, error: "Failed to authenticate. API Error: 403 You've reached your 5-hour usage limit." } : { ok: true, reply: "codex 写完" },
  );
  const { run } = await runs.submit({ prompt: "写书" }, "book-runner");
  const r = await until(runs, run.id);
  assert.equal(r.status, "done");
  assert.deepEqual(specs.map((s) => s.engine), ["kimi", "codex"]);
  assert.match(specs[1].prompt, /上一次尝试因引擎额度或凭据问题中断/);
  assert.ok(pool.cooldownUntil("kimi/kimi-1") > Date.now(), "kimi 进冷却");
  const ev = (await readFile(join(RUNS_DIR, run.id + ".jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
  assert.ok(ev.includes("switched"));
  pool.setCooldown("kimi/kimi-1", 0);
});

test("不是配额/凭据问题（撞轮数）→ 认输，不换账号", async () => {
  const { runs, specs } = setup(() => ({ ok: false, error: "error_max_turns" }));
  const { run } = await runs.submit({ prompt: "x" }, "c");
  const r = await until(runs, run.id);
  assert.equal(r.status, "failed");
  assert.equal(specs.length, 1);
});

test("三个账号都撞墙 + on_exhausted=fail → failed，带最后一个错误", async () => {
  const { runs, specs, pool } = setup(() => ({ ok: false, error: "429 Too Many Requests" }));
  const { run } = await runs.submit({ prompt: "x", on_exhausted: "fail" }, "c");
  const r = await until(runs, run.id);
  assert.equal(r.status, "failed");
  assert.equal(specs.length, 3);
  assert.match(r.error, /all accounts tried; last error: 429/);
  for (const k of ["kimi/kimi-1", "codex/codex-1", "claude/claude-1"]) pool.setCooldown(k, 0);
});

test("三个账号都撞墙（缺省排队）→ 不判失败，排队等最早的冷却结束（审查 #5）", async () => {
  const { runs, specs, pool } = setup(() => ({ ok: false, error: "You've reached your 5-hour usage limit" }));
  const { run } = await runs.submit({ prompt: "x" }, "c");
  // 中途会 running → queued → running 好几次；等三个账号都试过、且最后一次也收完尾
  for (let i = 0; i < 200; i++) {
    await runs.watch();
    const cur = runs.get(run.id)!;
    if (specs.length >= 3 && cur.status !== "running") break;
    await new Promise((y) => setTimeout(y, 20));
  }
  await new Promise((y) => setTimeout(y, 50));
  const r = runs.get(run.id)!;
  assert.equal(specs.length, 3);
  assert.equal(r.status, "queued");
  assert.deepEqual(r.tried, [], "额度问题不进永久排除名单");
  assert.ok(r.eta && r.eta > Date.now(), "有预计开始时间");
  await runs.cancel(run.id);
  for (const k of ["kimi/kimi-1", "codex/codex-1", "claude/claude-1"]) pool.setCooldown(k, 0);
});

test("内容拒答 → 换别家，但不冷却拒答的那家", async () => {
  const { runs, specs, pool } = setup((s) =>
    s.engine === "kimi" ? { ok: false, error: "400 high risk" } : { ok: true, reply: "ok" },
  );
  const { run } = await runs.submit({ prompt: "李登辉" }, "c");
  assert.equal((await until(runs, run.id)).status, "done");
  assert.deepEqual(specs.map((s) => s.engine), ["kimi", "codex"]);
  assert.equal(pool.cooldownUntil("kimi/kimi-1"), 0);
});

test("幂等：同一调用方同一 key 不跑第二份", async () => {
  const { runs, specs } = setup(() => ({ ok: true, reply: "ok" }));
  const a = await runs.submit({ prompt: "x", idempotency_key: "job-1" }, "c");
  const b = await runs.submit({ prompt: "x", idempotency_key: "job-1" }, "c");
  assert.equal(b.existing, true);
  assert.equal(a.run.id, b.run.id);
  await until(runs, a.run.id);
  assert.equal(specs.length, 1);
});

test("全满 + on_exhausted=fail → 立刻失败；默认排队并给出 ETA", async () => {
  const { runs, pool } = setup(() => ({ ok: true }));
  const st = pool.selectState();
  for (const k of ["kimi/kimi-1", "codex/codex-1", "claude/claude-1"]) st.usage[k] = fresh(84);
  const f = await runs.submit({ prompt: "x", on_exhausted: "fail" }, "c");
  assert.equal((await until(runs, f.run.id)).status, "failed");
  const q = await runs.submit({ prompt: "x" }, "c");
  await new Promise((x) => setTimeout(x, 50));
  const r = runs.get(q.run.id)!;
  assert.equal(r.status, "queued");
  assert.match(r.queuedReason!, /cap 85/);
  assert.ok(r.eta! > Date.now());
  await runs.cancel(q.run.id);
  assert.equal(runs.get(q.run.id)!.status, "cancelled");
});

test("会话：第二轮粘在原账号并 resume（1 档）；原账号满了换家族外 → 交接记录（3 档）", async () => {
  const { runs, specs, pool } = setup((s) => ({ ok: true, reply: `答复${s.attempt}-${s.engine}` }));
  const r1 = await runs.submit({ prompt: "第一轮" }, "chat");
  await until(runs, r1.run.id);
  const tid = r1.run.threadId;
  const r2 = await runs.submit({ prompt: "第二轮", thread_id: tid }, "chat");
  await until(runs, r2.run.id);
  assert.equal(specs[1].engine, "kimi");
  assert.equal(specs[1].resumeSession, "s-kimi-1", "1 档：原账号原会话");
  pool.selectState().usage["kimi/kimi-1"] = fresh(84);
  const r3 = await runs.submit({ prompt: "第三轮", thread_id: tid }, "chat");
  await until(runs, r3.run.id);
  assert.equal(specs[2].engine, "codex");
  assert.equal(specs[2].resumeSession, undefined);
  assert.match(specs[2].prompt, /交接记录[\s\S]*第一轮[\s\S]*第二轮[\s\S]*本轮请求[\s\S]*第三轮/);
  // strict：原账号（第三轮之后是 codex）满了就排队，不交接给别家
  pool.selectState().usage["codex/codex-1"] = fresh(84);
  const r4 = await runs.submit({ prompt: "第四轮", thread_id: tid, continuity: "strict" }, "chat");
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(runs.get(r4.run.id)!.status, "queued");
  await runs.cancel(r4.run.id);
  // 别的调用方碰不了这个 thread
  await assert.rejects(runs.submit({ prompt: "x", thread_id: tid }, "other"), /another caller/);
  pool.selectState().usage["kimi/kimi-1"] = fresh(10);
  pool.selectState().usage["codex/codex-1"] = fresh(20);
});

test("router 重启：在跑的 run 从文件接手，预留重建，结果出来照常收尾", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { runs, pool } = setup(() => ({ ok: true, reply: "重启后收到" }));
  // 第一个进程：起跑但结果晚到
  const slow = new Runs(pool, new ThreadStore(), {
    pidAlive: () => true,
    spawnRunner: (specPath) => {
      void (async () => {
        await gate;
        const spec = JSON.parse(await readFile(specPath, "utf8"));
        await writeFile(join(RUNS_DIR, `${spec.runId}.result-${spec.attempt}.json`), JSON.stringify({ ok: true, reply: "重启后收到", error: "", sessionId: "s" }));
      })();
      return 4242;
    },
  });
  const { run } = await slow.submit({ prompt: "x" }, "c");
  for (let i = 0; i < 50 && slow.get(run.id)!.status !== "running"; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal(slow.get(run.id)!.status, "running");
  // 「重启」：新的 Runs 从磁盘加载
  pool.inflight = {};
  const fresh2 = new Runs(pool, new ThreadStore(), { pidAlive: () => true, spawnRunner: () => 1 });
  await fresh2.load();
  assert.equal(pool.inflight["kimi/kimi-1"]?.count, 1, "预留从 running 的 run 重建");
  release();
  const r = await until(fresh2, run.id);
  assert.equal(r.status, "done");
  assert.equal(r.reply, "重启后收到");
  assert.equal(pool.inflight["kimi/kimi-1"]?.count, 0);
  void runs;
});

test("watch 防重入：runner 死了没结果，两轮 watch 重叠也只收尾一次（审查 #1）", async () => {
  const { pool } = setup(() => ({ ok: true }));
  let spawned = 0;
  const runs = new Runs(pool, new ThreadStore(), { pidAlive: () => false, spawnRunner: () => (spawned++, 777) });
  const { run } = await runs.submit({ prompt: "x" }, "c");
  for (let i = 0; i < 50 && runs.get(run.id)!.status !== "running"; i++) await new Promise((x) => setTimeout(x, 10));
  runs.get(run.id)!.attempts[0].startedAt -= 10_000; // 假装已经跑了 10 秒
  await Promise.all([runs.watch(), runs.watch()]); // 第一轮记下 deadSince
  runs.get(run.id)!.attempts[0].deadSince! -= 5000;
  await Promise.all([runs.watch(), runs.watch(), runs.watch()]);
  const r = runs.get(run.id)!;
  assert.equal(r.status, "failed");
  assert.match(r.error!, /runner died/);
  assert.equal(spawned, 1, "没有被重复收尾、也没有多起 runner");
  const done = (await readFile(join(RUNS_DIR, run.id + ".jsonl"), "utf8")).split("\n").filter((l) => l.includes('"done"'));
  assert.equal(done.length, 1);
  assert.equal(pool.inflight["kimi/kimi-1"]?.count ?? 0, 0);
});

test("先 cancel 后出结果：状态保持 cancelled，预留只释放一次，会话号照记（审查 #2/#3）", async () => {
  const { pool } = setup(() => ({ ok: true }));
  const runs = new Runs(pool, new ThreadStore(), { pidAlive: () => true, spawnRunner: () => 888 });
  // 另一个在跑的 run 占着同一个账号的预留，用来发现「多扣一次」
  pool.inflight["kimi/kimi-1"] = { count: 0, d5h: 0, d7d: 0 };
  const { run } = await runs.submit({ prompt: "x" }, "c");
  for (let i = 0; i < 50 && runs.get(run.id)!.status !== "running"; i++) await new Promise((x) => setTimeout(x, 10));
  pool.inflight["kimi/kimi-1"].d5h += 7; // 别人的预留
  await runs.cancel(run.id);
  await writeFile(join(RUNS_DIR, `${run.id}.result-1.json`), JSON.stringify({ ok: true, reply: "晚到的结果", error: "", sessionId: "late" }));
  await runs.watch();
  const r = runs.get(run.id)!;
  assert.equal(r.status, "cancelled");
  assert.equal(r.reply, undefined);
  assert.equal(pool.inflight["kimi/kimi-1"].d5h, 7, "别人的预留没被多扣");
  assert.equal(pool.inflight["kimi/kimi-1"].count, 0);
});

test("排队中被 cancel：pump 不会再把它起跑（审查 #2）", async () => {
  const { runs, specs, pool } = setup(() => ({ ok: true, reply: "x" }));
  const st = pool.selectState();
  for (const k of ["kimi/kimi-1", "codex/codex-1", "claude/claude-1"]) st.usage[k] = fresh(84);
  const { run } = await runs.submit({ prompt: "x" }, "c");
  await new Promise((x) => setTimeout(x, 30));
  await runs.cancel(run.id);
  for (const k of ["kimi/kimi-1", "codex/codex-1", "claude/claude-1"]) st.usage[k] = fresh(10);
  runs.pump();
  await new Promise((x) => setTimeout(x, 80));
  assert.equal(runs.get(run.id)!.status, "cancelled");
  assert.equal(specs.length, 0);
});

test("干跑：不推进 round_robin 游标；别人的 thread 返回 404（审查 #8）", async () => {
  const { runs, pool } = setup(() => ({ ok: true, reply: "ok" }));
  pool.cfg.policies.rr = { engines: "round_robin", keys: "round_robin" };
  const before = JSON.stringify(pool.selectState().cursors);
  for (let i = 0; i < 3; i++) await runs.dryRun({ prompt: "x", task_class: "rr" }, "c");
  assert.equal(JSON.stringify(pool.selectState().cursors), before);
  const { run } = await runs.submit({ prompt: "x" }, "owner");
  await until(runs, run.id);
  await assert.rejects(runs.dryRun({ prompt: "x", thread_id: run.threadId }, "intruder"), /thread not found/);
  assert.ok(await runs.dryRun({ prompt: "x", thread_id: run.threadId }, "owner"));
  delete pool.cfg.policies.rr;
});

test("路径与 env 校验：context_dirs 走白名单，router 自己的目录不行，work/ 根不行，HOME/NODE_OPTIONS 不行（审查 #4/#10）", async () => {
  const { runs } = setup(() => ({ ok: true }));
  await assert.rejects(runs.submit({ prompt: "x", context_dirs: [root] }, "c"), /not allowed/);
  await assert.rejects(runs.submit({ prompt: "x", context_dirs: [join(root, "state")] }, "c"), /not allowed/);
  await assert.rejects(runs.submit({ prompt: "x", context_dirs: ["/etc"] }, "c"), /must be under/);
  await assert.rejects(runs.submit({ prompt: "x", workdir: join(root, "work") }, "c"), /not allowed/);
  for (const k of ["HOME", "PATH", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR", "LD_PRELOAD", "XDG_CONFIG_HOME"])
    await assert.rejects(runs.submit({ prompt: "x", env: { [k]: "/tmp/x" } }, "c"), /not allowed/, k);
  const ok = await runs.submit({ prompt: "x", env: { PAINT_API_TOKEN: "t" }, workdir: join(root, "work", "book-1"), context_dirs: [join(root, "work", "skills")] }, "c");
  assert.equal(ok.run.req.env.PAINT_API_TOKEN, "t");
  await runs.cancel(ok.run.id);
});

test("请求校验：workdir 必须在白名单根下；不许注入凭据类 env；image 尚未实现", async () => {
  const { runs } = setup(() => ({ ok: true }));
  await assert.rejects(runs.submit({ prompt: "x", workdir: "/etc" }, "c"), /workdir must be under/);
  await assert.rejects(runs.submit({ prompt: "x", env: { ANTHROPIC_API_KEY: "k" } }, "c"), /not allowed/);
  await assert.rejects(runs.submit({ prompt: "x", kind: "image" }, "c"), /not implemented/);
  await assert.rejects(runs.submit({ prompt: "" }, "c"), /prompt required/);
});
