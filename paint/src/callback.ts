import { createHmac } from "node:crypto";

export interface CallbackPayload {
  job_id: string;
  status: "done" | "failed";
  result_url: string | null;
  format: string | null;
  size: string | null;
  bytes: number | null;
  error: { code: string; message: string } | null;
  callback_meta: unknown;
  /** 实际出图（或栽在）哪个引擎：codex | seedream（2026-10-02 起） */
  engine: "codex" | "seedream" | null;
  /** codex = 外层 Codex 模型（出图的是它委托的 gpt-image-2）；seedream = 方舟模型 id */
  model: string | null;
  /** 为什么没走 codex（额度/冷却/模型全拒/瞬时限流/group 粘性）；正常走 codex 或显式 seedream 时为 null */
  fallback_reason: string | null;
}

export function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deliver(
  url: string,
  token: string | undefined,
  payload: CallbackPayload,
  secret: string,
  opts: { retries?: number; delayMs?: (attempt: number) => number; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: boolean; attempts: number }> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? ((n) => 1000 * 2 ** (n - 1));
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Paint-Job": payload.job_id,
    "X-Paint-Signature": sign(body, secret),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let attempts = 0;
  for (let n = 1; n <= retries; n++) {
    attempts = n;
    try {
      const res = await doFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, attempts };
    } catch {
      /* network error → retry */
    }
    if (n < retries) await sleep(delayMs(n));
  }
  return { ok: false, attempts };
}
