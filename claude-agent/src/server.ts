/**
 * Claude Agent SDK — persistent web-chat backend.
 *
 * A tiny dependency-free HTTP server that runs the Claude Code agent loop via
 * `query()` and streams its events to the browser over SSE. Auth (a single
 * password) is handled by the Caddy reverse proxy in front of this; the server
 * itself only listens on localhost and trusts Caddy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseLegs, availableLegs, shouldTryNextLeg, type BookLeg } from "./book-legs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const WORKSPACE = process.env.WORKSPACE ?? join(__dirname, "..", "workspace");
const MODEL = process.env.MODEL ?? "claude-opus-4-8";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 100);
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS ?? 2);
const MAX_RESULT_CHARS = 8000;

// The SDK persists each conversation as <session_id>.jsonl under HOME/.claude/projects/<cwd-slug>/.
const PROJECTS_DIR = join(process.env.HOME ?? homedir(), ".claude", "projects");
const SESSION_ID_RE = /^[a-f0-9-]{36}$/;

// 写书引擎（codex）的独立凭据链与会话目录——声明放这里是因为下面的会话列表也要读它。
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_HOME = process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), ".codex");

const INDEX_HTML = await readFile(join(__dirname, "..", "public", "index.html"), "utf8");

// A persistent service must survive a single bad query. The SDK fires internal
// promises we don't directly await; if one rejects after a request ends, log it
// instead of letting it take down the whole server.
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

function sse(res: ServerResponse, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function renderToolResult(content: any): string {
  let out: string;
  if (typeof content === "string") out = content;
  else if (Array.isArray(content))
    out = content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : JSON.stringify(b)))
      .join("\n");
  else out = content == null ? "" : JSON.stringify(content);
  return out.length > MAX_RESULT_CHARS ? out.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]" : out;
}

// --- session history (read the SDK's on-disk transcripts) ---

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((b) => b?.type === "text").map((b) => b.text).join("");
  return "";
}

function isToolResult(content: any): boolean {
  return Array.isArray(content) && content.some((b) => b?.type === "tool_result");
}

async function findTranscript(id: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, id + ".jsonl");
    try {
      await stat(p);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// 大文件防线（2026-08-23）：一个 121MB 的 codex rollout 曾把旧的「readFile 整读 +
// split("\n")」打爆 node 堆（FATAL heap OOM → core-dump → systemd 重启 → 连带杀死
// 正在跑的写书 codex 子进程，嘟嘟和小考拉那单就是这么死的）。所有 jsonl 读取一律
// 流式逐行：内存占用与文件大小无关；单行超 2MB 丢弃（超大 tool 输出，渲染不了）。
async function* jsonlLines(path: string, maxLineChars = 2 * 1024 * 1024): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  let carry = "";
  let dropping = false;
  for await (const chunk of stream as unknown as AsyncIterable<string>) {
    carry += chunk;
    let i: number;
    while ((i = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, i);
      carry = carry.slice(i + 1);
      if (dropping) { dropping = false; continue; } // 被丢弃超长行的尾巴
      if (line.trim() && line.length <= maxLineChars) yield line;
    }
    if (carry.length > maxLineChars) { carry = ""; dropping = true; }
  }
  if (!dropping && carry.trim() && carry.length <= maxLineChars) yield carry;
}
// 侧栏每次刷新都要扫全部会话文件——按 (mtime,size) 缓存摘要，扫描只花一次。
const summaryCache = new Map<string, { mtimeMs: number; size: number; value: any }>();

async function summarize(path: string, id: string) {
  const st = await stat(path);
  const hit = summaryCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
    return { ...hit.value, running: isRunning(id) };
  let title = "";
  let turns = 0;
  for await (const ln of jsonlLines(path)) {
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (o.type === "user" && !isToolResult(o.message?.content)) {
      const t = textOf(o.message?.content).trim();
      if (t) {
        turns++;
        if (!title) title = t;
      }
    }
  }
  const value = { id, title: title.slice(0, 80) || "(无标题)", updatedAt: st.mtimeMs, turns };
  summaryCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return { ...value, running: isRunning(id) };
}

async function listSessions() {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    dirs = [];
  }
  const out: any[] = [];
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = await readdir(join(PROJECTS_DIR, d));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        out.push(await summarize(join(PROJECTS_DIR, d, f), f.slice(0, -6)));
      } catch {
        /* skip unreadable */
      }
    }
  }
  for (const p of await listCodexRollouts()) {
    try {
      out.push(await summarizeCodex(p));
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

// --- codex（写书引擎）的会话：也能在侧栏列出、点开回看 ---
//
// codex exec 把每单完整过程落在 CODEX_HOME/sessions/YYYY/MM/DD/rollout-<时刻>-<线程号>.jsonl。
// 这里把它翻译成与 Claude transcript 相同的消息结构（user 气泡 + assistant 的
// text/tool 卡片），前端零改动。只读回看——续聊会被 /api/chat 拒绝（引擎不同）。
const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");

async function listCodexRollouts(): Promise<string[]> {
  const out: string[] = [];
  let years: string[];
  try {
    years = await readdir(CODEX_SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const y of years)
    for (const m of await readdir(join(CODEX_SESSIONS_DIR, y)).catch(() => [] as string[]))
      for (const f of await readdir(join(CODEX_SESSIONS_DIR, y, m)).catch(() => [] as string[])) {
        // 一层是天（目录），底下才是文件
        const day = join(CODEX_SESSIONS_DIR, y, m, f);
        for (const g of await readdir(day).catch(() => [] as string[]))
          if (g.endsWith(".jsonl")) out.push(join(day, g));
      }
  return out;
}

function codexIdOfPath(p: string): string {
  return p.slice(-42, -6); // rollout-<时刻>-<36位线程号>.jsonl
}

async function findCodexRollout(id: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  for (const p of await listCodexRollouts()) if (codexIdOfPath(p) === id) return p;
  return null;
}

// 侧栏摘要：标题取第一条 user_message；写书 prompt 前面是长长的引擎说明，
// 从「任务：」起才是人话——标题从那里截。
// 侧栏摘要的结构化解析：从写书/修书 prompt 提取「新写/修改 +《书名》+ 作者 +
// 内容一句」。书名：新写单拿 prompt 里的 jobId 反查工作目录 book.json；修书单
// 拿 slug 查 workspace/book-<slug>/book.json（查不到就退回 slug）。解析不出的
// 会话（非写书 prompt）返回 null，退回旧的「任务：」截断。
async function codexTaskTitle(t: string): Promise<string | null> {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const author = /署名「([^」]{1,20})」/.exec(t)?.[1] ?? "";
  const who = author ? ` · ${author}` : "";
  if (/任务：按 skill 的「修书模式」/.test(t)) {
    const slug = /slug：([a-z0-9-]+)/.exec(t)?.[1] ?? "";
    const instr = clean(/修改指令：\s*([\s\S]*?)(?:\n\s*\n|要求：|$)/.exec(t)?.[1] ?? "").slice(0, 30);
    let name = slug;
    if (slug) {
      try {
        name = String(JSON.parse(await readFile(join(WORKSPACE, `book-${slug}`, "book.json"), "utf8")).title || slug);
      } catch {}
    }
    return `修改《${name}》${who}${instr ? " · " + instr : ""}`;
  }
  if (/任务：写一本书/.test(t)) {
    const jobId = /jobId=「([0-9a-f-]{10,40})」/.exec(t)?.[1] ?? "";
    const seed = clean(/种子：\s*([\s\S]{1,160})/.exec(t)?.[1] ?? "").slice(0, 36);
    let name = "";
    if (jobId) {
      try {
        name = String((await findBookByJobId(jobId))?.book?.title ?? "");
      } catch {}
    }
    return `新写${name ? `《${name}》` : ""}${who}${seed ? " · " + seed : ""}`;
  }
  return null;
}

async function summarizeCodex(path: string) {
  const st = await stat(path);
  const hit = summaryCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let firstUser = "";
  let turns = 0;
  for await (const ln of jsonlLines(path)) {
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (o.type === "event_msg" && o.payload?.type === "user_message") {
      turns++;
      if (!firstUser) firstUser = String(o.payload.message ?? "").trim();
    }
  }
  let title = (await codexTaskTitle(firstUser)) ?? "";
  if (!title) {
    const i = firstUser.indexOf("任务：");
    title = i >= 0 ? firstUser.slice(i) : firstUser;
  }
  const value = {
    id: codexIdOfPath(path),
    title: "📖 " + (title.slice(0, 78) || "(无标题)"),
    updatedAt: st.mtimeMs,
    turns,
    running: false,
    engine: "codex",
  };
  summaryCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

// 回放：翻译成 getSessionMessages 一样的形状。文字走 event_msg（user_message/
// agent_message），工具卡片走 response_item（function_call/custom_tool_call/
// web_search_call），输出按 call_id 回填；reasoning 是加密的，跳过。
// 回看结果缓存（只留一份）：前端对「写书中」的 codex 会话每 12s 轮询跟进（tail -f），
// 文件没变时只 stat 不重扫——百 MB 级 rollout 重扫一次要数秒 CPU，别每次白花。
const codexMsgsCache = new Map<string, { mtimeMs: number; size: number; msgs: any[] }>();

async function getCodexSessionMessages(path: string) {
  const st = await stat(path);
  const hit = codexMsgsCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.msgs;
  const msgs: any[] = [];
  let cur: any = null;
  const toolIndex: Record<string, any> = {};
  const push = (item: any) => {
    if (!cur) {
      cur = { role: "assistant", items: [] };
      msgs.push(cur);
    }
    cur.items.push(item);
  };
  for await (const ln of jsonlLines(path)) {
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    const p = o.payload ?? {};
    if (o.type === "event_msg") {
      if (p.type === "user_message") {
        const t = String(p.message ?? "").trim();
        if (t) {
          msgs.push({ role: "user", text: t });
          cur = null;
        }
      } else if (p.type === "agent_message" && p.message) {
        push({ type: "text", text: String(p.message) });
      }
    } else if (o.type === "response_item") {
      if (p.type === "function_call") {
        let input: any = {};
        try {
          input = JSON.parse(p.arguments ?? "{}");
        } catch {
          input = { arguments: p.arguments };
        }
        const item = { type: "tool", id: p.call_id, name: p.name ?? "tool", input, result: null, isError: false };
        push(item);
        if (p.call_id) toolIndex[p.call_id] = item;
      } else if (p.type === "custom_tool_call") {
        const item = {
          type: "tool",
          id: p.call_id,
          name: p.name ?? "tool",
          input: { input: String(p.input ?? "") },
          result: null,
          isError: false,
        };
        push(item);
        if (p.call_id) toolIndex[p.call_id] = item;
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        if (p.call_id && toolIndex[p.call_id]) toolIndex[p.call_id].result = renderToolResult(p.output);
      } else if (p.type === "web_search_call") {
        push({
          type: "tool",
          id: p.id,
          name: "web_search",
          input: { query: p.action?.query ?? "" },
          result: String(p.status ?? ""),
          isError: false,
        });
      }
    }
  }
  codexMsgsCache.clear(); // 只留最新一份，防多会话轮流看时内存涨
  codexMsgsCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, msgs });
  return msgs;
}

// Replay a transcript into the same shape the live UI renders: one assistant
// bubble per human turn, with text + tool cards (results attached) interleaved.
async function getSessionMessages(id: string) {
  const path = await findTranscript(id);
  if (!path) {
    const cp = await findCodexRollout(id);
    return cp ? getCodexSessionMessages(cp) : null;
  }
  const msgs: any[] = [];
  let cur: any = null;
  const toolIndex: Record<string, any> = {};
  for await (const ln of jsonlLines(path)) {
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (o.type === "user") {
      const c = o.message?.content;
      if (isToolResult(c)) {
        for (const b of c)
          if (b.type === "tool_result" && toolIndex[b.tool_use_id]) {
            toolIndex[b.tool_use_id].result = renderToolResult(b.content);
            toolIndex[b.tool_use_id].isError = !!b.is_error;
          }
      } else {
        const t = textOf(c).trim();
        if (t) {
          msgs.push({ role: "user", text: t });
          cur = null;
        }
      }
    } else if (o.type === "assistant") {
      if (!cur) {
        cur = { role: "assistant", items: [] };
        msgs.push(cur);
      }
      for (const b of o.message?.content ?? []) {
        if (b.type === "text") cur.items.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          const item = { type: "tool", id: b.id, name: b.name, input: b.input, result: null, isError: false };
          cur.items.push(item);
          toolIndex[b.id] = item;
        }
      }
    }
  }
  return msgs;
}

// --- 写书 jobs (VoiceDrop app 实验功能「写书」) ---
//
// POST /api/book — fire-and-forget：验完 token 立刻 202，agent 在本进程后台跑完
// 整本书（skill 边写边发到 R2 books/，所以进程重启也只丢未过稿章节）。与 /api/chat
// 的「断线即中止」相反——app 提交完种子就可以关掉。
// 认证不走 Caddy basic_auth（Caddyfile 对此路径豁免）：客户端带 VoiceDrop 用户
// bearer（anon_*/session JWT），这里拿它去 jianshuo.dev whoami 验真——app 里零内置密钥。
//
// 引擎（2026-08-20 起）：写书/修书跑 OpenAI Codex CLI（`codex exec --json`，与
// codex.jianshuo.dev 同款，走 ChatGPT 订阅）——lab 网页聊天仍是 Claude，只有书换引擎。
// 凭据是 claude-agent 自己的独立登录链 CODEX_HOME=$HOME/.codex（沙箱可写区内；
// 绝不与 /opt/codex-agent 或 paint 共链——refresh token 轮换互踢，见记忆
// codex-subscription-auth-chains）。重登：
//   ssh root@VPS 'sudo -u claude-agent HOME=/opt/claude-agent codex login --device-auth'
const BOOK_CHARGE_URL = process.env.BOOK_CHARGE_URL ?? "https://jianshuo.dev/agent/usage/book-charge";
const BOOK_REFUND_URL = process.env.BOOK_REFUND_URL ?? "https://jianshuo.dev/agent/usage/book-refund";
const BOOK_PUSH_URL = process.env.BOOK_PUSH_URL ?? "https://jianshuo.dev/agent/push/book-done";
const ADMIN_PUSH_URL = process.env.ADMIN_PUSH_URL ?? "https://jianshuo.dev/agent/push/admin";
const BOOK_CODEX_MODEL = process.env.BOOK_CODEX_MODEL ?? ""; // 空 = 用该链 config.toml 的默认模型
const BOOK_TIMEOUT_MS = Number(process.env.BOOK_TIMEOUT_MS ?? 3 * 60 * 60 * 1000); // 兜底防挂死，写整本书要给足

// --- 写书引擎的凭据（三条腿共用这几个常量）---
// claude 腿不配 BOOK_ANTHROPIC_* 时吃 lab 自己的 Claude 订阅 OAuth；配了则按次
// 注入 ANTHROPIC_BASE_URL/API_KEY——Kimi 等 Anthropic 兼容端点（订阅/按量都行），
// 只作用于写书子进程，聊天路径的凭据与模型完全不受影响。
// 2026-09-02 起 BOOK_ENGINE 开关废除：改由 BOOK_LEGS 的降级链决定跑哪条腿。
const BOOK_CLAUDE_MODEL = process.env.BOOK_CLAUDE_MODEL || MODEL;
const BOOK_ANTHROPIC_BASE_URL = process.env.BOOK_ANTHROPIC_BASE_URL ?? "";
const BOOK_ANTHROPIC_API_KEY = process.env.BOOK_ANTHROPIC_API_KEY ?? "";
// 绘本最吃轮数：每页要「写字→评审→出图→验图」，14 页光页面就 50+ 轮，再加骨架、
// refs、封面、逐页 asset 上传，80 轮不够——2026-08-31《同一个月亮》就死在这儿
// （turns=81 error_max_turns：图全画完了，卡在还没上传，线上只有字没有图）。
const BOOK_MAX_TURNS = Number(process.env.BOOK_MAX_TURNS ?? 160); // 仅 claude 腿（codex 腿无轮数概念）
// claude 腿的 cwd：独立目录=独立 Claude Code 项目=零 auto-memory。不能用 WORKSPACE
// 当 cwd——那个项目积累的记忆笔记（含《江泽民传》等书的内容）会自动注入请求，
// Kimi 风控直接 400 high risk（2026-08-24 二分定位实锤）。书文件仍落 WORKSPACE
// （提示词里给绝对路径），本目录只是进程落脚点。
const BOOK_RUN_DIR = process.env.BOOK_RUN_DIR ?? join(__dirname, "..", "bookrun");

// 旧的「每 6 小时前 N 本走 Claude 订阅」取号机制已于 2026-09-02 被下面的三腿
// 降级链取代（bookrate.json 不再读写，可删）：取号是**开跑前**猜哪条腿有额度，
// 链是**倒下后**换一条还有额度的，后者不需要猜。

const SKILLS_DIR = join(process.env.HOME ?? homedir(), ".claude", "skills");

// codex 是单代理循环，没有 Claude 的 skill 装载/并行 subagent/Workflow——skill 里
// 这三样都要在 prompt 里翻译成「自己读文件 + 自己分步扮演角色」。
const CODEX_BOOK_PREAMBLE =
  `你是跑在服务器上的自动写书代理（可跑 bash、读写文件、联网）。\n` +
  `先完整阅读 ${SKILLS_DIR}/wjs-voicedrop-writing-book/SKILL.md 并严格照做；` +
  `按它第 0 步选定书的类型后，把对应写作 skill 的 SKILL.md（同在 ${SKILLS_DIR}/ 下）也完整读进来再动笔。\n` +
  `你没有并行子代理，也没有 Workflow——skill 里说 spawn 写手/评审 subagent 的地方，一律由你自己分步串行扮演：` +
  `写完一章，抛开写作时的思路，按该类型的评审维度独立重读打分并把意见落盘 reviews/NN.json；` +
  `不过就照 must_fix 重写（最多 3 轮），过审立刻 build.mjs done 发布，绝不攒到最后。\n` +
  `其余约定（工作目录、book.json、边写边发、断点续跑、封面用 /opt/claude-agent/bin/paint）一律照 skill 执行。`;

type CodexOutcome = { ok: boolean; threadId: string; reply: string; error: string };

// claude 腿：与 runCodexExec 同一契约。复用同一份写书 preamble（读 skill 文件、
// 串行扮演写手/评审，引擎无关），会话落 ~/.claude/projects（lab 侧栏可回看）。
// 2026-08-20 前的老实现的复活版 + 按次 env 注入（Kimi 兼容端点）。
async function runClaudeExec(
  prompt: string,
  onThread?: (id: string) => void,
  injectCompat = true, // false = 忽略 BOOK_ANTHROPIC_*，走 lab 自己的 Claude 订阅
): Promise<CodexOutcome> {
  await mkdir(BOOK_RUN_DIR, { recursive: true });
  // 每单清空本项目的 auto-memory：书的真源在 skill 与 _src，不需要跨单记忆；
  // 让它积累书内容迟早再次触发 Kimi 风控（workspace 项目就是前车之鉴）。
  const memDir = join(
    process.env.HOME ?? homedir(), ".claude", "projects", BOOK_RUN_DIR.replace(/\//g, "-"), "memory",
  );
  await rm(memDir, { recursive: true, force: true }).catch(() => {});
  // skill 里说的「工作目录 book-<slug>」按绝对路径落 WORKSPACE——cwd 只是落脚点。
  prompt = `${prompt}\n\n补充：你的当前目录不是书库根目录；skill 里说的「工作目录 book-<slug>」一律用绝对路径 ${WORKSPACE}/book-<slug>。`;
  const env: Record<string, string | undefined> = { ...process.env };
  // 兼容端点在配且本单被指派 → 注入；否则模型退回 lab 默认（订阅端点不认 k3 这类第三方名）。
  const useCompat = Boolean(BOOK_ANTHROPIC_BASE_URL) && injectCompat;
  const model = useCompat ? BOOK_CLAUDE_MODEL : MODEL;
  if (useCompat) {
    env.ANTHROPIC_BASE_URL = BOOK_ANTHROPIC_BASE_URL;
    env.ANTHROPIC_API_KEY = BOOK_ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // 订阅 token 在场会抢道，明确让位给兼容端点
    // 第三方端点只认自家模型名：把 Claude Code 内部各档位（含子任务的 haiku 档）
    // 全部映射到同一个模型，否则内部小任务会拿 claude-* 模型名打 Kimi 端点报错。
    env.ANTHROPIC_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = BOOK_CLAUDE_MODEL;
    env.CLAUDE_CODE_SUBAGENT_MODEL = BOOK_CLAUDE_MODEL;
    env.CLAUDE_CODE_EFFORT_LEVEL = process.env.BOOK_CLAUDE_EFFORT ?? "high";
    if (process.env.BOOK_CLAUDE_CONTEXT) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.BOOK_CLAUDE_CONTEXT;
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = process.env.BOOK_CLAUDE_CONTEXT;
    }
  }
  const q = query({
    prompt,
    options: {
      cwd: BOOK_RUN_DIR,
      model,
      maxTurns: BOOK_MAX_TURNS,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
      env,
    },
  });
  let threadId = "";
  let ok = false;
  let reply = "";
  let error = "";
  try {
    for await (const msg of q as AsyncIterable<any>) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        threadId = msg.session_id;
        onThread?.(threadId);
      }
      if (msg.type === "result") {
        ok = msg.subtype === "success";
        reply = typeof msg.result === "string" ? msg.result : "";
        // CLI 正常退出但第一轮就是 API 错误（401/无效 key 等）时 subtype 仍是
        // success——按文本识别，别把认证失败当成书写完了（2026-08-24 自检踩到）。
        if (ok && /Failed to authenticate|API Error: \d{3}/i.test(reply.slice(0, 300))) {
          ok = false;
          error = reply.slice(0, 200);
        }
        if (!ok && !error) error = String(msg.subtype ?? "error");
        console.log(
          `[book] claude-engine done model=${model} compat=${useCompat} turns=${msg.num_turns} cost=${msg.total_cost_usd ?? "-"}` +
            (ok ? "" : ` ERROR=${error}`),
        );
      }
    }
  } catch (e: any) {
    // 别覆盖已经识别出的具体错误。SDK 常在 result 之后再抛一个笼统的
    // 「process exited with code 1」——2026-09-02 的日志里配额 403 就是这样被
    // 盖成通用消息的，换腿判别会因此瞎掉（shouldTryNextLeg 认不出没有配额字样的串）。
    if (!error) error = String(e?.message ?? e);
  }
  return { ok, threadId, reply, error: ok ? "" : error || "no result" };
}

