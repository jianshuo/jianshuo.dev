import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { JobStore, type Job } from "./store.js";
import { EventHub } from "./events.js";
import { Worker } from "./worker.js";
import type { RouterBatch } from "./router.js";
import { sweep } from "./cleanup.js";
import { normalizeSize } from "./size.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const VALID_FORMAT = new Set(["png", "jpeg", "webp"]);
const VALID_QUALITY = new Set(["low", "medium", "high", "auto"]);
const VALID_ENGINE = new Set(["auto", "codex", "seedream"]);

// Direct-literal-IP SSRF guard for server-side image_url fetch. Blocks loopback,
// private, and link-local (incl. cloud metadata 169.254.x) hosts, including
// IPv4-mapped IPv6 literals (::ffff:a.b.c.d). NOTE: DNS-rebinding via a hostname
// that resolves to a private IP is NOT covered — acceptable for this single-user,
// token-gated internal tool (v1); revisit with a resolver if opened up. Exported for unit tests.
export function isBlockedHost(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d dotted, or ::ffff:aabb:ccdd hex) to its IPv4.
  const mapped = h.match(/^::ffff:(.+)$/i);
  if (mapped) {
    let v4 = mapped[1];
    const hex = v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const n1 = parseInt(hex[1], 16), n2 = parseInt(hex[2], 16);
      v4 = `${(n1 >> 8) & 255}.${n1 & 255}.${(n2 >> 8) & 255}.${n2 & 255}`;
    }
    h = v4;
  }
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // IPv6-literal-only checks (must contain ':', so plain domains like fda.gov are safe)
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fd") || h.startsWith("fe80")) return true;
  }
  return false;
}

function bearerOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers["authorization"];
  if (!h?.startsWith("Bearer ")) return false;
  const got = Buffer.from(h.slice(7));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(s);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function createApp(cfg: Config, deps: { store: JobStore; hub: EventHub; worker: Worker }): Server {
  const { store, hub, worker } = deps;

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // --- static results (public, unguessable) ---
      if (path.startsWith("/results/") && req.method === "GET") {
        const name = basename(path.slice("/results/".length));
        if (!name || name.includes("..") || name.includes("/")) return sendJson(res, 400, { error: "bad name" });
        const file = join(cfg.resultsDir, name);
        const ext = extname(name).toLowerCase();
        try {
          await stat(file);
        } catch {
          return sendJson(res, 404, { error: "not found" });
        }
        res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
        createReadStream(file).on("error", () => { res.destroy(); }).pipe(res);
        return;
      }

      // --- index (behind Caddy basic_auth); inject API token ---
      if (path === "/" && req.method === "GET") {
        const html = (await readFile(join(__dirname, "..", "public", "index.html"), "utf8")).replace("__API_TOKEN__", cfg.apiToken);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // --- operational log (behind Caddy basic_auth, same as "/") ---
      if (path === "/log" && req.method === "GET") {
        const jobs = await store.list(200);
        const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
        const badge = (ok: boolean, txt: string) => `<span style="color:${ok ? "#15803d" : "#b91c1c"};font-weight:600">${esc(txt)}</span>`;
        const rows = jobs.map((j) => {
          const p = publicJob(j, cfg);
          const t = esc(j.createdAt);
          const st = badge(j.status === "done", j.status);
          const cb = j.callbackStatus
            ? badge(j.callbackStatus === "delivered", `${j.callbackStatus}${j.callbackAttempts ? "×" + j.callbackAttempts : ""}`)
            : `<span style="color:#9ca3af">—</span>`;
          const err = j.error ? `<div style="color:#b91c1c;font-size:12px">${esc(j.error.code)}: ${esc(j.error.message)}</div>` : "";
          const thumb = p.result_url ? `<a href="${esc(p.result_url)}" target="_blank"><img src="${esc(p.result_url)}" style="height:48px;border-radius:6px" loading="lazy"></a>` : "";
          return `<tr><td style="white-space:nowrap;color:#555">${t}</td><td>${esc(j.mode)}${j.engine ? `<div style="color:${j.engine === "seedream" ? "#b45309" : "#6b7280"};font-size:12px">${esc(j.engine)}</div>` : ""}${j.group ? `<div style="color:#6b7280;font-size:12px">${esc(j.group)}</div>` : ""}</td><td>${st}</td><td>${cb}</td><td style="max-width:420px;white-space:pre-wrap">${esc(j.prompt || "")}${err}</td><td>${thumb}</td></tr>`;
        }).join("");
        const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>paint log</title>
<style>body{font:14px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;background:#f7f7f8;color:#1a1a1a;margin:0;padding:20px}h1{font-size:17px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e6e6e9;border-radius:10px;overflow:hidden}th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top;font-size:13px}th{background:#faf9f7;color:#666;font-weight:600}tr:last-child td{border-bottom:0}</style></head>
<body><h1>paint 任务日志 <span style="color:#888;font-weight:400">（最近 ${jobs.length} 条 · 出图 done/failed · 回调 delivered/failed/—）</span></h1>
<table><thead><tr><th>时间(UTC)</th><th>模式</th><th>出图</th><th>回调</th><th>提示词 / 错误</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // --- everything under /api requires bearer (SSE events path also accepts ?token=,
      // since browser EventSource cannot set an Authorization header) ---
      if (path.startsWith("/api/")) {
        const isSse = /^\/api\/jobs\/[^/]+\/events$/.test(path);
        const authed = bearerOk(req, cfg.apiToken) || (isSse && url.searchParams.get("token") === cfg.apiToken);
        if (!authed) return sendJson(res, 401, { error: "unauthorized" });

        // POST /api/jobs
        if (path === "/api/jobs" && req.method === "POST") {
          const raw = await readBody(req, Math.ceil(cfg.maxInputBytes * 1.4) + 1024 * 1024);
          let body: any;
          try { body = JSON.parse(raw.toString("utf8") || "{}"); }
          catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
          return await submitJob(body, cfg, store, worker, res);
        }
        // POST /api/batches —— 一批图整体交给 engine-router
        if (path === "/api/batches" && req.method === "POST") {
          const raw = await readBody(req, Math.ceil(cfg.maxInputBytes * 1.4) * 4 + 4 * 1024 * 1024);
          let body: any;
          try { body = JSON.parse(raw.toString("utf8") || "{}"); }
          catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
          return await submitBatch(body, cfg, store, worker, res);
        }
        const bm = path.match(/^\/api\/batches\/([A-Za-z0-9_-]+)(\/cancel)?$/);
        if (bm && (req.method === "GET" || (req.method === "POST" && bm[2]))) {
          const b = bm[2] ? await worker.router.cancelBatch(bm[1]) : await worker.router.getBatch(bm[1]);
          if (!b) return sendJson(res, 404, { error: "batch not found" });
          return sendJson(res, 200, await batchView(b, cfg, store));
        }
        // GET /api/jobs (list)
        if (path === "/api/jobs" && req.method === "GET") {
          const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
          const jobs = await store.list(limit);
          return sendJson(res, 200, { jobs: jobs.map((j) => publicJob(j, cfg)) });
        }
        // GET /api/jobs/:id  or  /api/jobs/:id/events
        const m = path.match(/^\/api\/jobs\/([^/]+)(\/events)?$/);
        if (m && req.method === "GET") {
          const id = m[1];
          if (m[2] === "/events") return await sseEvents(id, cfg, store, hub, res);
          const job = await store.get(id);
          if (!job) return sendJson(res, 404, { error: "not found" });
          return sendJson(res, 200, publicJob(job, cfg));
        }
        return sendJson(res, 404, { error: "not found" });
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e: any) {
      if (!res.headersSent) sendJson(res, e?.message === "body too large" ? 413 : 500, { error: e?.message ?? "server error" });
    }
  });
}

type Parsed = { job: Job; input?: { b64?: string; url?: string } } | { error: string };

/**
 * 一张图的请求体 → Job（未落盘）。单张 POST /api/jobs 和批次 POST /api/batches 的每一项共用。
 * inputs：批次里共用的参考图（name → base64），项里用 image_ref 引用，同一张图只传一次。
 */
function parseJob(body: any, cfg: Config, worker: Worker, inputs?: Record<string, string>): Parsed {
  if (!body || typeof body !== "object") return { error: "item must be an object" };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return { error: "prompt required" };
  if (prompt.length > cfg.maxPromptChars) return { error: "prompt too long" };

  const format = body.format ?? "png";
  const quality = body.quality ?? "high";
  if (!VALID_FORMAT.has(format)) return { error: "bad format" };
  if (!VALID_QUALITY.has(quality)) return { error: "bad quality" };
  const transparent = body.transparent === true;
  // 引擎点名：auto（缺省）= 让 engine-router 挑；codex / seedream = 只用它（router 不换）
  const enginePref = body.engine ?? "auto";
  if (!VALID_ENGINE.has(enginePref)) return { error: "bad engine" };
  if (enginePref === "seedream" && transparent) return { error: "seedream cannot do transparent" };
  if (enginePref === "seedream" && !worker.seedreamConfigured()) return { error: "seedream not configured on this server (ARK_API_KEY)" };
  // 风格一致性分组（如书的 slug）：router 让同组所有批次用同一个引擎
  let group: string | undefined;
  if (body.group !== undefined && body.group !== null && body.group !== "") {
    if (typeof body.group !== "string" || !/^[\w.:-]{1,80}$/.test(body.group)) return { error: "bad group (1-80 chars of [A-Za-z0-9_.:-])" };
    group = body.group;
  }
  // 尺寸规整收归服务端（2026-10-02）：任意合理 WxH 吸附成 CLI 能收的形状，两个引擎出同一尺寸
  const size = normalizeSize(body.size ?? "2K");
  if (!size) return { error: "bad size (WxH like 1024x1536, or auto/2K/4K)" };

  // XMP 溯源参数（spec: docs/superpowers/specs/2026-07-19-paint-xmp-provenance-design.md）
  let xmpMeta: Record<string, string> | undefined;
  if (body.xmp_meta !== undefined) {
    if (typeof body.xmp_meta !== "object" || body.xmp_meta === null || Array.isArray(body.xmp_meta))
      return { error: "xmp_meta must be an object" };
    const seenKeys = new Set<string>();
    for (const [k, v] of Object.entries(body.xmp_meta)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) return { error: `xmp_meta bad key: ${k}` };
      if (typeof v !== "string") return { error: "xmp_meta values must be strings" };
      const lower = k.toLowerCase();
      if (lower === "jobid" || lower === "model") return { error: `xmp_meta key reserved: ${k}` };
      if (seenKeys.has(lower)) return { error: `xmp_meta key collides case-insensitively: ${k}` };
      seenKeys.add(lower);
    }
    if (JSON.stringify(body.xmp_meta).length > 4096) return { error: "xmp_meta too large (4KB)" };
    xmpMeta = body.xmp_meta;
  }

  const id = randomUUID();
  let mode: "generate" | "edit" = "generate";
  let inputPath: string | undefined;
  let input: { b64?: string; url?: string } | undefined;

  let b64 = typeof body.image_b64 === "string" ? body.image_b64 : undefined;
  if (typeof body.image_ref === "string") {
    b64 = inputs?.[body.image_ref];
    if (typeof b64 !== "string") return { error: `image_ref ${body.image_ref} not in inputs` };
  }
  if (typeof body.image_url === "string" || b64 !== undefined) {
    if (transparent) return { error: "transparent+edit not supported" };
    mode = "edit";
    inputPath = join(cfg.inputsDir, `${id}.img`);
    if (typeof body.image_url === "string") {
      // 只做同步校验，下载挪到 worker（2026-07-25）：原图常是几 MB 的跨洋拉取
      //（VoiceDrop 的 image_url 指向 CF/R2），同步下载让提交方干等 5–8s 才拿到
      // 202。校验（协议/内网 IP 黑名单）保持在提交时同步做，坏 URL 依旧当场 400；
      // 下载失败改走 job 失败 + 回调（提交方 VoiceDrop 的失败回调会把原图写回，
      // 文章不烂）。真正的 fetch 在 worker.downloadInput，同样 redirect:"manual"。
      let target: URL;
      try { target = new URL(body.image_url); } catch { return { error: "image_url invalid" }; }
      if (target.protocol !== "http:" && target.protocol !== "https:") return { error: "image_url must be http(s)" };
      if (isBlockedHost(target.hostname)) return { error: "image_url host not allowed" };
      input = { url: target.toString() };
    } else {
      if (Buffer.byteLength(b64!, "base64") > cfg.maxInputBytes) return { error: "input image too large" };
      input = { b64 };
    }
  }

  const key = typeof body.key === "string" ? body.key.slice(0, 300) : undefined;
  const job: Job = {
    id, status: "queued", mode, prompt,
    params: { size, format, quality, compression: body.compression, transparent },
    inputPath, inputUrl: input?.url, percent: 0, error: null,
    callbackUrl: typeof body.callback_url === "string" ? body.callback_url : undefined,
    callbackToken: typeof body.callback_token === "string" ? body.callback_token : undefined,
    callbackMeta: body.callback_meta,
    xmpPrompt: body.xmp_prompt !== false,
    xmpMeta,
    enginePref: enginePref === "auto" ? undefined : enginePref,
    group,
    ...(key ? { key } : {}),
    createdAt: new Date().toISOString(),
  };
  return { job, input };
}

