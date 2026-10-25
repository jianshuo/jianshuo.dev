// src/router.ts — 向 engine-router 租「这张图用谁画」（2026-10-25）。
//
// 额度的唯一裁决者是 engine-router（同机服务，见 engine-router/README）：它同时看着写书和
// 出图对同一个 ChatGPT 账号的消耗，按 5h 红线、周配速、冷却、Seedream 日上限决定这张图给
// gpt-image（Codex）还是 seedream。paint 只负责执行（自己的 Codex 链、gpt-image-2-skill、
// 方舟、后处理），画完回报结果。
//
// 硬约束：router 出任何问题（没配、连不上、超时、返回乱码）都不能连累出图——decide 返回
// undefined，worker 退回原来的本地逻辑（进程内冷却 + 自动降级）。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type RouterDecision = {
  leaseId: string | null;
  engine: "codex" | "seedream" | null; // null = router 说现在谁都不合格
  reason: string;
};

export type DecideRequest = {
  require: ("gpt-image" | "seedream")[];
  force: boolean;
  jobId: string;
};

export type CompleteRequest = {
  ok: boolean;
  engineUsed: "codex" | "seedream";
  codexError?: string; // 租到 gpt-image 时 Codex 的报错原文（额度类会让 router 冷却它）
};

export interface EngineRouter {
  decide(req: DecideRequest): Promise<RouterDecision | undefined>;
  complete(leaseId: string, res: CompleteRequest): Promise<void>;
}

const TIMEOUT_MS = 5000;

function call(url: string, token: string, path: string, body: unknown): Promise<any> {
  const unix = url.startsWith("unix:");
  const base = unix ? new URL("http://router/") : new URL(url.endsWith("/") ? url : url + "/");
  const u = new URL(path, base);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = (base.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        socketPath: unix ? url.slice(5) : undefined,
        hostname: unix ? undefined : u.hostname,
        port: unix ? undefined : u.port || undefined,
        path: u.pathname,
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`router ${res.statusCode}: ${text.slice(0, 200)}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("router returned non-JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("router timeout")));
    req.on("error", reject);
    req.end(payload);
  });
}

export function httpRouter(url: string, token: string): EngineRouter {
  return {
    async decide(r) {
      try {
        const j = await call(url, token, "v1/leases", {
          kind: "image",
          task_class: "image",
          engine_hints: { require: r.require },
          force: r.force,
        });
        const engine = j.engine === "gpt-image" ? "codex" : j.engine === "seedream" ? "seedream" : null;
        const reason = engine ? `router lease ${j.lease_id} → ${j.account}` : `router: no engine available (${(j.reasons ?? []).join("; ")})`;
        return { leaseId: j.lease_id ?? null, engine, reason };
      } catch (e: any) {
        console.warn(`[router] decide failed for ${r.jobId}, falling back to local logic: ${e?.message ?? e}`);
        return undefined;
      }
    },
    async complete(leaseId, r) {
      try {
        await call(url, token, `v1/leases/${leaseId}/complete`, {
          ok: r.ok,
          engine_used: r.engineUsed === "codex" ? "gpt-image" : "seedream",
          ...(r.codexError ? { error: r.codexError } : {}),
        });
      } catch (e: any) {
        console.warn(`[router] complete ${leaseId} failed (lease will expire on its own): ${e?.message ?? e}`);
      }
    },
  };
}