// --- 引擎分发：三条腿的降级链（2026-09-02）---------------------------------
//
// 顺序 kimi → codex → claude（BOOK_LEGS 可改）。跑倒一条腿就问一句「是配额满了
// 还是书写坏了」：配额满 → 换下一条腿重跑；书写坏了（撞轮数、崩溃、超时、风控）
// → 直接认输，换腿只会再烧一份别人的额度。三条腿全满才算失败，走原来的
// 退款 + 管理员告警。
//
// 起因是 9/2 上午：单腿吃 Kimi，7 单 11 分钟内涌进来把 5 小时配额打穿，9 本
// 书全灭、每本跑几十轮才倒下，而同机的 Codex 和 Claude 订阅整段时间闲着。
//
// 换腿是**整本重跑**（各腿的会话不互通）。skill 本身有断点续跑约定，工作目录
// WORKSPACE/book-<slug> 还在，所以下面给续跑腿追一句提示，让它先查有没有半成品，
// 免得同一单写出两本书。前一腿烧掉的轮数收不回来，这是换腿的固有代价。
const BOOK_LEGS = parseLegs(process.env.BOOK_LEGS);

function legLabel(leg: BookLeg): string {
  return leg === "kimi" ? `kimi-compat(${BOOK_CLAUDE_MODEL})` : leg === "claude" ? "claude-sub" : "codex";
}