async function persist(p: { job: Job; input?: { b64?: string } }, cfg: Config, store: JobStore): Promise<void> {
  if (p.input?.b64 !== undefined && p.job.inputPath) {
    await mkdir(cfg.inputsDir, { recursive: true });
    await writeFile(p.job.inputPath, Buffer.from(p.input.b64, "base64"));
  }
  await store.create(p.job);
}

async function submitJob(body: any, cfg: Config, store: JobStore, worker: Worker, res: ServerResponse): Promise<void> {
  const p = parseJob(body, cfg, worker);
  if ("error" in p) return sendJson(res, 400, { error: p.error });
  await persist(p, cfg, store);
  await worker.submitSingle(p.job);
  sendJson(res, 202, {
    job_id: p.job.id, status: "queued", poll_url: `/api/jobs/${p.job.id}`, events_url: `/api/jobs/${p.job.id}/events`,
    size: p.job.params.size, deadline_at: null,
  });
}

/**
 * 一批图（一本书的所有页）：整批交给 engine-router，一批一个引擎、按账号并发排队。
 * body: {items:[同单张的请求体 + key], inputs?:{name: base64}, group?, label?, engine?}
 */
async function submitBatch(body: any, cfg: Config, store: JobStore, worker: Worker, res: ServerResponse): Promise<void> {
  const raw = Array.isArray(body?.items) ? body.items : [];
  if (!raw.length || raw.length > 200) return sendJson(res, 400, { error: "items must be 1–200 images" });
  const inputs = body.inputs && typeof body.inputs === "object" ? (body.inputs as Record<string, string>) : undefined;
  const engine = body.engine ?? "auto";
  if (!VALID_ENGINE.has(engine)) return sendJson(res, 400, { error: "bad engine" });
  const parsed: { job: Job; input?: { b64?: string } }[] = [];
  for (const [i, it] of raw.entries()) {
    // 一批只有一个引擎、一个 group：批次级的说了算
    const p = parseJob({ ...it, group: body.group ?? it?.group, engine }, cfg, worker, inputs);
    if ("error" in p) return sendJson(res, 400, { error: `items[${i}]: ${p.error}` });
    parsed.push(p);
  }
  for (const p of parsed) await persist(p, cfg, store);
  let batch: RouterBatch;
  try {
    batch = await worker.submitBatch(parsed.map((p) => p.job), {
      ...(body.group ? { group: String(body.group) } : {}),
      ...(typeof body.label === "string" ? { label: body.label.slice(0, 120) } : {}),
      ...(engine !== "auto" ? { engine } : {}),
      priority: "batch",
    });
  } catch (e: any) {
    for (const p of parsed) await worker.fail(p.job, { code: "router_unavailable", message: e?.message ?? String(e) }, 0);
    return sendJson(res, 503, { error: `engine-router rejected the batch: ${e?.message ?? e}` });
  }
  sendJson(res, 202, await batchView(batch, cfg, store));
}

