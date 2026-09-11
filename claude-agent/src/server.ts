/**
 * Claude Agent SDK — persistent web-chat backend.
 *
 * A tiny dependency-free HTTP server that runs the Claude Code agent loop via
 * `query()` and streams its events to the browser over SSE. Auth (a single
 * password) is handled by the Caddy reverse proxy in front of this; the server
 * itself only listens on localhost and trusts Caddy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CODEX_HOME, HOME, INFLIGHT_DIR, MODEL, WORKSPACE } from "./env.js";
import {
  writeInflight, removeInflight, listInflight, canRetry, inflightId,
  type Inflight, type InflightCreate, type InflightRevise,
} from "./inflight.js";
import { launchBookUnit, isUnitActive, unitName } from "./book-launch.js";
import {
  SLUG_RE, chargeBook, refundBook, notifyAdmin, fetchScope, publisherScope, fetchSrcBook, bookAuthor,
  bookExistsOnline, fetchAuthorName, readBookMeta, writeBookMeta, patchThreadEntry, findBookByJobId,
  type ThreadEntry,
} from "./bookmeta.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 100);
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS ?? 2);
const MAX_RESULT_CHARS = 8000;

// The SDK persists each conversation as <session_id>.jsonl under HOME/.claude/projects/<cwd-slug>/.
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const SESSION_ID_RE = /^[a-f0-9-]{36}$/;

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
// POST /api/book — 验完 token、扣完费立刻 202。2026-09-11 起书**不在本进程里跑**：
// 收单落一份 inflight JSON，交给 systemd 用户管理器起一个瞬态单元跑 dist/book-runner.js
// （见 src/book-launch.ts）；写书全程与收尾（登记簿/退款/推送/书帖）都在那个进程里，
// 本进程发版、重启、崩溃都不影响正在写的书。
// 认证不走 Caddy basic_auth（Caddyfile 对此路径豁免）：客户端带 VoiceDrop 用户
// bearer（anon_*/session JWT），拿它去 jianshuo.dev 扣费即验真——app 里零内置密钥。

/** 落档 + 起单。起不来就销档并把错误交给调用方（由它退款/答复）。 */
async function dispatchJob(rec: Inflight): Promise<{ ok: boolean; unit: string; error: string }> {
  await writeInflight(INFLIGHT_DIR, rec);
  const r = await launchBookUnit(rec);
  if (r.ok) {
    console.log(`[book] launched ${r.unit} via ${r.via}` + (rec.attempts > 1 ? `（第 ${rec.attempts} 次）` : ""));
    return { ok: true, unit: r.unit, error: "" };
  }
  await removeInflight(INFLIGHT_DIR, rec);
  console.error(`[book] launch failed ${unitName(rec)}: ${r.error}`);
  return { ok: false, unit: unitName(rec), error: r.error };
}

// ── 启动巡检（2026-09-08 起，2026-09-11 改判据）───────────────────────────
// inflight/ 里的文件 = 收单时落的档，runner 引擎返回即删。本进程重启不再杀书，
// 所以「文件还在」不等于孤儿——先问 systemd 那个单元是否还活着：活着就不碰；
// 死了（VPS 整机重启、runner 自己崩/OOM）才按次数续跑或放弃。
async function resumeInflightJobs() {
  const recs = await listInflight(INFLIGHT_DIR);
  if (!recs.length) {
    console.log("[inflight] 没有在飞的任务");
    return;
  }
  for (const rec of recs) {
    const id = inflightId(rec);
    if (await isUnitActive(rec)) {
      console.log(`[inflight] ${id} 仍在 ${unitName(rec)} 里跑，不动`);
      continue;
    }
    if (!canRetry(rec)) {
      console.log(`[inflight] ${id} 已拉起 ${rec.attempts} 次仍未完成，放弃：标 failed + 退款 + 告警`);
      await giveUpInflight(rec);
      continue;
    }
    rec.attempts += 1;
    console.log(`[inflight] 单元已不在，续跑 ${id}（第 ${rec.attempts} 次）`);
    const r = await dispatchJob(rec);
    if (!r.ok) await giveUpInflight(rec, `续跑起单失败：${r.error}`);
  }
}

// 放弃一单：登记簿标 failed、退款（ref 幂等）、告警管理员、销档。每步尽力而为。
async function giveUpInflight(rec: Inflight, why = `服务重启后续跑 ${rec.attempts} 次仍未完成`) {
  try {
    if (rec.kind === "create") {
      const slug = rec.slug || (await findBookByJobId(rec.jobId))?.book.slug || "";
      if (slug) await patchThreadEntry(slug, rec.startedAt, { status: "failed", error: why }).catch(() => {});
      await refundBook(rec.auth, { ref: rec.jobId });
      await notifyAdmin("写书任务放弃", `${rec.seed.slice(0, 40)} · ${why}` + (slug ? ` · ${slug}` : ""));
    } else {
      await patchThreadEntry(rec.slug, rec.entryTs, { status: "failed", error: why }).catch(() => {});
      await refundBook(rec.auth, { ref: `${rec.slug}#${rec.entryTs}`, kind: "revise" });
      await notifyAdmin("修书任务放弃", `${rec.slug} · ${why}`);
    }
  } catch (e) {
    console.error("[inflight] give-up failed", e);
  }
  await removeInflight(INFLIGHT_DIR, rec);
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
  const rec: InflightCreate = {
    kind: "create", jobId: randomUUID(), seed, scope: String(charge.body.scope ?? ""), author,
    auth: req.headers.authorization, startedAt: Date.now(), attempts: 1,
  };
  const r = await dispatchJob(rec);
  if (!r.ok) {
    // 钱已扣、书没起——原数退回，告诉 App 稍后再试。
    await refundBook(rec.auth, { ref: rec.jobId });
    await notifyAdmin("写书起单失败", `${seed.slice(0, 40)} · ${r.error.slice(0, 120)}`);
    res.writeHead(503, json).end(JSON.stringify({ error: "launch failed" }));
    return;
  }
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
  const rec: InflightRevise = {
    kind: "revise", slug, scope: meta.scope, author: bookAuthor(srcBook, meta), instruction,
    entryTs: entry.ts, auth: req.headers.authorization, startedAt: entry.ts, attempts: 1,
  };
  const r = await dispatchJob(rec);
  if (!r.ok) {
    await patchThreadEntry(slug, entry.ts, { status: "failed", error: `起单失败：${r.error.slice(0, 200)}` }).catch(() => {});
    await refundBook(rec.auth, { ref: `${slug}#${entry.ts}`, kind: "revise" });
    await notifyAdmin("修书起单失败", `${slug} · ${r.error.slice(0, 120)}`);
    res.writeHead(503, json).end(JSON.stringify({ error: "launch failed" }));
    return;
  }
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
        author: bookAuthor(srcBook, meta),
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
      author: bookAuthor(srcBook, meta),
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
  // 起来几秒再巡检在飞的书：让端口先就绪；单元还活着的一律不碰。
  setTimeout(() => {
    resumeInflightJobs().catch((e) => console.error("[inflight] resume failed", e));
  }, 5000);
});