function runLeg(leg: BookLeg, prompt: string, onThread?: (id: string) => void): Promise<CodexOutcome> {
  if (leg === "codex") return runCodexExec(prompt, onThread);
  return runClaudeExec(prompt, onThread, leg === "kimi"); // kimi=注入兼容端点，claude=吃 lab 订阅
}

const RESUME_HINT =
  `\n\n补充（本单已换过引擎）：上一次尝试因引擎配额中断，可能已经写了一部分——` +
  `动笔前先列一下 ${WORKSPACE}/ 下本单的工作目录，如果已有 book.json / 章节 / reviews，` +
  `就接着把它写完并发布，**不要另起一本新书、不要换 slug**。`;

const runBookEngine = async (
  prompt: string,
  onThread?: (id: string) => void,
  _opts?: { newBook?: boolean },
): Promise<CodexOutcome> => {
  // 凭据缺失的腿直接跳过，别浪费一次必败的重跑。
  const legs = availableLegs(BOOK_LEGS, {
    kimi: Boolean(BOOK_ANTHROPIC_BASE_URL),
    claude: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  });
  if (!legs.length) return runCodexExec(prompt, onThread); // 全没配：保底还是老路
  let last: CodexOutcome = { ok: false, threadId: "", reply: "", error: "no leg ran" };
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    console.log(`[book] leg ${i + 1}/${legs.length} = ${legLabel(leg)}`);
    last = await runLeg(leg, i === 0 ? prompt : prompt + RESUME_HINT, onThread);
    if (last.ok) {
      if (i > 0) console.log(`[book] leg ${legLabel(leg)} 写成（前 ${i} 条腿用不了）`);
      return last;
    }
    if (!shouldTryNextLeg(last.error)) {
      console.log(`[book] leg ${legLabel(leg)} 失败，但不是配额/凭据问题，不换腿 → ${last.error.slice(0, 120)}`);
      return last;
    }
    console.log(
      `[book] leg ${legLabel(leg)} 用不了（配额满或凭据失效）` +
        (i + 1 < legs.length ? ` → 换 ${legLabel(legs[i + 1])}` : "（已是最后一条腿）"),
    );
  }
  return last;
};