/** router 的批次视图 + 每张图在 paint 这边的结果（result_url 等） */
async function batchView(b: RouterBatch, cfg: Config, store: JobStore) {
  const items = [];
  for (const it of b.items) {
    const j = await store.get(it.job_id);
    const pj = j ? publicJob(j, cfg) : null;
    items.push({
      key: it.key, job_id: it.job_id,
      // 终态以 paint 为准（结果文件在这里）；排队 / 在画以 router 为准
      status: j?.status === "done" || j?.status === "failed" ? j.status : it.status,
      attempts: it.attempts, result_url: pj?.result_url ?? null,
      engine: pj?.engine ?? null, model: pj?.model ?? null,
      error: j?.status === "failed" && j.error ? { code: j.error.code, message: j.error.message } : it.error,
    });
  }
  return {
    batch_id: b.batch_id, status: b.status, engine: b.engine === "gpt-image" ? "codex" : b.engine,
    decided_reason: b.decided_reason, group: b.group, label: b.label,
    paused_until: b.paused_until, pause_reason: b.pause_reason,
    created_at: b.created_at, finished_at: b.finished_at, counts: b.counts, items,
  };
}

function publicJob(j: Job, cfg: Config) {
  const ext = j.resultPath ? extname(j.resultPath).slice(1) : null;
  return {
    job_id: j.id, status: j.status, percent: j.percent, mode: j.mode,
    prompt: j.prompt,
    result_url: j.status === "done" && ext ? `${cfg.publicBaseUrl}/results/${j.id}.${ext}` : null,
    format: j.format ?? null, size: j.size ?? null, bytes: j.bytes ?? null,
    error: j.error ?? null, attempts: j.attempts ?? null,
    engine: j.engine ?? null, model: j.model ?? null, fallback_reason: null,
    engine_pref: j.enginePref ?? "auto", group: j.group ?? null, batch_id: j.batchId ?? null, key: j.key ?? null,
    created_at: j.createdAt, done_at: j.doneAt ?? null,
    // 排队在 engine-router（可能排一阵子）；期限从开画算
    deadline_at: j.status === "running" && j.startedAt ? new Date(Date.parse(j.startedAt) + cfg.jobDeadlineMs).toISOString() : null,
  };
}

