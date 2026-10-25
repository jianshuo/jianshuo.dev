// src/video-book.ts — 视频书（书架「动画版」，2026-10-25）。
//
// 像听书一样：任何人第一次打开 voicedrop.cn/books/<slug>/video/，书架那边就来这里下单；
// 做完的成品永久放在 R2 books/<slug>/video/，之后直接回源，不再做第二次。不登录、不扣费。
//
// 做法：每单交给 claude-agent 用户管理器的瞬态单元 video-<slug> 跑 wjs-voicedrop-creating-motion-book 的
// cloud/run_book.sh——开一台一次性 Vultr 机器、无人值守 Claude Code 做完 HTML、发布到书架、销毁机器。
// 单元和 web 进程不同 cgroup，发版重启不影响正在做的书。进度在 $MB_ROOT/books/<slug>/state.json（run_book.sh 写）。
//
// 任何人都能触发，所以有三道闸（环境变量可调）：
//   · 只做写完的书，一本只做一次（已发布直接答 done；在做/排队不重复下单；失败 6 小时内不重试）
//   · 全局同时只做 VIDEO_MAX_CONCURRENT 本（缺省 1）——Claude 额度和写书引擎共用
//   · 每 24 小时最多开工 VIDEO_MAX_PER_DAY 本（缺省 2），排队上限 VIDEO_MAX_QUEUE（缺省 20）
// 兜底：每 10 分钟跑一次 cloud/reaper.sh，删掉开了太久的 motion-book 机器（run_book.sh 被杀时的保险）。
//
// 纯函数 decideVideo 不碰网络和进程，可单测（test/video-book.test.mjs）。
import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { busEnv } from "./book-launch.js";

export const MB_ROOT = process.env.MB_ROOT ?? "/opt/claude-agent/motion-book";
const QUEUE_DIR = join(MB_ROOT, "queue");
const BOOKS_DIR = join(MB_ROOT, "books");
const LAUNCH_LOG = join(MB_ROOT, "launches.log");
const SKILL_CLOUD = join(MB_ROOT, "claude-skills/wjs-voicedrop-creating-motion-book/cloud");
const MAX_CONCURRENT = Number(process.env.VIDEO_MAX_CONCURRENT ?? 1);
const MAX_PER_DAY = Number(process.env.VIDEO_MAX_PER_DAY ?? 2);
const MAX_QUEUE = Number(process.env.VIDEO_MAX_QUEUE ?? 20);
const FAIL_COOLDOWN_MS = 6 * 3600 * 1000;
const SHELF = "https://jianshuo.dev/voicedrop/books";
const PUBLIC = "https://voicedrop.cn/books";
const SYSTEMD_RUN = process.env.SYSTEMD_RUN_BIN ?? "systemd-run";
const SYSTEMCTL = process.env.SYSTEMCTL_BIN ?? "systemctl";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export type VideoState = { state: string; step?: string; startedAt?: number; updatedAt?: number; url?: string; error?: string; only?: string };
export type VideoFacts = {
  published: boolean; running: boolean; queued: number | null;   // queued = 排第几（1 起），null = 不在队里
  state: VideoState | null; trigger: boolean; now: number;
};
export type VideoDecision =
  | { kind: "answer"; status: number; body: Record<string, unknown> }
  | { kind: "enqueue" };

export const videoUrl = (slug: string) => `${PUBLIC}/${slug}/video/`;
export const videoUnit = (slug: string) => `video-${slug}`;

/** 只看事实做决定：已发布 → done；在做 → 进度；排队 → 第几位；失败冷却中 → failed；不触发 → none；否则入队。 */
export function decideVideo(slug: string, f: VideoFacts): VideoDecision {
  if (f.published) return { kind: "answer", status: 200, body: { state: "done", url: videoUrl(slug) } };
  if (f.running) return { kind: "answer", status: 202, body: { state: f.state?.state && f.state.state !== "failed" && f.state.state !== "done" ? f.state.state : "booting",
    step: f.state?.step ?? "开机中", startedAt: f.state?.startedAt, updatedAt: f.state?.updatedAt } };
  if (f.queued !== null) return { kind: "answer", status: 202, body: { state: "queued", position: f.queued } };
  const failedRecently = f.state?.state === "failed" && f.now - (f.state.updatedAt ?? 0) < FAIL_COOLDOWN_MS;
  if (failedRecently) return { kind: "answer", status: 200, body: { state: "failed", step: f.state!.step, error: f.state!.error,
    retryAfter: (f.state!.updatedAt ?? 0) + FAIL_COOLDOWN_MS } };
  if (!f.trigger) return { kind: "answer", status: 200, body: { state: "none" } };
  return { kind: "enqueue" };
}

