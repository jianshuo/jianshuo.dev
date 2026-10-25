// src/threads.ts — 会话登记簿。调用方只拿 thread_id；router 记住每个账号上的原生
// 会话号和每一轮的问答，续聊时按三档接上：
//   ① 同一账号      → 原生 resume，历史完整
//   ② 同类引擎他号  → 会话文件不绑凭据，换 token resume（config.portable 开了才用）
//   ③ 跨类          → 把之前每轮的问答压成交接记录放在新会话开头，有损
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acctKey, type Config, type EngineName } from "./config.js";
import { THREADS_DIR, CWD_ROOT } from "./env.js";

export type Turn = { prompt: string; reply: string; account: string; ts: number };
export type Thread = {
  id: string;
  createdAt: number;
  caller: string;
  workdir: string;
  cwd: string;
  runs: string[];
  sessions: Record<string, string>; // 账号键 → 原生会话号
  lastKey?: string;
  turns: Turn[];
};

export type Continuity = "strict" | "loose" | "none";

/** 能互相 resume 的「家族」：Kimi 腿也是 Claude Code CLI，会话文件格式相同。 */
export function familyOf(engine: EngineName): "claude-cli" | "codex" | "other" {
  if (engine === "claude" || engine === "kimi") return "claude-cli";
  if (engine === "codex") return "codex";
  return "other";
}

function portableFamily(cfg: Config, fam: string): boolean {
  return (fam === "claude-cli" && cfg.portable.claude_family) || (fam === "codex" && cfg.portable.codex);
}

const engineOfKey = (k: string) => k.split("/")[0] as EngineName;

/** strict 档允许的账号：上次用的账号 + （开了可移植时）同家族的其他账号。 */
export function strictAllow(cfg: Config, t: Thread): string[] | undefined {
  if (!t.lastKey) return undefined;
  const fam = familyOf(engineOfKey(t.lastKey));
  const out = [t.lastKey];
  if (portableFamily(cfg, fam))
    for (const [e, def] of Object.entries(cfg.engines))
      if (familyOf(e as EngineName) === fam) for (const a of def!.accounts) out.push(acctKey(e as EngineName, a.id));
  return [...new Set(out)];
}

/** 新账号上要不要 resume、resume 哪个会话：返回 { tier, session }。 */
export function continuation(cfg: Config, t: Thread | undefined, key: string): { tier: 0 | 1 | 2 | 3; session?: string } {
  if (!t || !t.turns.length) return { tier: 0 };
  if (t.sessions[key]) return { tier: 1, session: t.sessions[key] };
  const fam = familyOf(engineOfKey(key));
  if (portableFamily(cfg, fam)) {
    // 同家族里最近用过的会话（lastKey 优先）
    const cands = [t.lastKey, ...Object.keys(t.sessions)].filter((k): k is string => !!k && familyOf(engineOfKey(k)) === fam && !!t.sessions[k]);
    if (cands.length) return { tier: 2, session: t.sessions[cands[0]] };
  }
  return { tier: 3 };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…（截断）" : s);

/** 第 ③ 档的交接记录：从最近一轮往前装，总长封顶。 */
export function handoffPrompt(t: Thread, prompt: string, maxChars = 12000): string {
  const blocks: string[] = [];
  let total = 0;
  for (let i = t.turns.length - 1; i >= 0; i--) {
    const turn = t.turns[i];
    const b = `第 ${i + 1} 轮\n用户：${clip(turn.prompt, 1500)}\n答复：${clip(turn.reply, 2500)}`;
    if (total + b.length > maxChars && blocks.length) break;
    blocks.unshift(b);
    total += b.length;
  }
  const skipped = t.turns.length - blocks.length;
  return (
    `【交接记录】这是一段延续中的对话，之前的轮次由另一个助手处理。下面是之前各轮的用户请求和最终答复` +
    (skipped ? `（更早的 ${skipped} 轮已省略）` : "") +
    `；工作目录 ${t.workdir} 里的文件是最新状态，以文件为准。\n\n` +
    blocks.join("\n\n") +
    `\n\n【本轮请求】\n${prompt}`
  );
}

export class ThreadStore {
  private cache = new Map<string, Thread>();

  async get(id: string): Promise<Thread | undefined> {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const t = JSON.parse(await readFile(join(THREADS_DIR, id + ".json"), "utf8")) as Thread;
      this.cache.set(id, t);
      return t;
    } catch {
      return undefined;
    }
  }

  async create(id: string, caller: string, workdir: string): Promise<Thread> {
    const t: Thread = { id, createdAt: Date.now(), caller, workdir, cwd: join(CWD_ROOT, id), runs: [], sessions: {}, turns: [] };
    await this.save(t);
    return t;
  }

  private seq = 0;
  async save(t: Thread): Promise<void> {
    this.cache.set(t.id, t);
    await mkdir(THREADS_DIR, { recursive: true });
    const f = join(THREADS_DIR, t.id + ".json");
    const tmp = `${f}.tmp-${process.pid}-${this.seq++}`;
    await writeFile(tmp, JSON.stringify(t, null, 1));
    await rename(tmp, f);
  }
}
