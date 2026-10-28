// src/router-sessions.ts — 会话侧栏回看 engine-router 跑的书（2026-10-28）。
//
// 10-25 起写书/修书交给 engine-router，引擎进程以 engine-router 用户跑，对话记录（0600）
// 落在它自己的 HOME / CODEX_HOME 里，本进程读不到——侧栏于是停在 10-25。
// 这里走 router 的两个只读接口：GET /v1/runs 列本调用方的 run（只看得到 ROUTER_TOKEN
// 那个调用方的），GET /v1/runs/:id/transcript?attempt=&offset= 按字节增量取原始 jsonl，
// 镜像到 MIRROR_DIR/<run>.<attempt>.jsonl。镜像文件与本机原生 transcript 同格式，
// server.ts 现成的 Claude / Codex 解析器原样复用（含按字节偏移的增量缓存）。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFile, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_ROOT } from "./env.js";

export const MIRROR_DIR = process.env.ROUTER_MIRROR_DIR ?? join(APP_ROOT, "router-mirror");
export const ROUTER_RUN_ID_RE = /^r_[A-Za-z0-9_-]{6,40}$/;

export type RouterRunSession = { attempt: number; engine: string; account: string; sessionId: string };
export type RouterRun = {
  run_id: string;
  status: string;
  label?: string;
  task_class?: string;
  created_at: string;
  updated_at: string;
  sessions: RouterRunSession[];
};

function rawGet(path: string): Promise<{ status: number; headers: Record<string, any>; body: Buffer }> {
  const url = process.env.ROUTER_URL ?? "unix:/run/engine-router/router.sock";
  const sock = url.startsWith("unix:") ? url.slice(5) : undefined;
  const base = new URL(sock ? "http://router/" : url.endsWith("/") ? url : url + "/");
  const u = new URL(path.replace(/^\//, ""), base);
  return new Promise((resolve, reject) => {
    const req = (base.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        socketPath: sock,
        hostname: sock ? undefined : u.hostname,
        port: sock ? undefined : u.port || undefined,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.ROUTER_TOKEN ?? ""}` },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("router timeout")));
    req.on("error", reject);
    req.end();
  });
}

// 侧栏每次刷新都会来要列表：5 秒内复用上一份，router 挂了就给空表（不拖垮本机会话）
let listCache: { at: number; runs: RouterRun[] } | null = null;

export async function listRouterRuns(): Promise<RouterRun[]> {
  if (!process.env.ROUTER_TOKEN) return [];
  if (listCache && Date.now() - listCache.at < 5000) return listCache.runs;
  try {
    const r = await rawGet("/v1/runs?limit=200");
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const runs = (JSON.parse(r.body.toString("utf8")).runs ?? []) as RouterRun[];
    listCache = { at: Date.now(), runs };
    void pruneMirrors(new Set(runs.map((x) => x.run_id)));
    return runs;
  } catch (e: any) {
    console.error("[router-sessions] list failed:", e?.message ?? e);
    return listCache?.runs ?? [];
  }
}

export async function getRouterRun(id: string): Promise<RouterRun | null> {
  return (await listRouterRuns()).find((r) => r.run_id === id) ?? null;
}

/** 把某次 attempt 的对话记录增量同步到本地镜像，返回镜像路径；router 那边还没有就返回 null。 */
export async function syncTranscript(runId: string, attempt: number): Promise<string | null> {
  await mkdir(MIRROR_DIR, { recursive: true });
  const path = join(MIRROR_DIR, `${runId}.${attempt}.jsonl`);
  const have = (await stat(path).catch(() => null))?.size ?? 0;
  const r = await rawGet(`/v1/runs/${encodeURIComponent(runId)}/transcript?attempt=${attempt}&offset=${have}`);
  if (r.status === 404) return have ? path : null;
  if (r.status !== 200) throw new Error(`router transcript HTTP ${r.status}`);
  const from = Number(r.headers["x-transcript-offset"] ?? 0);
  if (from === have) {
    if (r.body.length) await appendFile(path, r.body);
  } else {
    await writeFile(path, r.body); // router 那边文件变短/被重写：整份重来
  }
  return path;
}

// router 只留 14 天的 run；列表里没了的镜像顺手删掉，免得 VPS 磁盘慢慢涨
async function pruneMirrors(live: Set<string>) {
  if (!live.size) return;
  for (const f of await readdir(MIRROR_DIR).catch(() => [] as string[])) {
    const id = f.replace(/\.\d+\.jsonl$/, "");
    if (id !== f && !live.has(id)) await unlink(join(MIRROR_DIR, f)).catch(() => {});
  }
}
