// paint-client.mjs — bin/paint 的出图客户端（2026-10-28 起一切出图都是「批次」）。
//
// 一批图（一本书的所有页，或单张 = 1 张的批次）一次交给 paint POST /api/batches，paint 转交
// engine-router：一批一个引擎（同一本书 group 的各批也同一个引擎）、按账号并发排队画完。
// 客户端只做：交批 → 轮询进度 → 画好一张下载一张。等不完（Bash 单条 10 分钟上限）就退出码 3，
// 原样重跑同一条命令接着等同一批（状态文件记着批次号），不会重复画。接口说明：paint/USAGE.md。
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export const API = (process.env.PAINT_API || "http://127.0.0.1:8788").replace(/\/$/, "");
const POLL_MS = Number(process.env.PAINT_POLL_MS || 5000);
/** 一条命令最多等多久（agent 单条 Bash 上限 10 分钟，留 1 分钟余量） */
const WAIT_MS = Number(process.env.PAINT_WAIT_MS || 9 * 60 * 1000);
const TERMINAL = new Set(["done", "failed", "cancelled"]);

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
 * 一张图的参数 → 批次里的一项。it: {out, prompt, image?, size?, transparent?, quality?, format?, compression?}。
 * jpeg/webp 不给 compression 一律 80（书里统一 JPG q80）；不给 quality 一律 medium（high 太吃 Codex 额度）。
 * 参考图不内联：返回 image 路径，由 buildBatch 去重成 inputs + image_ref（一批里同一张图只传一次）。
 */
export function buildItem(it) {
  const format = it.format || formatFor(it.out);
  const b = { key: resolve(it.out), prompt: it.prompt, size: it.size || "1024x1024", format, quality: it.quality || "medium" };
  if (it.transparent) b.transparent = true;
  if (format !== "png") b.compression = it.compression != null && it.compression !== "" ? Number(it.compression) : 80;
  return b;
}

export function buildBatch(items, { group, engine, label } = {}) {
  const inputs = {};
  const refOf = new Map();
  const out = items.map((it) => {
    const b = buildItem(it);
    if (it.image) {
      const p = resolve(it.image);
      if (!refOf.has(p)) {
        refOf.set(p, `i${refOf.size}`);
        inputs[refOf.get(p)] = readFileSync(p).toString("base64");
      }
      b.image_ref = refOf.get(p);
    }
    return b;
  });
  const body = { items: out };
  if (refOf.size) body.inputs = inputs;
  if (group) body.group = group;
  if (engine && engine !== "auto") body.engine = engine;
  if (label) body.label = label;
  return body;
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

async function download(item) {
  // 从 API 同一个地址拉结果（/results 在 paint 服务上，公开 URL 只是它经 Caddy 的外名）：
  // VPS 上 node 解析不了自己的公网域名（ENOTFOUND，2026-10-02 实测），走 127.0.0.1 也省一趟出网。
  const ru = new URL(item.result_url);
  const img = await fetch(`${API}${ru.pathname}${ru.search}`);
  if (!img.ok) throw Object.assign(new Error(`HTTP ${img.status} ${item.result_url}`), { code: "download_failed" });
  writeFileSync(item.key, Buffer.from(await img.arrayBuffer()));
}

const readState = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const dropState = (f) => { try { unlinkSync(f); } catch {} };

/**
 * 画一批：items = [{out, prompt, image?, …}]，opts = {group, engine, label, force, stateFile, onItem, onWait}。
 * 永不抛错，返回 {status: "done"|"failed"|"waiting", batch, results:[{out, ok, skipped?, engine, model, error?}]}。
 *   done     全部画好（含本来就存在、跳过的）
 *   failed   批次结束但有图失败（失败的单独重跑同一命令即可，画好的自动跳过）
 *   waiting  WAIT_MS 内没画完：原样重跑同一条命令接着等同一批
 */
export async function paintBatch(items, opts = {}) {
  const results = new Map(items.map((it) => [resolve(it.out), { out: it.out, ok: false, engine: null, model: null }]));
  const todo = items.filter((it) => opts.force || !existsSync(it.out));
  for (const it of items) if (!todo.includes(it)) Object.assign(results.get(resolve(it.out)), { ok: true, skipped: true });
  const finish = (status, batch) => ({ status, batch, results: [...results.values()] });
  if (!todo.length) return finish("done", null);

  const stateFile = opts.stateFile;
  let batch = null;
  try {
    // 上次没等完：接着用同一批——还在画就接着等，已经画完就直接下载（不重交，不重复画）
    const st = stateFile && !opts.force ? readState(stateFile) : null;
    if (st?.batch_id) {
      const { status, json } = await api(`/api/batches/${st.batch_id}`);
      if (status === 200) batch = json;
      else dropState(stateFile);
    }
    if (!batch) {
      const { status, json } = await api("/api/batches", { method: "POST", body: JSON.stringify(buildBatch(todo, opts)) });
      if (status !== 202 || !json.batch_id) throw Object.assign(new Error(`HTTP ${status} ${json.error || ""}`.trim()), { code: "rejected" });
      batch = json;
      if (stateFile) writeFileSync(stateFile, JSON.stringify({ batch_id: batch.batch_id, at: new Date().toISOString() }));
    }
  } catch (e) {
    for (const it of todo) results.get(resolve(it.out)).error = { code: e.code || "client_error", message: e.message || String(e) };
    return finish("failed", batch);
  }

  const until = Date.now() + WAIT_MS;
  const reported = new Set();
  while (true) {
    for (const item of batch.items || []) {
      const r = results.get(item.key);
      if (!r || reported.has(item.key)) continue;
      Object.assign(r, { engine: item.engine, model: item.model, job_id: item.job_id, result_url: item.result_url ?? null });
      if (item.status === "done" && item.result_url) {
        try {
          if (opts.force || !existsSync(item.key)) await download(item);
          r.ok = true;
          delete r.error;
        } catch (e) {
          r.error = { code: e.code || "download_failed", message: e.message };
        }
        reported.add(item.key);
        opts.onItem?.(r);
      } else if (item.status === "failed") {
        r.error = item.error || { code: "failed", message: "failed" };
        reported.add(item.key);
        opts.onItem?.(r);
      }
    }
    if (TERMINAL.has(batch.status)) break;
    if (Date.now() >= until) {
      opts.onWait?.(batch);
      return finish("waiting", batch);
    }
    await sleep(POLL_MS);
    try {
      const { status, json } = await api(`/api/batches/${batch.batch_id}`);
      if (status === 200) batch = json;
      else if (status === 404) break;
    } catch { /* 网络抖一下，下一轮再问 */ }
  }
  if (stateFile) dropState(stateFile);
  const all = [...results.values()];
  for (const r of all) if (!r.ok && !r.error) r.error = { code: batch.status === "cancelled" ? "cancelled" : "failed", message: `batch ${batch.status}` };
  return finish(all.every((r) => r.ok) ? "done" : "failed", batch);
}

/** 一行人话：engine: seedream (doubao-…) */
export function engineLine(r) {
  if (!r.engine) return "";
  return `engine: ${r.engine}${r.model ? ` (${r.model})` : ""}`;
}

/** 批次在等什么：排队 / 在画 / 暂停原因 */
export function waitingLine(b) {
  const c = b?.counts || {};
  const paused = b?.status === "paused" ? `，暂停到 ${b.paused_until}（${b.pause_reason}）` : "";
  return `还在画：完成 ${c.done ?? 0}/${c.total ?? "?"}，在画 ${c.running ?? 0}，排队 ${c.queued ?? 0}${paused}`;
}
