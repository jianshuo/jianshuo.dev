// paint-client.mjs — bin/paint 与 bin/paint-batch 共用的唯一出图客户端（2026-10-02 统一）。
//
// 只做三件事：提交 POST /api/jobs → 轮询 GET /api/jobs/:id 到终态 → 下载结果。
// 引擎选择、自动降级、额度冷却、限流重试、尺寸规整、group 风格粘性全在 paint 服务端，
// 客户端只知道「成功」或「失败(code: message)」。接口与错误码说明：paint/USAGE.md。
import { readFileSync, writeFileSync } from "node:fs";

export const API = (process.env.PAINT_API || "http://127.0.0.1:8788").replace(/\/$/, "");
const POLL_MS = Number(process.env.PAINT_POLL_MS || 5000);
/** 服务端没回 deadline_at 时的兜底等待（服务端期限 8 分钟 + 1 分钟余量） */
const FALLBACK_WAIT_MS = 9 * 60 * 1000;

function token() {
  const t = process.env.PAINT_API_TOKEN;
  if (!t) throw Object.assign(new Error("PAINT_API_TOKEN not set"), { code: "client_config" });
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 错误统一成「code: message」——别再打出 [object Object] */
export function formatError(err) {
  if (!err) return "unknown: no error detail";
  if (typeof err === "string") return err;
  const code = err.code || "error";
  const msg = err.message || (typeof err.error === "string" ? err.error : JSON.stringify(err));
  return `${code}: ${msg}`;
}

/** 格式不给就按输出扩展名定：.jpg/.jpeg→jpeg、.webp→webp、其余→png */
export function formatFor(out) {
  const o = String(out).toLowerCase();
  if (o.endsWith(".jpg") || o.endsWith(".jpeg")) return "jpeg";
  if (o.endsWith(".webp")) return "webp";
  return "png";
}

/**
 * 一张图的参数 → 请求体。opts: {prompt, out, image?, size?, transparent?, quality?, format?,
 * compression?, engine?, group?}。jpeg/webp 不给 compression 一律 80（书里统一 JPG q80）。
 */
export function buildBody(opts) {
  const format = opts.format || formatFor(opts.out);
  const b = { prompt: opts.prompt, size: opts.size || "1024x1024", format };
  if (opts.transparent) b.transparent = true;
  if (opts.quality) b.quality = opts.quality;
  if (format !== "png") b.compression = opts.compression != null && opts.compression !== "" ? Number(opts.compression) : 80;
  if (opts.engine) b.engine = opts.engine;
  if (opts.group) b.group = opts.group;
  if (opts.image) b.image_b64 = readFileSync(opts.image).toString("base64");
  return b;
}

async function api(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
  return { status: r.status, json };
}

/** 提交，返回 {job_id, deadline_at, size}；被拒抛 {code:"rejected", message} */
export async function submit(body) {
  const { status, json } = await api("/api/jobs", { method: "POST", body: JSON.stringify(body) });
  if (status !== 202 || !json.job_id) {
    throw Object.assign(new Error(`HTTP ${status} ${json.error || ""}`.trim()), { code: "rejected" });
  }
  return json;
}

/** 轮询到 done/failed；超出服务端期限 + 60s 仍无终态 → {status:"timeout"} */
export async function waitJob(jobId, deadlineAt, onTick) {
  const until = (deadlineAt ? Date.parse(deadlineAt) + 60_000 : Date.now() + FALLBACK_WAIT_MS);
  let last;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    try {
      const { status, json } = await api(`/api/jobs/${jobId}`);
      if (status === 200) {
        last = json;
        if (json.status === "done" || json.status === "failed") return json;
        onTick?.(json);
      }
    } catch { /* 网络抖一下，下一轮再问 */ }
  }
  return { ...(last || {}), job_id: jobId, status: "timeout", error: { code: "client_timeout", message: `no result by ${new Date(until).toISOString()}` } };
}

/**
 * 画一张：提交 → 等 → 下载到 opts.out。永不抛错，返回
 * {ok, out, job_id, result_url, engine, model, fallback_reason, error?:{code,message}, secs}
 */
export async function paintOne(opts, onTick) {
  const t0 = Date.now();
  const base = { ok: false, out: opts.out, job_id: null, result_url: null, engine: null, model: null, fallback_reason: null };
  try {
    const sub = await submit(buildBody(opts));
    onTick?.({ status: "submitted", job_id: sub.job_id });
    const j = await waitJob(sub.job_id, sub.deadline_at, onTick);
    const info = { ...base, job_id: sub.job_id, engine: j.engine ?? null, model: j.model ?? null, fallback_reason: j.fallback_reason ?? null };
    if (j.status !== "done") return { ...info, error: j.error || { code: "unknown", message: j.status }, secs: (Date.now() - t0) / 1000 };
    // 从 API 同一个地址拉结果（/results 在 paint 服务上，公开 URL 只是它经 Caddy 的外名）：
    // VPS 上 node 解析不了自己的公网域名（ENOTFOUND，2026-10-02 实测），走 127.0.0.1 也省一趟出网。
    const ru = new URL(j.result_url);
    const img = await fetch(`${API}${ru.pathname}${ru.search}`);
    if (!img.ok) return { ...info, error: { code: "download_failed", message: `HTTP ${img.status} ${j.result_url}` }, secs: (Date.now() - t0) / 1000 };
    writeFileSync(opts.out, Buffer.from(await img.arrayBuffer()));
    return { ...info, ok: true, result_url: j.result_url, secs: (Date.now() - t0) / 1000 };
  } catch (e) {
    return { ...base, error: { code: e.code || "client_error", message: e.message || String(e) }, secs: (Date.now() - t0) / 1000 };
  }
}

/**
 * 从图片内嵌的 XMP（paint:Model）判断它是哪个引擎画的：codex | seedream | null（不是 paint 出的/读不到）。
 * 给「整本书统一画风」的对账用：画完一批后查谁是少数派。
 */
export function engineOfFile(path) {
  try {
    const buf = readFileSync(path);
    const m = buf.toString("latin1").match(/paint:Model="([^"]+)"/);
    if (!m) return null;
    return /seedream/i.test(m[1]) ? "seedream" : "codex";
  } catch {
    return null;
  }
}

/** 一组文件的引擎分布：{counts:{codex,seedream,unknown}, majority, minority:[path…]} */
export function engineTally(paths) {
  const by = { codex: [], seedream: [], unknown: [] };
  for (const p of paths) by[engineOfFile(p) ?? "unknown"].push(p);
  const counts = { codex: by.codex.length, seedream: by.seedream.length, unknown: by.unknown.length };
  // 平票取 seedream：Seedream 不受 Codex 额度影响，重画成它更稳
  const majority = counts.codex === 0 && counts.seedream === 0 ? null : counts.codex > counts.seedream ? "codex" : "seedream";
  const minority = majority ? by[majority === "codex" ? "seedream" : "codex"] : [];
  return { counts, majority, minority };
}

/** 一行人话：engine: seedream (doubao-…) — fallback: … */
export function engineLine(r) {
  if (!r.engine) return "";
  return `engine: ${r.engine}${r.model ? ` (${r.model})` : ""}${r.fallback_reason ? ` — fallback: ${r.fallback_reason}` : ""}`;
}