// 跑一次 codex exec 到结束。事件解析与 codex-agent 的 translate() 同源（实机 fixture
// 校准过）：thread.started 拿线程号，item.completed/agent_message 的最后一条是给
// 主人看的答复，turn.failed/error 记错误。三坑防线：flags 在子命令后紧跟（无 resume）、
// --skip-git-repo-check（workspace 不是 git repo）、stdin 必须 ignore（否则等 EOF 挂住）。
function runCodexExec(prompt: string, onThread?: (id: string) => void): Promise<CodexOutcome> {
  return new Promise((resolve) => {
    const args = ["exec", "--json", "-s", "danger-full-access", "-C", WORKSPACE, "--skip-git-repo-check"];
    if (BOOK_CODEX_MODEL) args.push("-m", BOOK_CODEX_MODEL);
    args.push(prompt);
    const child = spawn(CODEX_BIN, args, {
      cwd: WORKSPACE,
      env: { ...process.env, CODEX_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let threadId = "";
    let reply = "";
    let error = "";
    let stderrTail = "";
    let buf = "";
    const timer = setTimeout(() => {
      error = error || `书没写完就超时了（${Math.round(BOOK_TIMEOUT_MS / 60000)} 分钟兜底）`;
      child.kill("SIGKILL");
    }, BOOK_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (c) => {
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
        if (!threadId && tid && (type === "thread.started" || type === "session.created")) {
          threadId = String(tid);
          onThread?.(threadId);
        }
        if (type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text)
          reply = String(ev.item.text);
        if (type === "turn.failed" || type === "error")
          error = String(ev?.error?.message ?? ev?.message ?? "turn failed");
      }
    });
    child.stderr.on("data", (c) => {
      stderrTail = (stderrTail + c).slice(-2000);
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ ok: false, threadId, reply, error: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && !!reply;
      resolve({ ok, threadId, reply, error: ok ? "" : error || stderrTail.trim() || `codex exit ${code}` });
    });
  });
}

// --- 书的登记簿：产权在 book.json（owner 字段），对话线在 R2 _src/bookmeta.json ---
//
// 2026-08-23 起 bookmeta 不再以 VPS 本地文件为真源（VPS 重装会丢）：
//   - 产权：book.json 顶层 "owner"（= 创建时扣费账户的 scope，公开信息，与 photo
//     URL 同级）。写书时建筑师直接写 + 30s 轮询确定性兜底注入，build.mjs 随发布
//     镜像到 R2 _src/book.json —— R2 即真源，天然持久。
//   - 对话线：R2 books/<slug>/_src/bookmeta.json = { slug, scope, author,
//     createdAt, thread: [entry…] }，entry = { ts, kind: "create"|"revise",
//     instruction, sessionId?, status: "running"|"done"|"failed", reply?, error? }。
//     由 lab 独占读写（与 codex 并发改 book.json 互不打架），走 files API 上传
//     （发布账号 token），读走公开 URL 带时间戳穿透 5 分钟边缘缓存。
//   - 本地 bookmeta/ 目录只剩两个用途：老条目的读回退（读到即懒迁移上 R2）和
//     _unmatched 落档。sessionId：codex 线程号（CODEX_HOME/sessions/ 可续）。
const BOOKMETA_DIR = process.env.BOOKMETA_DIR ?? join(__dirname, "..", "bookmeta");
const FILES_API = "https://jianshuo.dev/files/api";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

type ThreadEntry = {
  ts: number;
  kind: "create" | "revise";
  instruction: string;
  sessionId?: string;
  status: "running" | "done" | "failed";
  reply?: string;
  error?: string;
};
type BookMeta = { slug: string; scope: string; author: string; createdAt: number; thread: ThreadEntry[] };

function metaPath(slug: string): string {
  return join(BOOKMETA_DIR, slug + ".json");
}
// 发布账号 token（与 build.mjs 同源 ~/.config/voicedrop/credentials）——上传对话线用。
let cachedPublisherToken = "";
async function publisherToken(): Promise<string> {
  if (cachedPublisherToken) return cachedPublisherToken;
  try {
    const j = JSON.parse(
      await readFile(join(process.env.HOME ?? homedir(), ".config", "voicedrop", "credentials"), "utf8"),
    );
    cachedPublisherToken = String(j?.token ?? "");
  } catch {
    /* 下次再试 */
  }
  return cachedPublisherToken;
}
async function readBookMeta(slug: string): Promise<BookMeta | null> {
  // R2 为真源；?_= 穿透书页路由的 5 分钟边缘缓存（App 轮询 history 要看到实时进度）。
  try {
    const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/_src/bookmeta.json?_=${Date.now()}`);
    if (r.ok) return await r.json();
  } catch {
    /* 网络抖动 → 走本地回退 */
  }
  // 本地老条目：读到即懒迁移上 R2（迁移失败不影响本次返回）。
  try {
    const legacy = JSON.parse(await readFile(metaPath(slug), "utf8"));
    writeBookMeta(legacy).catch(() => {});
    return legacy;
  } catch {
    return null;
  }
}
// 单进程低频写，串行化一下防「读-改-写」互相覆盖（create 收尾与 revise 并发时）。
// 上传失败回落本地文件——宁可暂留 VPS 也绝不丢条目（下次 readBookMeta 会再懒迁移）。
let metaWriteChain: Promise<unknown> = Promise.resolve();
function writeBookMeta(meta: BookMeta): Promise<void> {
  const p = metaWriteChain.then(async () => {
    const body = JSON.stringify(meta, null, 2) + "\n";
    try {
      const tok = await publisherToken();
      if (!tok) throw new Error("no publisher token");
      const r = await fetch(`${FILES_API}/upload/books/${meta.slug}/_src/bookmeta.json`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body,
      });
      if (!r.ok) throw new Error(`upload ${r.status}`);
      await unlink(metaPath(meta.slug)).catch(() => {}); // R2 落定后清掉本地旧件，防回退读到陈旧线
    } catch (e) {
      console.error(`[bookmeta] R2 upload failed slug=${meta.slug}:`, e instanceof Error ? e.message : e);
      await mkdir(BOOKMETA_DIR, { recursive: true });
      await writeFile(metaPath(meta.slug), body);
    }
  });
  metaWriteChain = p.catch(() => {});
  return p as Promise<void>;
}
async function patchThreadEntry(slug: string, ts: number, patch: Partial<ThreadEntry>): Promise<void> {
  const meta = await readBookMeta(slug);
  if (!meta) return;
  const e = meta.thread.find((x) => x.ts === ts);
  if (!e) return;
  Object.assign(e, patch);
  await writeBookMeta(meta);
}

// 写书 job 起跑时还不知道 slug（slug 是建筑师中途起的），所以把任务号 jobId 塞进
// prompt 让 agent 写进 book.json；收尾时拿 jobId 去工作目录里反查 slug。
// 扫两处：WORKSPACE（修书/新版写书的耐久工作目录）和 /tmp（旧约定；PrivateTmp
// 下与本进程同命名空间，job 刚结束时还在）。
async function findBookByJobId(jobId: string): Promise<{ dir: string; book: any } | null> {
  for (const root of [WORKSPACE, BOOK_RUN_DIR, "/tmp"]) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      try {
        const j = JSON.parse(await readFile(join(root, d, "book.json"), "utf8"));
        if (j?.jobId === jobId && typeof j?.slug === "string" && SLUG_RE.test(j.slug))
          return { dir: join(root, d), book: j };
      } catch {
        /* not a book dir */
      }
    }
  }
  return null;
}

async function findSlugByJobId(jobId: string): Promise<string | null> {
  return (await findBookByJobId(jobId))?.book.slug ?? null;
}

// 认证 = 计费（2026-08-10 起，替代早前的「须有成文文章 + 每日限额」门槛）：
// 转发用户 bearer 到 agent worker 的 book-charge，一口价扣 160 算力（真源在
// agent/src/usage.js 的 BOOK_SUANLI），扣成功才开写。数量限制全部取消——算力就是
// 闸门。注意 2026-09-01 降价到 160 后，注册赠送 200 已经够写第一本，「新账户不够
// 一本」这个旧的天然门槛没有了。dry=true 只验余额不扣（部署冒烟 + App 预检）。
async function chargeBook(
  auth: string | undefined,
  extra: { seed?: string; slug?: string; kind?: "revise" },
  dry: boolean,
): Promise<{ status: number; body: any }> {
  if (!auth?.startsWith("Bearer ")) return { status: 401, body: { error: "bad token" } };
  try {
    const r = await fetch(BOOK_CHARGE_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ ...extra, seed: extra.seed?.slice(0, 200), dry }),
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  } catch {
    return { status: 502, body: { error: "charge unreachable" } };
  }
}

// 写书/修书失败退款（2026-08-27）：预扣一口价的书没写成——引擎被拒/超时/崩溃——
// 用下单时那枚用户 bearer 调 worker 的 book-refund，把预扣的算力原数还回。ref 幂等
// （写书=jobId、修书=slug#ts），worker 端同 ref 只退一次。尽力而为：退不成只留日志，
// 绝不抛错（退款失败还有管理员报警兜底人工补）。
async function refundBook(
  auth: string | undefined,
  extra: { ref: string; kind?: "revise" },
): Promise<void> {
  if (!auth?.startsWith("Bearer ")) return;
  try {
    const r = await fetch(BOOK_REFUND_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(extra),
    });
    const body: any = await r.json().catch(() => ({}));
    console.log(`[book] refund ref=${extra.ref} kind=${extra.kind ?? "book"} status=${r.status} ${body?.deduped ? "deduped" : `refunded=${body?.refunded_suanli ?? "?"}`}`);
  } catch (e) {
    console.error("[book] refund failed", e);
  }
}

// 书写好了给主人发 APNs（2026-08-23）：worker /agent/push/book-done 用同一枚用户
// bearer 认人——lab 不存推送凭据，token 是谁的就推给谁。尽力而为，失败只留日志，
// 绝不影响主流程。
// 系统级故障/任务失败 → 立刻推管理员（2026-08-24 用户要求）。用发布账号 token
// 认自己人（worker 端校验 scope==ADMIN_SCOPE），无需新密钥。尽力而为不抛错。
async function notifyAdmin(title: string, body: string) {
  try {
    const tok = await publisherToken();
    if (!tok) return;
    const r = await fetch(ADMIN_PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    console.log(`[admin-push] ${title} status=${r.status}`);
  } catch (e) {
    console.error("[admin-push] failed", e);
  }
}

async function notifyBookDone(auth: string | undefined, slug: string, title: string) {
  if (!auth?.startsWith("Bearer ")) return;
  try {
    const r = await fetch(BOOK_PUSH_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug, title }),
    });
    console.log(`[book] push slug=${slug} status=${r.status}`);
  } catch (e) {
    console.error("[book] push failed", e);
  }
}

// 书帖登记（2026-08-27）：写书/修书收尾把书 upsert 成社区一等帖（agent worker
// /agent/book/community，share_id "book-<slug>"）——赞/回应/推荐排序与普通帖同权，
// 取代 reco 的读时混入。同一枚用户 bearer 认人（主人的 hidden 书也带得出来，
// hidden 照登记、feed 自然不出）。尽力而为：失败只留日志，漂了用 admin 批量回填。
const BOOK_COMMUNITY_URL = process.env.BOOK_COMMUNITY_URL ?? "https://jianshuo.dev/agent/book/community";
async function registerBookPost(auth: string | undefined, slug: string) {
  if (!auth?.startsWith("Bearer ")) return;
  try {
    const r = await fetch(BOOK_COMMUNITY_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    console.log(`[book] community-post slug=${slug} status=${r.status}`);
  } catch (e) {
    console.error("[book] community-post failed", e);
  }
}

// 用 bearer 问 files API 这是谁（history 只读不扣费，用这个拿 scope 做主人校验）。
async function fetchScope(auth: string | undefined): Promise<string> {
  if (!auth?.startsWith("Bearer ")) return "";
  try {
    const r = await fetch("https://jianshuo.dev/files/api/whoami", { headers: { Authorization: auth } });
    if (!r.ok) return "";
    return String(((await r.json()) as any)?.scope ?? "");
  } catch {
    return "";
  }
}

// 存储层所有权兜底（2026-08-20）：所有书都由本机 agent 用**同一个** voicedrop 账号
// 发布（~/.config/voicedrop/credentials 的 scope）——存储位置分不出下单人，下单人只在
// 扣费那一刻可知，这是 bookmeta 存在的原因。但反过来：请求者若就是发布账号本人
// （token 的 scope == 发布 scope），他对店里所有书天然有存储层所有权——bookmeta 缺
// 条目（老书/历史事故）也允许修，并当场补登记。其他人仍需 bookmeta 对号。
let cachedPublisherScope = "";
async function publisherScope(): Promise<string> {
  if (cachedPublisherScope) return cachedPublisherScope;
  try {
    const j = JSON.parse(
      await readFile(join(process.env.HOME ?? homedir(), ".config", "voicedrop", "credentials"), "utf8"),
    );
    cachedPublisherScope = String(j?.scope ?? "");
  } catch {
    /* 下次再试 */
  }
  return cachedPublisherScope;
}

// 线上 _src 源稿镜像的 book.json（取署名用；老书没有 _src，返回 null 不算书不存在）。
async function fetchSrcBook(slug: string): Promise<any | null> {
  try {
    const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/_src/book.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// 书存在与否以公开目录页为准——_src 是 2026-08-15 才有的，老书只有 index.html。
async function bookExistsOnline(slug: string): Promise<boolean> {
  try {
    const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/index.html`, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

// 真实作者署名（2026-08-11）：用提交者自己的 bearer 拉他的 CLAUDE.json，取
// profile.name（设置页「名字」，挖文章署名同源）。拉不到/没填 → 空，书就不署名
// ——绝不回落到任何默认人名。
async function fetchAuthorName(auth: string | undefined): Promise<string> {
  if (!auth) return "";
  try {
    const r = await fetch("https://jianshuo.dev/files/api/download/CLAUDE.json", {
      headers: { Authorization: auth },
    });
    if (!r.ok) return "";
    const j: any = await r.json();
    return String(j?.profile?.name || "").trim().slice(0, 20);
  } catch {
    return "";
  }
}

function runBookJob(seed: string, scope: string, author: string, auth?: string) {
  const jobId = randomUUID();
  const startedAt = Date.now();
  console.log(`[book] start scope=${scope} author=${author || "-"} job=${jobId} seed=${seed.slice(0, 120).replace(/\n/g, " ")}`);
  const byline = author
    ? `作者署名「${author}」——book.json 的 author 字段用这个名字，封面/页脚照此署名。`
    : `提交者没有留名字——book.json 不写 author 字段，全书不署名（不要默认署任何人名）。`;
  const prompt =
    `${CODEX_BOOK_PREAMBLE}\n\n` +
    `任务：写一本书。${byline}\n` +
    `本次写书任务号 jobId=「${jobId}」——建 book.json 时把它原样写进顶层 "jobId" 字段（登记簿要靠它对号，别漏）。\n` +
    (scope ? `这本书的产权归属 owner=「${scope}」——建 book.json 时把它原样写进顶层 "owner" 字段（谁能在线修改这本书以此为准）。\n` : "") +
    `种子：\n${seed}`;
  let sessionId = "";
  // 边跑边登记：slug 一出现（建筑师落 book.json，约 1 分钟内）就先写 bookmeta
  // （status running）——只在收尾登记的话，进程中途死掉这本书就没有主人
  // （2026-08-20 部署重启掐死在跑任务，实锤丢过一次）。
  let earlySlug = "";
  const reg = setInterval(async () => {
    try {
      const hit = await findBookByJobId(jobId);
      if (!hit) return;
      clearInterval(reg);
      const slug: string = hit.book.slug;
      earlySlug = slug;
      // 确定性兜底注入（skill 已要求写，这里保证一定有；只在创建期，修书不受影响；
      // build.mjs 每次发布都从盘上重读 book.json，注入不会被冲掉）：
      //   - 绘本缺省不上架：type=childrens 没写 hidden → 补 "hidden": true；
      //   - 产权：没写 owner → 补 "owner" = 下单人 scope（公开信息，与 photo URL
      //     同级；R2 里的 book.json 即产权真源，VPS 重装不丢）。
      let inject = false;
      if (hit.book?.type === "childrens" && !("hidden" in hit.book)) { hit.book.hidden = true; inject = true; }
      if (scope && !hit.book.owner) { hit.book.owner = scope; inject = true; }
      if (inject) {
        try {
          await writeFile(join(hit.dir, "book.json"), JSON.stringify(hit.book, null, 2) + "\n");
          console.log(`[book] injected defaults slug=${slug} hidden=${hit.book.hidden === true} owner=${hit.book.owner}`);
        } catch (e) {
          console.error("[book] default inject failed", e);
        }
      }
      const meta = (await readBookMeta(slug)) ?? { slug, scope, author, createdAt: startedAt, thread: [] };
      if (!meta.thread.some((e) => e.ts === startedAt)) {
        meta.thread.push({
          ts: startedAt,
          kind: "create",
          instruction: seed.slice(0, 4000),
          ...(sessionId ? { sessionId } : {}),
          status: "running",
        });
        await writeBookMeta(meta);
        console.log(`[book] early-registered slug=${slug} scope=${scope}`);
      }
    } catch {
      /* 下一轮再试 */
    }
  }, 30000);
  reg.unref?.();
  (async () => {
    let ok = false;
    let reply = "";
    try {
      const out = await runBookEngine(prompt, (id) => {
        sessionId = id;
      }, { newBook: true });
      ok = out.ok;
      reply = out.reply;
      console.log(`[book] done scope=${scope} thread=${out.threadId || "-"}` + (ok ? "" : ` ERROR=${out.error}`));
      if (!ok) {
        await notifyAdmin("写书任务失败", `${seed.slice(0, 40)} · 腿=${BOOK_LEGS.join("→")} · ${String(out.error || "").slice(0, 100)}`);
        await refundBook(auth, { ref: jobId });   // 预扣一口价没写成——原数退回
      }
    } catch (e) {
      console.error("[book] job failed", e);
      // 引擎抛异常（超时/崩溃）同样扣了钱没产出，退款；ref=jobId 幂等，与上面正常
      // 失败分支互斥（try 走完不进 catch），双保险不会双退。
      await refundBook(auth, { ref: jobId });
    }
    // 收尾登记：早登记过就补 status/reply；没有就整条落档。找不到 slug 落
    // _unmatched 便于人工对号——绝不让一本已扣费的书没有主人记录。
    clearInterval(reg);
    try {
      const slug = earlySlug || (await findSlugByJobId(jobId));
      const patch: Partial<ThreadEntry> = {
        ...(sessionId ? { sessionId } : {}),
        status: ok ? "done" : "failed",
        ...(reply ? { reply: reply.slice(0, 4000) } : {}),
      };
      if (slug) {
        const meta = await readBookMeta(slug);
        if (meta?.thread.some((e) => e.ts === startedAt)) {
          await patchThreadEntry(slug, startedAt, patch);
        } else {
          const m = meta ?? { slug, scope, author, createdAt: startedAt, thread: [] };
          m.thread.push({
            ts: startedAt,
            kind: "create",
            instruction: seed.slice(0, 4000),
            status: "failed",
            ...patch,
          } as ThreadEntry);
          await writeBookMeta(m);
        }
        console.log(`[book] registered slug=${slug} scope=${scope} session=${sessionId}`);
        // 写成了才推；失败不推用户（钱的事人工处理，别用推送吓人）。
        if (ok) {
          const title = String((await findBookByJobId(jobId))?.book?.title ?? "");
          await registerBookPost(auth, slug);   // 先登记社区帖，推送里的书立刻可在社区看到
          await notifyBookDone(auth, slug, title);
        }
      } else {
        await mkdir(BOOKMETA_DIR, { recursive: true });
        await writeFile(
          join(BOOKMETA_DIR, `_unmatched-${jobId}.json`),
          JSON.stringify({ jobId, scope, author, instruction: seed.slice(0, 4000), ...patch }, null, 2) + "\n",
        );
        console.error(`[book] job=${jobId} finished but no book.json carries this jobId — wrote _unmatched`);
      }
    } catch (e) {
      console.error("[book] register failed", e);
    }
  })();
}

// 修书 job：不 resume 写书旧线程（背着整段历史只多花钱）——每次修改都是全新
// codex exec，以工作目录/线上成书这些「文件」为真源。
function runReviseJob(slug: string, scope: string, author: string, instruction: string, entryTs: number, auth?: string) {
  console.log(`[revise] start slug=${slug} scope=${scope} instr=${instruction.slice(0, 120).replace(/\n/g, " ")}`);
  const byline = author ? `这本书署名「${author}」，改动不要动署名。` : "这本书不署名，保持不署名。";
  const prompt =
    `${CODEX_BOOK_PREAMBLE}\n\n` +
    `任务：按 skill 的「修书模式」修改一本已出版的书。\n` +
    `slug：${slug}\n${byline}\n` +
    `书的主人提出的修改指令：\n${instruction}\n\n` +
    `要求：只改与指令相关的章节/目录/封面，其余一律不动；改完把受影响的页面重新发布；` +
    `最后一条消息只输出一段给书的主人看的「修改说明」（200 字以内，说清改了什么、动了哪几章），不要别的寒暄。`;
  (async () => {
    try {
      const out = await runBookEngine(prompt, (id) => {
        patchThreadEntry(slug, entryTs, { sessionId: id }).catch(() => {});
      });
      await patchThreadEntry(slug, entryTs, {
        status: out.ok ? "done" : "failed",
        ...(out.reply ? { reply: out.reply.trim().slice(0, 4000) } : {}),
        ...(out.ok ? {} : { error: out.error }),
      });
      console.log(`[revise] done slug=${slug} thread=${out.threadId || "-"}` + (out.ok ? "" : ` ERROR=${out.error}`));
      if (out.ok) await registerBookPost(auth, slug);   // 标题/hidden/章节数可能变了——刷新书帖
      if (!out.ok) {
        await notifyAdmin("修书任务失败", `${slug} · 腿=${BOOK_LEGS.join("→")} · ${String(out.error || "").slice(0, 100)}`);
        await refundBook(auth, { ref: `${slug}#${entryTs}`, kind: "revise" });   // 修书没改成——退回预扣的 40
      }
    } catch (e: any) {
      console.error("[revise] job failed", e);
      await patchThreadEntry(slug, entryTs, { status: "failed", error: String(e?.message ?? e) }).catch(() => {});
      await refundBook(auth, { ref: `${slug}#${entryTs}`, kind: "revise" });   // 引擎崩溃同样退
    }
  })();
}

async function handleBook(req: IncomingMessage, res: ServerResponse, payload: any) {
  const json = { "Content-Type": "application/json" };
  const seed = String(payload?.seed ?? "").trim().slice(0, 20000);
  if (!seed) {
    res.writeHead(400, json).end(JSON.stringify({ error: "empty seed" }));
    return;
  }
  // 扣费即准入：402 = 算力不足（body 里带 need_suanli/suanli 供 App 展示），
  // 401 = token 无效。扣成功立刻开写——没有数量限制。
  const charge = await chargeBook(req.headers.authorization, { seed }, !!payload?.dry);
  if (charge.status !== 200 || !charge.body?.ok) {
    res.writeHead(charge.status === 200 ? 502 : charge.status, json).end(JSON.stringify(charge.body));
    return;
  }
  if (payload?.dry) {
    res.writeHead(200, json).end(JSON.stringify(charge.body));
    return;
  }
  // 署名：App 显式给的 author 优先，否则用 bearer 拉提交者设置里的名字。
  const author =
    String(payload?.author ?? "").trim().slice(0, 20) ||
    (await fetchAuthorName(req.headers.authorization));
  runBookJob(seed, String(charge.body.scope ?? ""), author, req.headers.authorization);
  res.writeHead(202, json).end(JSON.stringify({ ok: true, charged_suanli: charge.body.charged_suanli, suanli: charge.body.suanli }));
}

// POST /api/book/revise {slug, instruction[, dry]} + 用户 bearer —— 修书。
// 主人校验在扣费之前（先 dry 拿 scope 比对，再真扣）：403 时一分钱不动。
// 同一本书同时只跑一个修改（409 busy）。202 后 App 轮询 history 看进度和答复。
async function handleBookRevise(req: IncomingMessage, res: ServerResponse, payload: any) {
  const json = { "Content-Type": "application/json" };
  const slug = String(payload?.slug ?? "").trim();
  const instruction = String(payload?.instruction ?? "").trim().slice(0, 4000);
  if (!SLUG_RE.test(slug)) {
    res.writeHead(400, json).end(JSON.stringify({ error: "bad slug" }));
    return;
  }
  if (!instruction && !payload?.dry) {
    res.writeHead(400, json).end(JSON.stringify({ error: "empty instruction" }));
    return;
  }
  // dry 探路：验 token、验余额、拿 scope——都不扣费。
  const probe = await chargeBook(req.headers.authorization, { slug, kind: "revise" }, true);
  if (probe.status !== 200 || !probe.body?.ok) {
    res.writeHead(probe.status === 200 ? 502 : probe.status, json).end(JSON.stringify(probe.body));
    return;
  }
  const requester = String(probe.body.scope ?? "");
  // 产权（2026-08-23 起）：book.json 顶层 owner 为真源（R2 持久，公开信息）；没有
  // owner 的老书退回对话线登记的 scope；两者皆无 → 只有发布账号本人按存储层所有权
  // 放行（其他人 404，否则任何人都能改别人的书）。放行后补建对话线。
  const srcBook = await fetchSrcBook(slug);
  let meta = await readBookMeta(slug);
  const owner = String(srcBook?.owner ?? "") || String(meta?.scope ?? "");
  if (owner) {
    if (owner !== requester) {
      res.writeHead(403, json).end(JSON.stringify({ error: "not-owner" }));
      return;
    }
  } else {
    const pub = await publisherScope();
    if (!requester || !pub || requester !== pub || !(await bookExistsOnline(slug))) {
      res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
      return;
    }
  }
  if (!meta) {
    if (!owner && !(await bookExistsOnline(slug))) {
      res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
      return;
    }
    meta = {
      slug,
      scope: owner || requester,
      author: String(srcBook?.author ?? "").slice(0, 20),
      createdAt: Date.now(),
      thread: [],
    };
    await writeBookMeta(meta);
    console.log(`[revise] registered thread slug=${slug} scope=${meta.scope}`);
  }
  if (meta.thread.some((e) => e.status === "running")) {
    res.writeHead(409, json).end(JSON.stringify({ error: "busy" }));
    return;
  }
  if (payload?.dry) {
    res.writeHead(200, json).end(JSON.stringify(probe.body));
    return;
  }
  const charge = await chargeBook(req.headers.authorization, { slug, kind: "revise" }, false);
  if (charge.status !== 200 || !charge.body?.ok) {
    res.writeHead(charge.status === 200 ? 502 : charge.status, json).end(JSON.stringify(charge.body));
    return;
  }
  const entry: ThreadEntry = { ts: Date.now(), kind: "revise", instruction, status: "running" };
  meta.thread.push(entry);
  await writeBookMeta(meta);
  runReviseJob(slug, meta.scope, meta.author, instruction, entry.ts, req.headers.authorization);
  res.writeHead(202, json).end(
    JSON.stringify({ ok: true, ts: entry.ts, charged_suanli: charge.body.charged_suanli, suanli: charge.body.suanli }),
  );
}

// GET /api/book/history?slug=<slug> + 用户 bearer —— 这本书的永久对话线（主人可见）。
async function handleBookHistory(req: IncomingMessage, res: ServerResponse, slug: string) {
  const json = { "Content-Type": "application/json" };
  if (!SLUG_RE.test(slug)) {
    res.writeHead(400, json).end(JSON.stringify({ error: "bad slug" }));
    return;
  }
  const scope = await fetchScope(req.headers.authorization);
  if (!scope) {
    res.writeHead(401, json).end(JSON.stringify({ error: "bad token" }));
    return;
  }
  const srcBook = await fetchSrcBook(slug);
  const meta = await readBookMeta(slug);
  // 产权：book.json owner 优先，退回对话线 scope，两者皆无则仅发布账号本人可看。
  const owner = String(srcBook?.owner ?? "") || String(meta?.scope ?? "");
  if (owner && owner !== scope) {
    res.writeHead(403, json).end(JSON.stringify({ error: "not-owner" }));
    return;
  }
  if (!owner) {
    const pub = await publisherScope();
    if (!pub || scope !== pub || !(await bookExistsOnline(slug))) {
      res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
      return;
    }
  }
  if (!meta) {
    res.writeHead(200, json).end(
      JSON.stringify({
        slug,
        author: String(srcBook?.author ?? ""),
        createdAt: 0,
        running: false,
        thread: [],
      }),
    );
    return;
  }
  res.writeHead(200, json).end(
    JSON.stringify({
      slug: meta.slug,
      author: meta.author,
      createdAt: meta.createdAt,
      running: meta.thread.some((e) => e.status === "running"),
      thread: meta.thread,
    }),
  );
}

// --- chat runs（断线不中止） ---
//
// 每条用户消息起一个后台 Run：agent 事件先进内存缓冲，SSE 连接只是订阅者。
// 浏览器断开（锁屏/切后台/网络抖动）只是退订，agent 继续跑到完；重新打开
// 会话用 GET /api/chat/attach 回放缓冲 + 续看直播。显式停止走 POST /api/chat/stop。
type Run = {
  keys: Set<string>; // registry 键：起始 sessionId（resume 时）+ init 后的新 sessionId
  events: { event: string; data: any }[];
  listeners: Set<ServerResponse>;
  done: boolean;
  ac: AbortController;
};
const runs = new Map<string, Run>();
let pendingSeq = 0;
const RUN_LINGER_MS = 5 * 60 * 1000; // done 后保留一会儿，晚到的 attach 还能回放
const MAX_BUFFERED_EVENTS = 20000;

function isRunning(id: string): boolean {
  const r = runs.get(id);
  return !!r && !r.done;
}

function activeRunCount(): number {
  let n = 0;
  const seen = new Set<Run>();
  for (const r of runs.values())
    if (!r.done && !seen.has(r)) {
      seen.add(r);
      n++;
    }
  return n;
}

function emit(run: Run, event: string, data: any) {
  // 相邻 text delta 合并存储，几小时的长任务缓冲也不至于膨胀
  const last = run.events[run.events.length - 1];
  if (event === "text" && last?.event === "text") last.data.delta += data.delta;
  else {
    run.events.push({ event, data });
    if (run.events.length > MAX_BUFFERED_EVENTS)
      run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
  }
  for (const res of run.listeners) sse(res, event, data);
}

function sseHead(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

// 一条只发错误就收尾的 SSE 响应（并发满 / 会话已在跑）
function sseReject(res: ServerResponse, message: string) {
  sseHead(res);
  sse(res, "error", { message });
  sse(res, "done", {});
  res.end();
}

function subscribe(run: Run, res: ServerResponse, replay: boolean) {
  sseHead(res);
  if (replay) for (const e of run.events) sse(res, e.event, e.data);
  if (run.done) {
    sse(res, "done", {});
    res.end();
    return;
  }
  run.listeners.add(res);
  // Heartbeat keeps the proxied connection from idling out during quiet
  // stretches (e.g. a long-running Bash tool).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
  }, 15000);
  // 断开只退订，不 abort——run 在服务端继续
  res.on("close", () => {
    clearInterval(heartbeat);
    run.listeners.delete(res);
  });
}

function finishRun(run: Run) {
  run.done = true;
  for (const res of run.listeners) {
    sse(res, "done", {});
    res.end();
  }
  run.listeners.clear();
  const t = setTimeout(() => {
    for (const k of run.keys) if (runs.get(k) === run) runs.delete(k);
  }, RUN_LINGER_MS);
  t.unref?.();
}

function startRun(message: string, sessionId: string | undefined): Run {
  const key = sessionId ?? `pending-${++pendingSeq}`;
  const run: Run = { keys: new Set([key]), events: [], listeners: new Set(), done: false, ac: new AbortController() };
  runs.set(key, run);
  const q = query({
    prompt: message,
    options: {
      abortController: run.ac,
      cwd: WORKSPACE,
      model: MODEL,
      maxTurns: MAX_TURNS,
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "## 画图能力",
          "本机有 paint 出图工具（背后是 paint.jianshuo.dev 的 gpt-image-2 服务），用户要画图/生成图片/改图时直接用：",
          '  /opt/claude-agent/bin/paint "提示词" 输出.png              # 文生图',
          '  /opt/claude-agent/bin/paint "提示词" 输出.png --image 输入.jpg   # 改图',
          "可选: --size WxH(默认1024x1024，总像素须≥1024×640) --transparent --quality low|medium|high --format png|jpeg|webp",
          "出图通常 1-3 分钟，脚本会自己轮询到完成——调 Bash 时把 timeout 设到 600000ms，耐心等它跑完。",
          "成功后脚本打印 result_url（公开可访问的 https://paint.jianshuo.dev/results/… 链接），把这个链接给用户，浏览器点开就能看图。",
        ].join("\n"),
      },
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });
  (async () => {
    try {
      for await (const msg of q as AsyncIterable<any>) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              // resume 会派发新 session_id——两个键都指向本 run，attach 用哪个都行
              if (!run.keys.has(msg.session_id)) {
                run.keys.add(msg.session_id);
                runs.set(msg.session_id, run);
              }
              emit(run, "session", { sessionId: msg.session_id });
            }
            break;

          case "stream_event": {
            // Live text typing only — tool calls come from the complete
            // assistant message below (so we get full, parsed tool input).
            const ev = msg.event;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta")
              emit(run, "text", { delta: ev.delta.text });
            break;
          }

          case "assistant": {
            for (const block of msg.message?.content ?? [])
              if (block.type === "tool_use")
                emit(run, "tool_use", { id: block.id, name: block.name, input: block.input });
            break;
          }

          case "user": {
            const content = msg.message?.content;
            if (Array.isArray(content))
              for (const block of content)
                if (block.type === "tool_result")
                  emit(run, "tool_result", {
                    id: block.tool_use_id,
                    isError: !!block.is_error,
                    content: renderToolResult(block.content),
                  });
            break;
          }

          case "result":
            emit(run, "result", {
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
              durationMs: msg.duration_ms,
              isError: msg.subtype !== "success",
              ...(msg.subtype !== "success" ? { error: msg.subtype } : {}),
            });
            break;
        }
      }
    } catch (err: any) {
      emit(run, "error", {
        message: run.ac.signal.aborted ? "已手动停止" : (err?.message ?? String(err)),
      });
    } finally {
      finishRun(run);
    }
  })();
  return run;
}