async function sseEvents(id: string, cfg: Config, store: JobStore, hub: EventHub, res: ServerResponse): Promise<void> {
  const exists = await store.get(id);
  if (!exists) return sendJson(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  let ping: ReturnType<typeof setInterval>;
  const off = hub.subscribe(id, (event, data) => {
    send(event, data);
    if (event === "done" || event === "failed") { off(); clearInterval(ping); if (!res.writableEnded) res.end(); }
  });
  ping = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 15000);
  res.on("close", () => { off(); clearInterval(ping); });
  // Re-read AFTER subscribing so a terminal event fired during this read isn't lost.
  const job = (await store.get(id)) ?? exists;
  send("progress", { percent: job.percent });
  if (job.status === "done") { off(); clearInterval(ping); send("done", publicJob(job, cfg)); if (!res.writableEnded) res.end(); }
  else if (job.status === "failed") { off(); clearInterval(ping); send("failed", { error: job.error }); if (!res.writableEnded) res.end(); }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  await mkdir(cfg.jobsDir, { recursive: true });
  await mkdir(cfg.resultsDir, { recursive: true });
  await mkdir(cfg.inputsDir, { recursive: true });
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg);
  await worker.start(await store.recover());
  setInterval(() => { sweep(store, cfg).then((r) => r.deleted && console.log(`[cleanup] removed ${r.deleted} expired jobs`)).catch((e) => console.error("[cleanup]", e)); }, 6 * 60 * 60 * 1000);
  const app = createApp(cfg, { store, hub, worker });
  app.listen(cfg.port, cfg.host, () => console.log(`paint listening on ${cfg.host}:${cfg.port}`));
}

// run main() only when executed directly (not when imported by tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
