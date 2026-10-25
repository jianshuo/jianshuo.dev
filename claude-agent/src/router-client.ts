// src/router-client.ts — engine-router 客户端的副本（真源：engine-router/src/client.ts，改那边再拷过来）。
// 写书引擎用它把整本书交给 router（见 book-engine.ts runBookEngine）。
//
// 原文件头：给调用方的薄客户端，零依赖，可以整个文件拷走用。
//
//   ROUTER_URL   unix:/run/engine-router/router.sock（VPS 本机，缺省）
//                或 https://lab.jianshuo.dev/router（远程）
//   ROUTER_TOKEN 你的调用方 token（.env 里 ROUTER_TOKENS 的一项）
//
//   const out = await runTask({ task_class: "book", prompt, workdir }, (ev) => console.log(ev));
//   // out = { ok, reply, result, error, run_id, thread_id }
//
// 调用方不需要知道背后是哪个引擎、哪个账号；撞墙换账号时只会收到一条 switched 事件。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type RunOptions = {
  prompt: string;
  task_class?: string;
  thread_id?: string;
  continuity?: "strict" | "loose" | "none";
  instructions?: string;
  workdir?: string;
  context_dirs?: string[];
  capabilities?: { shell?: boolean; network?: boolean; write?: boolean };
  env?: Record<string, string>;
  quality?: "best" | "fast";
  engine_hints?: { avoid?: string[]; require?: string[] };
  output_schema?: unknown;
  budget?: { max_turns?: number; timeout_ms?: number; size?: "small" | "medium" | "large" };
  priority?: "user" | "normal" | "background";
  resume_hint?: string;
  idempotency_key?: string;
  callback_url?: string;
  on_exhausted?: "queue" | "fail";
  force?: boolean;
};

export type RouterEvent = { ts: number; type: string; [k: string]: unknown };
export type RunOutcome = { ok: boolean; reply?: string; result?: unknown; error?: string; run_id: string; thread_id: string; status: string };

type Target = { socketPath?: string; base: URL; https: boolean };

function target(url = process.env.ROUTER_URL ?? "unix:/run/engine-router/router.sock"): Target {
  if (url.startsWith("unix:")) return { socketPath: url.slice(5), base: new URL("http://router/"), https: false };
  const base = new URL(url.endsWith("/") ? url : url + "/");
  return { base, https: base.protocol === "https:" };
}

function call(method: string, path: string, body?: unknown, opts: { url?: string; token?: string; stream?: (chunk: string) => void } = {}): Promise<{ status: number; json: any }> {
  const t = target(opts.url);
  const u = new URL(path.replace(/^\//, ""), t.base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = (t.https ? httpsRequest : httpRequest)(
      {
        socketPath: t.socketPath,
        hostname: t.socketPath ? undefined : u.hostname,
        port: t.socketPath ? undefined : u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: {
          Authorization: `Bearer ${opts.token ?? process.env.ROUTER_TOKEN ?? ""}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let text = "";
        res.on("data", (c: string) => (opts.stream && res.statusCode === 200 ? opts.stream(c) : (text += c)));
        res.on("end", () => {
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { error: text.slice(0, 300) };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function submitRun(opts: RunOptions, conn: { url?: string; token?: string } = {}): Promise<any> {
  const r = await call("POST", "v1/runs", opts, conn);
  if (r.status !== 202 && r.status !== 200) throw new Error(`router ${r.status}: ${r.json?.error ?? "submit failed"}`);
  return r.json;
}

export async function getRun(runId: string, conn: { url?: string; token?: string } = {}): Promise<any> {
  const r = await call("GET", `v1/runs/${runId}`, undefined, conn);
  if (r.status !== 200) throw new Error(`router ${r.status}: ${r.json?.error ?? "get failed"}`);
  return r.json;
}

/** 跟随事件流直到 run 结束；断线自动从上次的偏移续上。 */
export async function followRun(runId: string, onEvent?: (ev: RouterEvent) => void, conn: { url?: string; token?: string } = {}): Promise<RunOutcome> {
  let from = 0;
  for (let tries = 0; tries < 1000; tries++) {
    let buf = "";
    try {
      await call("GET", `v1/runs/${runId}/events?from=${from}`, undefined, {
        ...conn,
        stream: (chunk) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const id = /^id: (\d+)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (id) from = Number(id);
            if (data) {
              try {
                onEvent?.(JSON.parse(data));
              } catch {}
            }
          }
        },
      });
    } catch {
      // 网络断了：等一下再续
    }
    const run = await getRun(runId, conn).catch(() => null);
    if (run && ["done", "failed", "cancelled"].includes(run.status))
      return { ok: run.ok, reply: run.reply, result: run.result, error: run.error, run_id: run.run_id, thread_id: run.thread_id, status: run.status };
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("followRun: gave up");
}

/** 提交并等到结束。签名与 claude-agent 的 runBookEngine 对齐，迁移时基本只换 import。 */
export async function runTask(opts: RunOptions, onEvent?: (ev: RouterEvent) => void, conn: { url?: string; token?: string } = {}): Promise<RunOutcome> {
  const run = await submitRun(opts, conn);
  return followRun(run.run_id, onEvent, conn);
}
