// src/router.ts — paint 和 engine-router 之间的出图批次协议（2026-10-28）。
//
// 调度全在 engine-router（engine-router/src/batches.ts）：一批图交过去，它按整批定一个引擎，
// 按账号并发排队。paint 只执行：
//   交批      POST /v1/image-batches            {items:[{job_id,key?,transparent?}], group?, label?, engine?, priority?}
//   领活      POST /v1/image-jobs/claim         {max} → {items:[{job_id, batch_id, engine}]}
//   回报      POST /v1/image-jobs/:id/complete  {ok, error?}（error 带引擎报错原文，router 据此冷却 / 暂停）
//   心跳      POST /v1/image-jobs/heartbeat     {job_ids} → {stop:[…]}（批次被取消的要停下）
//   重启交还  POST /v1/image-jobs/release-all
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const TIMEOUT_MS = 10_000;

export type ImageEngine = "gpt-image" | "seedream";
export type Claim = { job_id: string; batch_id: string; engine: ImageEngine };
export type BatchItemIn = { job_id: string; key?: string; transparent?: boolean };
export type BatchIn = {
  items: BatchItemIn[];
  group?: string;
  label?: string;
  engine?: "codex" | "seedream";
  priority?: "interactive" | "batch";
};
/** router 的批次视图（publicBatch） */
export type RouterBatch = {
  batch_id: string;
  status: string;
  engine: ImageEngine | null;
  account: string | null;
  decided_reason: string | null;
  group: string | null;
  label: string | null;
  paused_until: string | null;
  pause_reason: string | null;
  created_at: string;
  finished_at: string | null;
  counts: Record<string, number>;
  items: { job_id: string; key: string | null; status: string; attempts: number; error: string | null }[];
};

export interface ImageRouter {
  submitBatch(b: BatchIn): Promise<RouterBatch>;
  getBatch(id: string): Promise<RouterBatch | null>;
  cancelBatch(id: string): Promise<RouterBatch | null>;
  claim(max: number): Promise<Claim[]>;
  /** 返回 router 对这张的判定：done / failed（终判）/ queued（放回队列：撞墙暂停或被打断重排） */
  complete(jobId: string, r: { ok: boolean; error?: string }): Promise<{ status?: string }>;
  heartbeat(jobIds: string[]): Promise<string[]>;
  releaseAll(): Promise<number>;
}

export class RouterError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function call(url: string, token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const unix = url.startsWith("unix:");
  const base = unix ? new URL("http://router/") : new URL(url.endsWith("/") ? url : url + "/");
  const u = new URL(path, base);
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = (base.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        socketPath: unix ? url.slice(5) : undefined,
        hostname: unix ? undefined : u.hostname,
        port: unix ? undefined : u.port || undefined,
        path: u.pathname,
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let j: any;
          try {
            j = JSON.parse(text);
          } catch {
            return reject(new RouterError(res.statusCode ?? 0, "router returned non-JSON"));
          }
          if ((res.statusCode ?? 0) >= 300) return reject(new RouterError(res.statusCode ?? 0, j?.error ?? `router ${res.statusCode}`));
          resolve(j);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("router timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

export function httpRouter(url: string, token: string): ImageRouter {
  const orNull = async (p: Promise<any>) => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof RouterError && e.status === 404) return null;
      throw e;
    }
  };
  return {
    submitBatch: (b) => call(url, token, "POST", "v1/image-batches", b),
    getBatch: (id) => orNull(call(url, token, "GET", `v1/image-batches/${encodeURIComponent(id)}`)),
    cancelBatch: (id) => orNull(call(url, token, "POST", `v1/image-batches/${encodeURIComponent(id)}/cancel`, {})),
    claim: async (max) => (await call(url, token, "POST", "v1/image-jobs/claim", { max })).items ?? [],
    complete: (jobId, r) => call(url, token, "POST", `v1/image-jobs/${encodeURIComponent(jobId)}/complete`, r),
    heartbeat: async (jobIds) => (await call(url, token, "POST", "v1/image-jobs/heartbeat", { job_ids: jobIds })).stop ?? [],
    releaseAll: async () => (await call(url, token, "POST", "v1/image-jobs/release-all", {})).released ?? 0,
  };
}