// ── 事实收集 ─────────────────────────────────────────────────────────────
async function published(slug: string): Promise<boolean> {
  try { return (await fetch(`${SHELF}/${slug}/video/index.html`, { method: "HEAD", signal: AbortSignal.timeout(15000) })).ok; } catch { return false; }
}
/** 书写完了吗（全部章 done）。写完才值得开机。 */
async function bookReady(slug: string): Promise<{ ok: boolean; title?: string; why?: string }> {
  try {
    const r = await fetch(`${SHELF}/${slug}/_src/book.json?_=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, why: "书架上没有这本书" };
    const b = await r.json(), ch = Array.isArray(b?.chapters) ? b.chapters : [];
    if (!ch.length) return { ok: false, why: "这本书还没有章节" };
    const left = ch.filter((c: any) => c?.status !== "done").length;
    return left ? { ok: false, why: `还有 ${left} 章没写完` } : { ok: true, title: String(b.title ?? slug) };
  } catch (e: any) { return { ok: false, why: `读书架失败：${e?.message ?? e}` }; }
}
/** 对外日志（run_book.sh 写的 events.json）：只给时间＋一句步骤；再过滤一道路径/IP，防哪天脚本漏写进去。
 *  路径至少两段才删（「13/13 章」这种分数不动），段里可以有中文。 */
export function publicEvents(raw: unknown): { t: number; text: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-300).filter((e: any) => e && typeof e.text === "string" && Number.isFinite(e.t))
    .map((e: any) => ({ t: Number(e.t), text: e.text.replace(/(?:~|\.{0,2})?(?:\/[^\s/，。：；、（）《》"'“”]+){2,}\/?/g, "").replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 200) }))
    .filter((e) => e.text);
}
async function readEvents(slug: string) {
  try { return publicEvents(JSON.parse(await readFile(join(BOOKS_DIR, slug, "events.json"), "utf8"))); } catch { return []; }
}
async function readState(slug: string): Promise<VideoState | null> {
  try { return JSON.parse(await readFile(join(BOOKS_DIR, slug, "state.json"), "utf8")); } catch { return null; }
}
async function queueList(): Promise<{ slug: string; requestedAt: number }[]> {
  let names: string[] = [];
  try { names = (await readdir(QUEUE_DIR)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const recs = await Promise.all(names.map(async (n) => { try { return JSON.parse(await readFile(join(QUEUE_DIR, n), "utf8")); } catch { return null; } }));
  return recs.filter((r) => r && SLUG_RE.test(r.slug)).sort((a, b) => a.requestedAt - b.requestedAt);
}
function activeVideoUnits(): Promise<Set<string>> {
  return new Promise((resolve) => {
    const child = spawn(SYSTEMCTL, ["--user", "list-units", "--plain", "--no-legend", "video-*"], { env: { ...process.env, ...busEnv() }, stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (c: string) => (out += c));
    child.on("error", () => resolve(new Set()));
    child.on("close", () => {
      const set = new Set<string>();
      for (const ln of out.split("\n")) { const [name, , active] = ln.trim().split(/\s+/); if (name?.endsWith(".service") && active === "active") set.add(name.slice(0, -8)); }
      resolve(set);
    });
  });
}
async function launchesSince(ts: number): Promise<number> {
  try { return (await readFile(LAUNCH_LOG, "utf8")).split("\n").filter((l) => Number(l.split(" ")[0]) >= ts).length; } catch { return 0; }
}

// ── 起单（泵）：一次只有一个泵在跑，免得两次请求各数一遍空位一起超额 ───────────────────
let pumpChain: Promise<unknown> = Promise.resolve();
export function pumpVideo(): Promise<string[]> {
  const p = pumpChain.then(async () => {
    const launched: string[] = [];
    const queue = await queueList();
    if (!queue.length) return launched;
    const active = await activeVideoUnits();
    let room = MAX_CONCURRENT - active.size;
    let budget = MAX_PER_DAY - (await launchesSince(Date.now() - 24 * 3600 * 1000));
    for (const q of queue) {
      if (room <= 0) break;
      if (budget <= 0) { console.log(`[video] 24 小时内已开工 ${MAX_PER_DAY} 本，排队 ${queue.length} 本等明天`); break; }
      if (active.has(videoUnit(q.slug))) { await rm(join(QUEUE_DIR, `${q.slug}.json`), { force: true }); continue; }
      const r = await launchVideoUnit(q.slug);
      if (r.ok) {
        await rm(join(QUEUE_DIR, `${q.slug}.json`), { force: true });
        await appendFile(LAUNCH_LOG, `${Date.now()} ${q.slug}\n`);
        console.log(`[video] 开工 ${q.slug}（${videoUnit(q.slug)}）`);
        launched.push(q.slug); room--; budget--;
      } else console.error(`[video] 起单失败 ${q.slug}：${r.error}`);   // 留在队里，下一轮再试
    }
    return launched;
  });
  pumpChain = p.catch((e) => console.error("[video] pump failed", e));
  return p as Promise<string[]>;
}
function launchVideoUnit(slug: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(SYSTEMD_RUN, ["--user", `--unit=${videoUnit(slug)}`, "--collect", "--quiet", `--description=voicedrop 视频书 ${slug}`,
      `--property=WorkingDirectory=${MB_ROOT}`, "--property=TimeoutStopSec=60", `--setenv=MB_ROOT=${MB_ROOT}`, `--setenv=HOME=${process.env.HOME ?? "/opt/claude-agent"}`,
      "/bin/bash", join(SKILL_CLOUD, "run_book.sh"), slug], { env: { ...process.env, ...busEnv() }, stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (c: string) => (err = (err + c).slice(-800)));
    child.on("error", (e: any) => resolve({ ok: false, error: `systemd-run: ${e?.message ?? e}` }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true, error: "" } : { ok: false, error: `exit ${code}: ${err.trim()}` }));
  });
}
function reap() {
  const child = spawn("/bin/bash", [join(SKILL_CLOUD, "reaper.sh")], { env: { ...process.env, MB_ROOT }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; for (const s of [child.stdout, child.stderr]) { s.setEncoding("utf8"); s.on("data", (c: string) => (out += c)); }
  child.on("close", () => { if (out.trim()) appendFile(join(MB_ROOT, "reaper.log"), out).catch(() => {}); });
  child.on("error", () => {});
}

// ── HTTP：GET|POST /api/video-book?slug=…（触发）  GET /api/video-book/status?slug=…（只查） ──
export async function handleVideoBook(req: IncomingMessage, res: ServerResponse, slug: string, trigger: boolean) {
  const send = (status: number, body: Record<string, unknown>) =>
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }).end(JSON.stringify({ slug, ...body }));
  if (!SLUG_RE.test(slug)) return send(400, { error: "bad slug" });
  const [pub, active, queue, state] = await Promise.all([published(slug), activeVideoUnits(), queueList(), readState(slug)]);
  const pos = queue.findIndex((q) => q.slug === slug);
  const d = decideVideo(slug, { published: pub, running: active.has(videoUnit(slug)), queued: pos >= 0 ? pos + 1 : null, state, trigger, now: Date.now() });
  if (d.kind === "answer") {
    // 在做、失败的单带上制作日志（等待页「查看制作日志」展开看）；已完成/没开始的不带
    if (!["done", "none"].includes(String(d.body.state))) d.body.events = await readEvents(slug);
    return send(d.status, d.body);
  }
  if (queue.length >= MAX_QUEUE) return send(429, { state: "busy", error: `排队已满（${MAX_QUEUE} 本），晚点再来` });
  const ready = await bookReady(slug);
  if (!ready.ok) return send(409, { state: "not_ready", error: ready.why });
  await mkdir(QUEUE_DIR, { recursive: true });
  await writeFile(join(QUEUE_DIR, `${slug}.json`), JSON.stringify({ slug, title: ready.title, requestedAt: Date.now() }));
  console.log(`[video] 收单 ${slug}《${ready.title}》`);
  const launched = await pumpVideo();
  if (launched.includes(slug)) return send(202, { state: "booting", step: "开机中", startedAt: Date.now() });
  const q2 = await queueList();
  return send(202, { state: "queued", position: q2.findIndex((q) => q.slug === slug) + 1 });
}

/** 服务起来后调用：每分钟泵一次（单元跑完腾出空位、过了 24 小时额度恢复，排队的才起得来），每 10 分钟兜底清理一次。 */
export function startVideoBook() {
  mkdir(QUEUE_DIR, { recursive: true }).catch(() => {});
  setInterval(() => pumpVideo().catch(() => {}), 60000).unref?.();
  setInterval(reap, 10 * 60000).unref?.();
  setTimeout(reap, 20000).unref?.();
}
