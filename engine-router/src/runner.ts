// src/runner.ts — 一次 attempt 一个进程：node dist/runner.js <attempt.json>
//
// server 起它时 detached，unit 里 KillMode=process：router 重启（发版）不杀正在跑的
// runner，跑完照样把结果写进文件，新起的 server 靠轮询结果文件接手（runs.ts）。
import { readFile, writeFile, rename, appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, loadSecrets } from "./config.js";
import { CONFIG_PATH, RUNS_DIR, SECRETS_PATH, TMP_ROOT } from "./env.js";
import { runClaude, runCodex } from "./adapters.js";
import type { AttemptResult, AttemptSpec, RunEvent } from "./spec.js";

const MAX_TEXT = 8000;

async function main() {
  const spec: AttemptSpec = JSON.parse(await readFile(process.argv[2], "utf8"));
  const events = join(RUNS_DIR, `${spec.runId}.jsonl`);
  const emit = (ev: RunEvent) => {
    if (ev.type === "text" && ev.text.length > MAX_TEXT) ev = { ...ev, text: ev.text.slice(0, MAX_TEXT) + "…" };
    void appendFile(events, JSON.stringify({ ts: Date.now(), attempt: spec.attempt, ...ev }) + "\n").catch(() => {});
  };
  const cfg = loadConfig(CONFIG_PATH);
  const secrets = loadSecrets(SECRETS_PATH);
  const account = cfg.engines[spec.engine]?.accounts.find((a) => a.id === spec.accountId);

  // 临时目录放在 state/ 下、活过 router 重启（为什么不用 /tmp 见 env.ts TMP_ROOT）。
  // 写进本进程的环境：两个适配器都把 process.env 铺在调用方 env 之后，引擎都会继承。
  const tmp = join(TMP_ROOT, `${spec.runId}-${spec.attempt}`);
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = process.env.CLAUDE_CODE_TMPDIR = tmp;

  let res: AttemptResult;
  try {
    if (!account) res = { ok: false, reply: "", error: `account ${spec.engine}/${spec.accountId} not in config`, sessionId: "" };
    else if (spec.engine === "codex") res = await runCodex(spec, account, emit);
    else if (spec.engine === "claude" || spec.engine === "kimi") res = await runClaude(spec, account, secrets, emit);
    else res = { ok: false, reply: "", error: `engine ${spec.engine} not implemented yet`, sessionId: "" };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`[runner] ${spec.runId}#${spec.attempt} ${spec.engine}/${spec.accountId} ok=${res.ok}${res.ok ? "" : " error=" + res.error.slice(0, 200)}`);
  const out = join(RUNS_DIR, `${spec.runId}.result-${spec.attempt}.json`);
  await writeFile(out + ".tmp", JSON.stringify(res));
  await rename(out + ".tmp", out);
}

main().then(
  () => process.exit(0),
  async (e) => {
    console.error("[runner] crashed", e);
    try {
      const spec = JSON.parse(await readFile(process.argv[2], "utf8"));
      const out = join(RUNS_DIR, `${spec.runId}.result-${spec.attempt}.json`);
      await writeFile(out, JSON.stringify({ ok: false, reply: "", error: `runner crashed: ${e?.message ?? e}`, sessionId: "" }));
    } catch {}
    process.exit(1);
  },
);