async function handleChat(req: IncomingMessage, res: ServerResponse, payload: any) {
  const message = String(payload?.message ?? "").trim();
  const sessionId = payload?.sessionId ? String(payload.sessionId) : undefined;
  if (!message) {
    res.writeHead(400).end("empty message");
    return;
  }
  if (sessionId && isRunning(sessionId)) {
    sseReject(res, "该会话已有任务在运行，可先停止或等它完成");
    return;
  }
  // codex（写书引擎）的会话只能回看——引擎不同，Claude 这边 resume 不了
  if (sessionId && !(await findTranscript(sessionId)) && (await findCodexRollout(sessionId))) {
    sseReject(res, "这是写书引擎（ChatGPT）的会话，只能回看，不能在这里续聊");
    return;
  }
  if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
    sseReject(res, `同时最多运行 ${MAX_CONCURRENT_RUNS} 个任务，稍后再试`);
    return;
  }
  subscribe(startRun(message, sessionId), res, true);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "GET" && req.url === "/api/sessions") {
    listSessions()
      .then((list) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
      })
      .catch((err) => res.writeHead(500).end(String(err?.message ?? err)));
    return;
  }
  const sm = req.url?.match(/^\/api\/sessions\/([^/?]+)$/);
  if (sm) {
    const id = decodeURIComponent(sm[1]);
    if (!SESSION_ID_RE.test(id)) {
      res.writeHead(400).end("bad id");
      return;
    }
    if (req.method === "GET") {
      getSessionMessages(id)
        .then((msgs) => {
          if (!msgs) {
            res.writeHead(404).end("not found");
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(msgs));
        })
        .catch((err) => res.writeHead(500).end(String(err?.message ?? err)));
      return;
    }
    if (req.method === "DELETE") {
      findTranscript(id)
        .then(async (p) => {
          const target = p ?? (await findCodexRollout(id));
          if (!target) {
            res.writeHead(404).end("not found");
            return;
          }
          await unlink(target);
          res.writeHead(200).end("ok");
        })
        .catch((err) => res.writeHead(500).end(String(err?.message ?? err)));
      return;
    }
  }
  // 重连续看：回放该 run 已缓冲的事件，然后跟着直播到结束
  const am = req.url?.match(/^\/api\/chat\/attach\?session=([^&]+)$/);
  if (req.method === "GET" && am) {
    const id = decodeURIComponent(am[1]);
    const run = runs.get(id);
    if (!run) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("no run");
      return;
    }
    subscribe(run, res, true);
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat/stop") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let id = "";
      try {
        id = String(JSON.parse(body || "{}").sessionId ?? "");
      } catch {
        /* fall through to 404 */
      }
      const run = runs.get(id);
      if (run && !run.done) {
        run.ac.abort();
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      } else {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"no active run"}');
      }
    });
    return;
  }
  const hm = req.url?.match(/^\/api\/book\/history\?slug=([^&]+)$/);
  if (req.method === "GET" && hm) {
    handleBookHistory(req, res, decodeURIComponent(hm[1])).catch((err) => {
      res.writeHead(500).end(String(err?.message ?? err));
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/book/revise") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: any;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      handleBookRevise(req, res, payload).catch((err) => {
        res.writeHead(500).end(String(err?.message ?? err));
      });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/book") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: any;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      handleBook(req, res, payload).catch((err) => {
        res.writeHead(500).end(String(err?.message ?? err));
      });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload: any;
      try {
        payload = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      handleChat(req, res, payload).catch((err) => {
        try {
          sse(res, "error", { message: String(err?.message ?? err) });
          res.end();
        } catch {
          /* ignore */
        }
      });
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`claude-agent on http://${HOST}:${PORT}  model=${MODEL}  workspace=${WORKSPACE}`);
});
