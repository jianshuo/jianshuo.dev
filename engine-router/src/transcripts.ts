// src/transcripts.ts — 回看用：把一个 run 的每次 attempt 对到引擎落盘的原始对话记录。
//
// 引擎进程以 engine-router 用户跑，对话记录是 0600：Claude/Kimi 在
// HOME/.claude/projects/<cwd>/<session>.jsonl，Codex 在 codex_home/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl。
// 调用方（lab 侧栏）读不到这些文件，只能经 router 的 GET /v1/runs/:id/transcript 按字节偏移增量取。
//
// attempt.sessionId 要跑完才写进 run 记录；跑的过程中只有事件流里的 {type:"session",attempt,id}。
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config, EngineName } from "./config.js";
import { HOME, RUNS_DIR } from "./env.js";
import { eventsFile, type RunRecord } from "./runs.js";

export type AttemptSession = { attempt: number; engine: EngineName; account: string; sessionId: string };

const SID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** 从磁盘读 run 记录（内存里只留最近一天的，磁盘留 14 天）。 */
export async function readRunRecord(id: string): Promise<RunRecord | null> {
  if (!/^r_[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(RUNS_DIR, id + ".json"), "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

/** 磁盘上全部 run 记录（不含 attempt/result 等附属文件）。 */
export async function listRunRecords(): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (const f of await readdir(RUNS_DIR).catch(() => [] as string[])) {
    const m = /^(r_[A-Za-z0-9_-]+)\.json$/.exec(f);
    if (!m) continue;
    const r = await readRunRecord(m[1]);
    if (r) out.push(r);
  }
  return out;
}

/** 每次 attempt 的会话号：事件流里最后一条 session 事件优先，没有就用结束时写回的 sessionId。 */
export async function attemptSessions(r: RunRecord): Promise<AttemptSession[]> {
  const fromEvents = new Map<number, string>();
  try {
    for (const ln of (await readFile(eventsFile(r.id), "utf8")).split("\n")) {
      if (!ln.includes('"session"')) continue;
      try {
        const ev = JSON.parse(ln);
        if (ev.type === "session" && typeof ev.id === "string") fromEvents.set(Number(ev.attempt) || 1, ev.id);
      } catch {}
    }
  } catch {}
  const out: AttemptSession[] = [];
  for (const a of r.attempts) {
    const sid = fromEvents.get(a.n) ?? a.sessionId;
    if (sid && SID_RE.test(sid)) out.push({ attempt: a.n, engine: a.engine, account: a.accountId, sessionId: sid });
  }
  return out;
}

const pathCache = new Map<string, string>();

/** 找到这次 attempt 的对话记录文件；找不到（还没落盘 / 已被清理）返回 null。 */
export async function findTranscriptFile(cfg: Config, s: AttemptSession): Promise<string | null> {
  const ck = `${s.engine}|${s.account}|${s.sessionId}`;
  const hit = pathCache.get(ck);
  if (hit && (await stat(hit).catch(() => null))) return hit;
  const acct = cfg.engines[s.engine]?.accounts.find((a) => a.id === s.account);
  let found: string | null = null;
  if (s.engine === "codex") {
    const root = acct?.codex_home ? join(acct.codex_home, "sessions") : null;
    if (root) found = await findCodexRollout(root, s.sessionId);
  } else if (s.engine === "claude" || s.engine === "kimi") {
    const base = acct?.env?.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
    const projects = join(base, "projects");
    for (const d of await readdir(projects).catch(() => [] as string[])) {
      const p = join(projects, d, s.sessionId + ".jsonl");
      if (await stat(p).catch(() => null)) {
        found = p;
        break;
      }
    }
  }
  if (found) pathCache.set(ck, found);
  return found;
}

async function findCodexRollout(root: string, sid: string): Promise<string | null> {
  const desc = async (d: string) => (await readdir(d).catch(() => [] as string[])).sort().reverse();
  for (const y of await desc(root))
    for (const m of await desc(join(root, y)))
      for (const d of await desc(join(root, y, m)))
        for (const f of await desc(join(root, y, m, d))) if (f.endsWith(`-${sid}.jsonl`)) return join(root, y, m, d, f);
  return null;
}
