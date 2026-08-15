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
    return [];
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
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
}

// Replay a transcript into the same shape the live UI renders: one assistant
// bubble per human turn, with text + tool cards (results attached) interleaved.
async function getSessionMessages(id: string) {
  const path = await findTranscript(id);
  if (!path) return null;
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
const BOOK_MAX_TURNS = Number(process.env.BOOK_MAX_TURNS ?? 80);
const REVISE_MAX_TURNS = Number(process.env.REVISE_MAX_TURNS ?? 50);
const BOOK_CHARGE_URL = process.env.BOOK_CHARGE_URL ?? "https://jianshuo.dev/agent/usage/book-charge";

// --- 书的登记簿（bookmeta）：每本书一份 JSON，主人 + 持久对话线 ---
//
// bookmeta/<slug>.json = { slug, scope, author, createdAt, thread: [entry…] }
// entry = { ts, kind: "create"|"revise", instruction, sessionId?, status:
//           "running"|"done"|"failed", reply?, error? }
// 这是「谁能修这本书」的准入真源（scope = 创建时扣费的账户），也是 App 里
// 「修改这本书」页面读的那条永久对话历史。sessionId 指向 SDK 落盘的
// .claude/projects/**/<sessionId>.jsonl 完整过程（lab 网页 /api/sessions/<id> 可看）。
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
  const q = query({
    prompt:
      `用 wjs-voicedrop-writing-book skill 写一本书。${byline}\n` +
      `本次写书任务号 jobId=「${jobId}」——建 book.json 时把它原样写进顶层 "jobId" 字段（登记簿要靠它对号，别漏）。\n` +
      `种子：\n${seed}`,
    options: {
      cwd: WORKSPACE,
      model: MODEL,
      maxTurns: BOOK_MAX_TURNS,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
    },
  });
  (async () => {
    let sessionId = "";
    let ok = false;
    let reply = "";
    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) sessionId = msg.session_id;
        if (msg.type === "result") {
          ok = msg.subtype === "success";
          reply = typeof msg.result === "string" ? msg.result : "";
          console.log(
            `[book] done scope=${scope} turns=${msg.num_turns} cost=${msg.total_cost_usd}` +
              (ok ? "" : ` ERROR=${msg.subtype}`),
          );
        }
      }
    } catch (e) {
      console.error("[book] job failed", e);
    }
    // 收尾登记：jobId → slug → bookmeta（主人 + 对话线第一条）。找不到 slug 就落
    // _unmatched 便于人工对号——绝不让一本已扣费的书没有主人记录。
    try {
      const slug = await findSlugByJobId(jobId);
      const entry: ThreadEntry = {
        ts: startedAt,
        kind: "create",
        instruction: seed.slice(0, 4000),
        ...(sessionId ? { sessionId } : {}),
        status: ok ? "done" : "failed",
        ...(reply ? { reply: reply.slice(0, 4000) } : {}),
      };
      if (slug) {
        const meta = (await readBookMeta(slug)) ?? { slug, scope, author, createdAt: startedAt, thread: [] };
        meta.thread.push(entry);
        await writeBookMeta(meta);
        console.log(`[book] registered slug=${slug} scope=${scope} session=${sessionId}`);
      } else {
        await mkdir(BOOKMETA_DIR, { recursive: true });
        await writeFile(
          join(BOOKMETA_DIR, `_unmatched-${jobId}.json`),
          JSON.stringify({ jobId, scope, author, ...entry }, null, 2) + "\n",
        );
        console.error(`[book] job=${jobId} finished but no book.json carries this jobId — wrote _unmatched`);
      }
    } catch (e) {
      console.error("[book] register failed", e);
    }
  })();
}

// 修书 job：不 resume 写书旧 session（子 agent 的正文本来就不在主对话里，背着整段
// 历史只多花钱）——每次修改都是全新 session，以工作目录/线上成书这些「文件」为真源。
function runReviseJob(slug: string, scope: string, author: string, instruction: string, entryTs: number) {
  console.log(`[revise] start slug=${slug} scope=${scope} instr=${instruction.slice(0, 120).replace(/\n/g, " ")}`);
  const byline = author ? `这本书署名「${author}」，改动不要动署名。` : "这本书不署名，保持不署名。";
  const q = query({
    prompt:
      `用 wjs-voicedrop-writing-book skill 的「修书模式」修改一本已出版的书。\n` +
      `slug：${slug}\n${byline}\n` +
      `书的主人提出的修改指令：\n${instruction}\n\n` +
      `要求：只改与指令相关的章节/目录/封面，其余一律不动；改完把受影响的页面重新发布；` +
      `最后一条消息只输出一段给书的主人看的「修改说明」（200 字以内，说清改了什么、动了哪几章），不要别的寒暄。`,
    options: {
      cwd: WORKSPACE,
      model: MODEL,
      maxTurns: REVISE_MAX_TURNS,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
    },
  });
  (async () => {
    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id)
          await patchThreadEntry(slug, entryTs, { sessionId: msg.session_id });
        if (msg.type === "result") {
          const ok = msg.subtype === "success";
          const reply = typeof msg.result === "string" ? msg.result.trim() : "";
          await patchThreadEntry(slug, entryTs, {
            status: ok ? "done" : "failed",
            ...(reply ? { reply: reply.slice(0, 4000) } : {}),
            ...(ok ? {} : { error: String(msg.subtype) }),
          });
          console.log(`[revise] done slug=${slug} turns=${msg.num_turns} cost=${msg.total_cost_usd}` + (ok ? "" : ` ERROR=${msg.subtype}`));
        }
      }
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
  const meta = await readBookMeta(slug);
  if (!meta) {
    // 没登记主人的书（登记簿上线前写的老书）不能在线修改——否则任何人都能改别人的书。
    res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
    return;
  }
  // dry 探路：验 token、验余额、拿 scope——都不扣费。
  const probe = await chargeBook(req.headers.authorization, { slug, kind: "revise" }, true);
  if (probe.status !== 200 || !probe.body?.ok) {
    res.writeHead(probe.status === 200 ? 502 : probe.status, json).end(JSON.stringify(probe.body));
    return;
  }
  if (meta.scope && meta.scope !== String(probe.body.scope ?? "")) {
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
  const meta = await readBookMeta(slug);
  if (!meta) {
    res.writeHead(404, json).end(JSON.stringify({ error: "no-book" }));
    return;
  }
  const scope = await fetchScope(req.headers.authorization);
  if (!scope) {
    res.writeHead(401, json).end(JSON.stringify({ error: "bad token" }));
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
          if (!p) {
            res.writeHead(404).end("not found");
            return;
          }
          await unlink(p);
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
