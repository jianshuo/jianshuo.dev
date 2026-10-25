// src/codex-auth.ts — Codex 订阅链的 access token 读取与刷新。
//
// refresh token 是轮换式的：每刷一次旧的立即作废，一条链只能有一个写者（记忆
// codex-subscription-auth-chains）。router 是它名下每条链唯一的写者——monitor 刷新、
// runner 里的 codex CLI 使用，都是 engine-router 这一个系统用户，同一个文件。
// 写回格式与 codex CLI 自己一致（last_refresh 是 RFC3339 字符串；gpt-image-2-skill
// 写 epoch 数字，codex CLI 解析不了——这就是不能让那个 skill 碰这条链的原因）。
import { readFile, writeFile, rename, copyFile, readdir, unlink, open, stat } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_TOKEN_URL = process.env.CODEX_TOKEN_URL ?? "https://auth.openai.com/oauth/token";
// Codex CLI 的公开 client_id（VPS 上 codex 0.153.4 二进制里的字面量）；优先用 id_token 的 aud。
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export type CodexTokens = { id_token: string; access_token: string; refresh_token: string; account_id?: string };

export function jwtPayload(token: string): any {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** access token 的过期时刻（ms），解析不了返回 0（当作已过期）。 */
export function jwtExpMs(token: string): number {
  const exp = Number(jwtPayload(token)?.exp);
  return Number.isFinite(exp) ? exp * 1000 : 0;
}

/** 提前 5 分钟视为过期，免得探针刚发出去 token 就失效。 */
export function needsRefresh(tokens: CodexTokens, now = Date.now()): boolean {
  return jwtExpMs(tokens.access_token) - 5 * 60_000 <= now;
}

function clientIdOf(tokens: CodexTokens): string {
  const aud = jwtPayload(tokens.id_token)?.aud;
  const a = Array.isArray(aud) ? aud[0] : aud;
  return typeof a === "string" && a.startsWith("app_") ? a : CODEX_CLIENT_ID;
}

export async function readCodexAuth(codexHome: string): Promise<{ raw: any; tokens: CodexTokens }> {
  const raw = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"));
  const t = raw?.tokens;
  if (!t?.access_token || !t?.refresh_token) throw new Error("Not logged in: auth.json has no tokens");
  return { raw, tokens: t };
}

/** 原子写回：先备份当前文件（保留最近 3 份），再 tmp + rename。 */
async function writeAuthAtomic(codexHome: string, raw: any): Promise<void> {
  const file = join(codexHome, "auth.json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(file, join(codexHome, `auth.json.bak-${stamp}`)).catch(() => {});
  const baks = (await readdir(codexHome)).filter((f) => f.startsWith("auth.json.bak-")).sort();
  for (const old of baks.slice(0, Math.max(0, baks.length - 3))) await unlink(join(codexHome, old)).catch(() => {});
  const tmp = file + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * 拿一个可用的 access token：没过期直接用；过期了用 refresh token 换新并写回。
 * 刷新失败（revoked / invalidated）抛错，错误文案原样保留给判别器。
 */
export async function codexAccessToken(
  codexHome: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  opts: { noRefresh?: boolean } = {},
): Promise<CodexTokens> {
  const first = await readCodexAuth(codexHome);
  if (!needsRefresh(first.tokens, now)) return first.tokens;
  // 有 run 在用这条链时，monitor 不刷新（codex CLI 可能同时在刷，两边各刷一次 = 互踢）。
  if (opts.noRefresh) throw new Error("codex access token expired; refresh deferred while a run is using this chain");
  // server（monitor）和 runner 是两个进程，可能同时想刷新：文件锁串行化，
  // 拿到锁后重读一次——别人刚刷完就直接用，绝不拿旧 refresh token 再刷一次。
  const release = await lock(join(codexHome, "auth.json.lock"));
  try {
    const { raw, tokens } = await readCodexAuth(codexHome);
    if (!needsRefresh(tokens, now)) return tokens;
    return await refreshAndWrite(codexHome, raw, tokens, fetchImpl, now);
  } finally {
    await release();
  }
}

// 三个时长必须满足：持锁上限（刷新请求超时）< 过期判定 < 等锁上限。
//  - 持锁最久 ≈ REFRESH_TIMEOUT_MS：刷新请求有超时，持锁的进程不会无限期占着；
//  - 锁文件超过 LOCK_STALE_MS 才算死锁（远大于持锁上限，活着的持锁者不会被误清——误清就是
//    两个进程拿同一个 refresh token 各刷一次，整条链作废）；
//  - 等锁的人最多等 LOCK_WAIT_MS（大于过期判定）：持锁进程崩了，等待者自己就能清掉死锁接着刷。
export const REFRESH_TIMEOUT_MS = 20_000;
export const LOCK_STALE_MS = 60_000;
export const LOCK_WAIT_MS = 75_000;

export async function lock(path: string, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS): Promise<() => Promise<void>> {
  const t0 = Date.now();
  for (;;) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => unlink(path).catch(() => {});
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const st = await stat(path).catch(() => null);
      if (st && Date.now() - st.mtimeMs > staleMs) await unlink(path).catch(() => {});
      // 文案带 failed to authenticate：万一真等超时，换腿判据会换账号重跑，而不是整单失败
      if (Date.now() - t0 > waitMs) throw new Error("failed to authenticate: codex auth lock timeout");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function refreshAndWrite(
  codexHome: string,
  raw: any,
  tokens: CodexTokens,
  fetchImpl: typeof fetch,
  now: number,
): Promise<CodexTokens> {
  const r = await fetchImpl(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientIdOf(tokens),
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      scope: "openid profile email",
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`codex refresh ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  const next: CodexTokens = {
    ...tokens,
    id_token: j.id_token ?? tokens.id_token,
    access_token: j.access_token ?? tokens.access_token,
    refresh_token: j.refresh_token ?? tokens.refresh_token,
  };
  raw.tokens = next;
  raw.last_refresh = new Date(now).toISOString();
  await writeAuthAtomic(codexHome, raw);
  return next;
}
