// src/alert.ts — 管理员推送（worker POST /agent/push/admin，用发布账号的 token 鉴权，
// 与 claude-agent bookmeta.ts 的 notifyAdmin 同一条路）。按 key 节流，尽力而为。
import { ADMIN_PUSH_URL } from "./env.js";

const THROTTLE_MS = 2 * 3600_000;
const last = new Map<string, number>();

export async function alertAdmin(key: string, title: string, body: string, token: string | undefined, now = Date.now()): Promise<void> {
  console.log(`[alert] ${title} — ${body}`);
  if (!token) return;
  if (now - (last.get(key) ?? 0) < THROTTLE_MS) return;
  last.set(key, now);
  try {
    const r = await fetch(ADMIN_PUSH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: body.slice(0, 300) }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`[alert] push status=${r.status}`);
  } catch (e) {
    console.error("[alert] push failed", e);
  }
}
