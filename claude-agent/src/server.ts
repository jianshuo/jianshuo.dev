/**
 * Claude Agent SDK — persistent web-chat backend.
 *
 * A tiny dependency-free HTTP server that runs the Claude Code agent loop via
 * `query()` and streams its events to the browser over SSE. Auth (a single
 * password) is handled by the Caddy reverse proxy in front of this; the server
 * itself only listens on localhost and trusts Caddy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

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

async function summarize(path: string, id: string) {
  const raw = await readFile(path, "utf8");
  let title = "";
  let turns = 0;
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
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
  const st = await stat(path);
  return { id, title: title.slice(0, 80) || "(无标题)", updatedAt: st.mtimeMs, turns, running: isRunning(id) };
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
async function summarizeCodex(path: string) {
  const raw = await readFile(path, "utf8");
  let title = "";
  let turns = 0;
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(ln);
    } catch {
      continue;
    }
    if (o.type === "event_msg" && o.payload?.type === "user_message") {
      turns++;
      if (!title) {
        const t = String(o.payload.message ?? "").trim();
        const i = t.indexOf("任务：");
        title = i >= 0 ? t.slice(i) : t;
      }
    }
  }
  const st = await stat(path);
  return {
    id: codexIdOfPath(path),
    title: "📖 " + (title.slice(0, 78) || "(无标题)"),
    updatedAt: st.mtimeMs,
    turns,
    running: false,
    engine: "codex",
  };
}

// 回放：翻译成 getSessionMessages 一样的形状。文字走 event_msg（user_message/
// agent_message），工具卡片走 response_item（function_call/custom_tool_call/
// web_search_call），输出按 call_id 回填；reasoning 是加密的，跳过。
async function getCodexSessionMessages(path: string) {
  const raw = await readFile(path, "utf8");
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
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
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
  const raw = await readFile(path, "utf8");
  const msgs: any[] = [];
  let cur: any = null;
  const toolIndex: Record<string, any> = {};
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
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
const BOOK_CODEX_MODEL = process.env.BOOK_CODEX_MODEL ?? ""; // 空 = 用该链 config.toml 的默认模型
const BOOK_TIMEOUT_MS = Number(process.env.BOOK_TIMEOUT_MS ?? 3 * 60 * 60 * 1000); // 兜底防挂死，写整本书要给足

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

// --- 书的登记簿（bookmeta）：每本书一份 JSON，主人 + 持久对话线 ---
//
// bookmeta/<slug>.json = { slug, scope, author, createdAt, thread: [entry…] }
// entry = { ts, kind: "create"|"revise", instruction, sessionId?, status:
//           "running"|"done"|"failed", reply?, error? }
// 这是「谁能修这本书」的准入真源（scope = 创建时扣费的账户），也是 App 里
// 「修改这本书」页面读的那条永久对话历史。sessionId：2026-08-20 换引擎后是
// codex 线程号（VPS 上 CODEX_HOME/sessions/ 下有完整过程；`codex exec resume <id>`
// 可续）；老条目仍是 Claude session id（lab 网页 /api/sessions/<id> 可回看）。
const BOOKMETA_DIR = process.env.BOOKMETA_DIR ?? join(__dirname, "..", "bookmeta");
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
async function readBookMeta(slug: string): Promise<BookMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(slug), "utf8"));
  } catch {
    return null;
  }
}
// 单进程低频写，串行化一下防「读-改-写」互相覆盖（create 收尾与 revise 并发时）。
let metaWriteChain: Promise<unknown> = Promise.resolve();
function writeBookMeta(meta: BookMeta): Promise<void> {
  const p = metaWriteChain.then(async () => {
    await mkdir(BOOKMETA_DIR, { recursive: true });
    await writeFile(metaPath(meta.slug), JSON.stringify(meta, null, 2) + "\n");
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
async function findSlugByJobId(jobId: string): Promise<string | null> {
  for (const root of [WORKSPACE, "/tmp"]) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      try {
        const j = JSON.parse(await readFile(join(root, d, "book.json"), "utf8"));
        if (j?.jobId === jobId && typeof j?.slug === "string" && SLUG_RE.test(j.slug)) return j.slug;
      } catch {
        /* not a book dir */
      }
    }
  }
  return null;
}

