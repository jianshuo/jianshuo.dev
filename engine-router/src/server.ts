// src/server.ts — engine-router 的 HTTP 入口。不开 TCP 端口：只听 Unix socket，
// Caddy 把 lab.jianshuo.dev/router/* 反代进来（handle_path 剥掉 /router 前缀），
// VPS 本机调用方也可以直连 socket（engines 组可读写）。
//
// 鉴权：Bearer token，.env 里 ROUTER_TOKENS="book-runner:xxx,paint:yyy,admin:zzz"，
// 冒号前是调用方名字。调用方只看得到自己的 run / thread；admin 全看得到。
// 状态页 GET / 不验 token——它在 Caddy basic_auth 后面（socket 的文件权限是本机的那道门）。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { CONFIG_PATH, SECRETS_PATH, SOCKET_PATH, STATE_DIR } from "./env.js";
import { join } from "node:path";
import { Pool } from "./pool.js";
import { ThreadStore } from "./threads.js";
import { HttpError, Runs, eventsFile, publicRun } from "./runs.js";
import { renderStatus } from "./status-page.js";
import { acctKey, ENGINE_NAMES } from "./config.js";
import { quotaKey } from "./selector.js";
import { Leases, publicLease } from "./leases.js";

const MAX_BODY = 1024 * 1024;

export function parseTokens(spec: string | undefined): Map<string, string> {
  const m = new Map<string, string>(); // token → caller
  for (const part of String(spec ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const tok = part.slice(i + 1).trim();
    if (name && tok.length >= 16) m.set(tok, name);
  }
  return m;
}

function callerOf(req: IncomingMessage, tokens: Map<string, string>): string | null {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return null;
  const got = Buffer.from(h.slice(7).trim());
  for (const [tok, name] of tokens) {
    const want = Buffer.from(tok);
    if (want.length === got.length && timingSafeEqual(want, got)) return name;
  }
  return null;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(s);
}

export function statusJson(pool: Pool, now = Date.now()) {
  const cfg = pool.cfg;
  const st = pool.selectState();
  const accounts = [];
  for (const e of ENGINE_NAMES)
    for (const a of cfg.engines[e]?.accounts ?? []) {
      const k = acctKey(e, a.id);
      const qk = quotaKey(cfg, e, a.id);
      const u = st.usage[qk];
      accounts.push({
        account: k,
        quota_of: qk !== k ? qk : undefined,
        disabled: !!a.disabled,
        healthy: u ? u.healthy : null,
        used_5h: u?.used5h ?? null,
        reset_5h: u?.reset5h ? new Date(u.reset5h).toISOString() : null,
        used_7d: u?.used7d ?? null,
        reset_7d: u?.reset7d ? new Date(u.reset7d).toISOString() : null,
        probed_at: u?.probedAt ? new Date(u.probedAt).toISOString() : null,
        error: u?.error,
        cooldown_until: (st.cooldown[qk] ?? 0) > now ? new Date(st.cooldown[qk]).toISOString() : null,
        running: st.inflight[k]?.count ?? 0,
        today: e === "seedream" ? st.dailyCount[k] ?? 0 : undefined,
      });
    }
  return { accounts, limits: cfg.limits, policies: cfg.policies, learned: pool.learnedTable() };
}

/** SSE：从字节偏移 from 开始回放事件文件，然后跟随；run 结束且读完就关。 */
async function streamEvents(req: IncomingMessage, res: ServerResponse, runs: Runs, id: string, from: number): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let readPos = Math.max(0, from); // 文件里已读到的字节位置
  let lineStart = readPos; // partial 在文件里的起点；事件 id = 这一行结束处的偏移
  let partial = Buffer.alloc(0);
  let closed = false;
  req.on("close", () => (closed = true));
  let lastBeat = Date.now();
  let terminalSeen = false;
  while (!closed) {
    const file = eventsFile(id);
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    if (size > readPos) {
      const fh = await open(file, "r");
      const buf = Buffer.alloc(size - readPos);
      await fh.read(buf, 0, buf.length, readPos);
      await fh.close();
      readPos = size;
      // 按字节切行，别先整体转字符串（多字节汉字的偏移会算错）
      let data = Buffer.concat([partial, buf]);
      let nl: number;
      while ((nl = data.indexOf(0x0a)) >= 0) {
        const line = data.subarray(0, nl).toString("utf8");
        lineStart += nl + 1;
        data = data.subarray(nl + 1);
        if (line.trim()) res.write(`id: ${lineStart}\ndata: ${line}\n\n`);
      }
      partial = Buffer.from(data);
    }
    // 终态要连续看到两轮才关：finish() 先改状态再追加 done 事件，中间有个小窗口。
    const r = runs.get(id);
    if (!r || r.status === "done" || r.status === "failed" || r.status === "cancelled") {
      if (terminalSeen && size <= readPos && !partial.length) break;
      terminalSeen = true;
    }
    if (Date.now() - lastBeat > 15_000) {
      res.write(": keep-alive\n\n");
      lastBeat = Date.now();
    }
    await new Promise((x) => setTimeout(x, 500));
  }
  res.end();
}

