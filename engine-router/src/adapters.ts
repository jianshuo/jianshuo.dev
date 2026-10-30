// src/adapters.ts — 引擎适配层：把一次 attempt 交给具体引擎跑完，抹平三家的差异。
// 从 claude-agent/src/book-engine.ts 的 runClaudeExec / runCodexExec 通用化而来
// （两边的坑都带过来了，见各处注释）。只在 runner 进程里用。
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Account } from "./config.js";
import { apiErrorFromMessage, classifyResult } from "./legs.js";
import { codexAccessToken } from "./codex-auth.js";
import { CODEX_BIN, HOME, RUNS_DIR } from "./env.js";
import type { AttemptResult, AttemptSpec, RunEvent } from "./spec.js";

export type Emit = (ev: RunEvent) => void;

// Codex 是单代理循环，没有子代理和 Workflow：通用的能力垫片（任务相关的说明由调用方
// 放在 instructions 里，比如写书的 CODEX_BOOK_PREAMBLE）。
const CODEX_SHIM = "（运行环境说明：你是单代理，没有并行子代理、没有 Workflow；任务里要求并行或派子代理的步骤，由你自己按顺序完成。）";

const short = (s: unknown, n = 160) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

// ── Claude 系：订阅（claude）或 Anthropic 兼容端点（kimi）都走 Claude Code CLI ──
export async function runClaude(spec: AttemptSpec, account: Account, secrets: Record<string, string>, emit: Emit): Promise<AttemptResult> {
  await mkdir(spec.cwd, { recursive: true });
  // auto-memory 隔离：每个 thread 一个独立 cwd = 独立 Claude Code 项目；每次开跑前清掉
  // 它的 memory。workdir 当 cwd 的话，那个项目积累的记忆会自动注入请求——2026-08-24
  // Kimi 400 high risk 就是这么来的（记忆里有书的内容）。
  const memDir = join(HOME, ".claude", "projects", spec.cwd.replace(/\//g, "-"), "memory");
  await rm(memDir, { recursive: true, force: true }).catch(() => {});

  // 调用方的 env 先铺、router 自己的进程环境后盖：HOME/PATH 这类关键变量调用方改不了
  // （runs.ts 的 ENV_DENY 已经拦过一道，这里是第二道）。
  const env: Record<string, string | undefined> = { ...spec.env, ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (spec.engine === "kimi") {
    env.ANTHROPIC_BASE_URL = account.base_url ?? "https://api.kimi.com/coding/";
    env.ANTHROPIC_API_KEY = secrets[account.key_env ?? ""] ?? "";
    // 第三方端点只认自家模型名：Claude Code 内部各档位（含子任务的 haiku 档）全映射到同一个。
    for (const k of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ])
      env[k] = spec.model;
    // behavesAs 会把 max_tokens 从 32000 抬到 64000，钉回 Kimi 的上限（账号 env 仍可覆盖）
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "32000";
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = secrets[account.token_env ?? ""] ?? "";
  }
  Object.assign(env, account.env ?? {}); // 账号级配置最后盖（router 自己的配置，可信）

  const append =
    (spec.instructions ? spec.instructions + "\n\n" : "") +
    `你的当前目录只是落脚点；真正的工作目录是 ${spec.workdir}，读写文件一律用绝对路径。` +
    (spec.contextDirs.length ? `\n参考资料目录（只读）：${spec.contextDirs.join("、")}` : "");
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, spec.timeoutMs);
  timer.unref?.();

  const options: any = {
    cwd: spec.cwd,
    model: spec.model,
    maxTurns: spec.maxTurns,
    additionalDirectories: [spec.workdir, ...spec.contextDirs],
    systemPrompt: { type: "preset", preset: "claude_code", append },
    env,
    abortController: ac,
  };
  // 新版 Claude Code 不认识 k3 会往 stderr 刷 [claude-code:unrecognized_model]：behavesAs 指一个它认识的模型，
  // 发出去的模型名不变。opus-4-8 实测请求和「不认识」时几乎一样（同 beta、同 tools）；sonnet-4-6 会换掉整套 system prompt。
  if (spec.engine === "kimi") options.settings = { modelPicker: { options: [{ model: spec.model, behavesAs: "claude-opus-4-8" }] } };
  if (spec.capabilities.write === false || spec.capabilities.shell === false) {
    options.permissionMode = "default";
    options.disallowedTools = [
      ...(spec.capabilities.write === false ? ["Write", "Edit", "NotebookEdit"] : []),
      ...(spec.capabilities.shell === false ? ["Bash"] : []),
    ];
  } else {
    options.permissionMode = "bypassPermissions";
  }
  if (spec.capabilities.network === false) options.disallowedTools = [...(options.disallowedTools ?? []), "WebFetch", "WebSearch"];
  if (spec.resumeSession) options.resume = spec.resumeSession;
  if (spec.outputSchema) options.outputFormat = { type: "json_schema", schema: spec.outputSchema };

  let sessionId = spec.resumeSession ?? "";
  let ok = false;
  let reply = "";
  let error = "";
  let result: unknown;
  let lastApiError = "";
  try {
    for await (const msg of query({ prompt: spec.prompt, options }) as AsyncIterable<any>) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        sessionId = msg.session_id;
        emit({ type: "session", id: sessionId });
      }
      // SDK 把 401/403/429 当成 assistant 文本发下来、result.errors[] 为空（2026-10-01）
      const apiErr = apiErrorFromMessage(msg);
      if (apiErr) lastApiError = apiErr;
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const c of msg.message.content) {
          if (c?.type === "text" && c.text) emit({ type: "text", text: c.text });
          if (c?.type === "tool_use") emit({ type: "tool", name: c.name, summary: short(c.input) });
        }
      }
      if (msg.type === "result") {
        reply = typeof msg.result === "string" ? msg.result : "";
        if (msg.structured_output !== undefined) result = msg.structured_output;
        ({ ok, error } = classifyResult(msg, lastApiError));
      }
    }
  } catch (e: any) {
    // 别覆盖已识别的具体错误：SDK 常在 result 之后再抛笼统的「exited with code 1」（2026-09-02）
    if (!error) error = String(e?.message ?? e);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    ok = false;
    error = `timeout after ${Math.round(spec.timeoutMs / 60000)} min`;
  }
  return { ok, reply, error: ok ? "" : error || "no result", sessionId, result };
}