// 认证 = 计费（2026-08-10 起，替代早前的「须有成文文章 + 每日限额」门槛）：
// 转发用户 bearer 到 agent worker 的 book-charge，一口价扣 320 算力，扣成功才开写。
// 伪造随机 token 的新账户只有 200 注册赠送 < 320 → 402，天然挡住；数量限制全部
// 取消——算力就是闸门。dry=true 只验余额不扣（部署冒烟 + App 预检）。
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

function runBookJob(seed: string, scope: string, author: string) {
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
    `种子：\n${seed}`;
  let sessionId = "";
  // 边跑边登记：slug 一出现（建筑师落 book.json，约 1 分钟内）就先写 bookmeta
  // （status running）——只在收尾登记的话，进程中途死掉这本书就没有主人
  // （2026-08-20 部署重启掐死在跑任务，实锤丢过一次）。
  let earlySlug = "";
  const reg = setInterval(async () => {
    try {
      const slug = await findSlugByJobId(jobId);
      if (!slug) return;
      clearInterval(reg);
      earlySlug = slug;
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
      const out = await runCodexExec(prompt, (id) => {
        sessionId = id;
      });
      ok = out.ok;
      reply = out.reply;
      console.log(`[book] done scope=${scope} thread=${out.threadId || "-"}` + (ok ? "" : ` ERROR=${out.error}`));
    } catch (e) {
      console.error("[book] job failed", e);
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
function runReviseJob(slug: string, scope: string, author: string, instruction: string, entryTs: number) {
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
      const out = await runCodexExec(prompt, (id) => {
        patchThreadEntry(slug, entryTs, { sessionId: id }).catch(() => {});
      });
      await patchThreadEntry(slug, entryTs, {
        status: out.ok ? "done" : "failed",
        ...(out.reply ? { reply: out.reply.trim().slice(0, 4000) } : {}),
        ...(out.ok ? {} : { error: out.error }),
      });
      console.log(`[revise] done slug=${slug} thread=${out.threadId || "-"}` + (out.ok ? "" : ` ERROR=${out.error}`));
    } catch (e: any) {
      console.error("[revise] job failed", e);
      await patchThreadEntry(slug, entryTs, { status: "failed", error: String(e?.message ?? e) }).catch(() => {});
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
  runBookJob(seed, String(charge.body.scope ?? ""), author);
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
  let meta = await readBookMeta(slug);
  if (!meta) {
    // 没登记主人的书（登记簿上线前的老书/历史事故）：存储层所有权兜底——请求者
    // 就是发布账号本人时放行并当场补登记；其他人仍 404（否则任何人都能改别人的书）。
    const pub = await publisherScope();
    if (!requester || !pub || requester !== pub || !(await bookExistsOnline(slug))) {
      res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
      return;
    }
    const src = await fetchSrcBook(slug);
    meta = {
      slug,
      scope: requester,
      author: String(src?.author ?? "").slice(0, 20),
      createdAt: Date.now(),
      thread: [],
    };
    await writeBookMeta(meta);
    console.log(`[revise] storage-owner claimed unregistered book slug=${slug} scope=${requester}`);
  }
  if (meta.scope && meta.scope !== requester) {
    res.writeHead(403, json).end(JSON.stringify({ error: "not-owner" }));
    return;
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
  runReviseJob(slug, meta.scope, meta.author, instruction, entry.ts);
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
  const meta = await readBookMeta(slug);
  if (!meta) {
    // 未登记的书：发布账号本人可看（存储层所有权，对话线为空）；其他人 404。
    const pub = await publisherScope();
    if (!pub || scope !== pub || !(await bookExistsOnline(slug))) {
      res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
      return;
    }
    const src = await fetchSrcBook(slug);
    res.writeHead(200, json).end(
      JSON.stringify({
        slug,
        author: String(src?.author ?? ""),
        createdAt: 0,
        running: false,
        thread: [],
      }),
    );
    return;
  }
  if (meta.scope && meta.scope !== scope) {
    res.writeHead(403, json).end(JSON.stringify({ error: "not-owner" }));
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