export function createRouterServer(pool: Pool, runs: Runs, threads: ThreadStore, leases: Leases = new Leases(pool)) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://router");
      // 直连 socket 时也接受带 /router 前缀的路径（和经 Caddy 来的一致）
      const path = url.pathname.replace(/^\/router(?=\/|$)/, "") || "/";
      if (req.method === "GET" && (path === "/" || path === "/status")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderStatus(pool, [...runs.runs.values()], leases));
        return;
      }
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
      if (!path.startsWith("/v1/")) return send(res, 404, { error: "not found" });

      const tokens = parseTokens(pool.secrets.ROUTER_TOKENS);
      const caller = callerOf(req, tokens);
      if (!caller) return send(res, 401, { error: "missing or invalid bearer token" });
      const admin = caller === "admin";
      const own = (c: string) => admin || c === caller;

      if (req.method === "GET" && path === "/v1/status") return send(res, 200, statusJson(pool));
      if (req.method === "POST" && path === "/v1/select") return send(res, 200, await runs.dryRun(await readJson(req), caller));
      if (req.method === "POST" && path === "/v1/runs") {
        const { run, existing } = await runs.submit(await readJson(req), caller);
        return send(res, existing ? 200 : 202, publicRun(run));
      }
      let m = /^\/v1\/runs\/([A-Za-z0-9_-]+)(\/events|\/cancel)?$/.exec(path);
      if (m) {
        const r = runs.get(m[1]);
        if (!r || !own(r.caller)) return send(res, 404, { error: "run not found" });
        if (req.method === "GET" && !m[2]) return send(res, 200, publicRun(r));
        if (req.method === "GET" && m[2] === "/events") {
          const from = Number(url.searchParams.get("from") ?? req.headers["last-event-id"] ?? 0) || 0;
          return void (await streamEvents(req, res, runs, r.id, from));
        }
        if (req.method === "POST" && m[2] === "/cancel") return send(res, 200, publicRun((await runs.cancel(r.id))!));
      }
      // 租约：router 只挑账号，调用方自己执行（paint 出图）。见 leases.ts。
      if (req.method === "POST" && path === "/v1/leases") {
        const { lease, selection } = leases.create(await readJson(req), caller);
        if (lease) return send(res, 200, publicLease(lease));
        return send(res, 200, {
          lease_id: null,
          engine: null,
          eta: selection.waitUntil ? new Date(selection.waitUntil).toISOString() : null,
          reasons: selection.candidates.map((c) => `${c.key}: ${c.reason}`),
        });
      }
      m = /^\/v1\/leases\/([A-Za-z0-9_-]+)\/complete$/.exec(path);
      if (m && req.method === "POST") return send(res, 200, { ok: true, released: publicLease(leases.complete(m[1], caller, await readJson(req))) });
      // 长租约报进度（并续期）：视频书 run_book.sh 每换一步报一次，状态页「租约」栏显示
      m = /^\/v1\/leases\/([A-Za-z0-9_-]+)\/progress$/.exec(path);
      if (m && req.method === "POST") return send(res, 200, { ok: true, lease: publicLease(leases.progress(m[1], caller, await readJson(req))) });
      // 调用方自己的排队快照（整份替换），状态页「排队」栏显示；router 不参与排队
      m = /^\/v1\/queues\/([A-Za-z0-9_-]{1,40})$/.exec(path);
      if (m && req.method === "PUT") return send(res, 200, { ok: true, items: leases.putQueue(m[1], caller, await readJson(req)).items.length });

      m = /^\/v1\/threads\/([A-Za-z0-9_-]+)$/.exec(path);
      if (m && req.method === "GET") {
        const t = await threads.get(m[1]);
        if (!t || !own(t.caller)) return send(res, 404, { error: "thread not found" });
        return send(res, 200, {
          thread_id: t.id,
          created_at: new Date(t.createdAt).toISOString(),
          workdir: t.workdir,
          runs: t.runs,
          turns: t.turns.map((x) => ({ prompt: x.prompt, reply: x.reply, account: x.account, at: new Date(x.ts).toISOString() })),
        });
      }
      if (admin && req.method === "POST" && path === "/v1/admin/reload") {
        pool.reload();
        void pool.tick(true);
        runs.pump();
        return send(res, 200, { ok: true, accounts: statusJson(pool).accounts.length });
      }
      if (admin && req.method === "POST" && path === "/v1/admin/probe") {
        await pool.tick(true);
        return send(res, 200, statusJson(pool));
      }
      return send(res, 404, { error: "not found" });
    } catch (e: any) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error("[server]", e);
      if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
      else res.end();
    }
  });
}

async function main() {
  const pool = new Pool(CONFIG_PATH, SECRETS_PATH, join(STATE_DIR, "pool.json"));
  const threads = new ThreadStore();
  const runs = new Runs(pool, threads, { callbackSecret: pool.secrets.CALLBACK_SIGNING_SECRET });
  await runs.load();
  pool.onChange = () => runs.pump();
  pool.start();
  runs.start();
  const leases = new Leases(pool, join(STATE_DIR, "leases.json"));
  leases.start();
  const server = createRouterServer(pool, runs, threads, leases);
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  server.listen(SOCKET_PATH, () => {
    chmodSync(SOCKET_PATH, 0o660); // 属组 engines：caddy 和本机调用方
    console.log(`[server] listening on ${SOCKET_PATH}`);
  });
  process.on("SIGHUP", () => {
    try {
      pool.reload();
      void pool.tick(true);
      console.log("[server] reloaded config");
    } catch (e) {
      console.error("[server] reload failed, keeping old config", e);
    }
  });
}

if (process.argv[1] && /server\.(js|ts)$/.test(process.argv[1])) void main();