// ── Codex：codex exec --json（续接用 exec resume）──────────────────────────
export async function runCodex(spec: AttemptSpec, account: Account, emit: Emit): Promise<AttemptResult> {
  const codexHome = account.codex_home!;
  // 开跑前把 token 刷新好（加锁，见 codex-auth.ts）：之后 3 小时内 CLI 不需要自己刷，
  // 避免 CLI 和 monitor 拿同一个 refresh token 各刷一次互踢。
  try {
    await codexAccessToken(codexHome);
  } catch (e: any) {
    return { ok: false, reply: "", error: String(e?.message ?? e), sessionId: "" };
  }
  // read-only：不能写也不能联网；workspace-write：只能写 workdir、默认断网；其余全开。
  // shell:false 的任务挑选器根本不会派给 codex（selector.ts capabilityGap）。
  const sandbox =
    spec.capabilities.write === false ? "read-only" : spec.capabilities.network === false ? "workspace-write" : "danger-full-access";
  // exec 级参数紧跟 exec、在 resume 子命令之前；--skip-git-repo-check 必带（workdir 多半不是 git 仓库）；
  // stdin 必须 ignore（否则等 EOF 挂住）。
  const args = ["exec", "--json", "-s", sandbox, "-C", spec.workdir, "--skip-git-repo-check"];
  if (spec.model) args.push("-m", spec.model);
  if (spec.outputSchema) {
    const f = join(RUNS_DIR, `${spec.runId}.schema-${spec.attempt}.json`);
    await writeFile(f, JSON.stringify(spec.outputSchema));
    args.push("--output-schema", f);
  }
  let prompt = spec.prompt;
  if (spec.firstTurn) {
    const ctx = spec.contextDirs.length ? `参考资料目录（只读）：${spec.contextDirs.join("、")}` : "";
    prompt = [CODEX_SHIM, spec.instructions, ctx, prompt].filter(Boolean).join("\n\n");
  }
  if (spec.resumeSession) args.push("resume", spec.resumeSession);
  args.push(prompt);

  return new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: spec.workdir,
      env: { ...spec.env, ...process.env, ...(account.env ?? {}), CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sessionId = spec.resumeSession ?? "";
    let reply = "";
    let error = "";
    let stderrTail = "";
    let buf = "";
    const timer = setTimeout(() => {
      error = error || `timeout after ${Math.round(spec.timeoutMs / 60000)} min`;
      child.kill("SIGKILL");
    }, spec.timeoutMs);
    timer.unref?.();
    // utf8 解码再拼：裸 Buffer 拼接会把分块边界上的汉字切成 U+FFFD
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const type = String(ev?.type ?? "");
        const tid = ev?.thread_id ?? ev?.session_id;
        if (tid && (type === "thread.started" || type === "session.created") && tid !== sessionId) {
          sessionId = String(tid);
          emit({ type: "session", id: sessionId });
        }
        if (type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
          reply = String(ev.item.text);
          emit({ type: "text", text: reply });
        }
        if (type === "item.completed" && ev.item?.type === "command_execution")
          emit({ type: "tool", name: "shell", summary: short(ev.item.command) });
        if (type === "item.completed" && ev.item?.type === "file_change")
          emit({ type: "tool", name: "edit", summary: short(ev.item.changes?.map?.((c: any) => c.path) ?? "") });
        if (type === "turn.failed" || type === "error") error = String(ev?.error?.message ?? ev?.message ?? "turn failed");
      }
    });
    child.stderr.on("data", (c: string) => {
      stderrTail = (stderrTail + c).slice(-2000);
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ ok: false, reply, error: String(e?.message ?? e), sessionId });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && !!reply;
      let result: unknown;
      if (ok && spec.outputSchema) {
        try {
          result = JSON.parse(reply);
        } catch {}
      }
      resolve({ ok, reply, error: ok ? "" : error || stderrTail.trim() || `codex exit ${code}`, sessionId, result });
    });
  });
}
