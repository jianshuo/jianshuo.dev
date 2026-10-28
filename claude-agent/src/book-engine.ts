// src/book-engine.ts — 写书 / 修书引擎：整本书交给 engine-router（2026-10-25 起唯一路径）。
// 跑在 book-runner 进程里，与 web 进程无关。
//
// engine-router（同机服务，见 engine-router/README）统一管 Codex / Claude 订阅（两个账号）/ Kimi
// 的额度：挑余量最大、且没超周配速的账号，跑到一半撞墙自动换账号重跑（换账号判据就是原来本仓
// book-legs.ts 的那套，已搬进 router 连同全部单测）。原来这里的三腿降级链（kimi → codex → claude，
// 直接起 Claude SDK / codex exec）已于 2026-10-25 删除。
//
// 契约：返回 { ok, threadId, reply, error }，book-runner 的退款 / 告警 / 登记据此走。
// router 连不上 = 失败（照常退款 + 管理员告警）。
import { join } from "node:path";
import { HOME, WORKSPACE } from "./env.js";
import { followRun, submitRun } from "./router-client.js";

// 兜底防挂死，写整本书要给足（router 侧按这个给每次 attempt 计墙钟）。
export const BOOK_TIMEOUT_MS = Number(process.env.BOOK_TIMEOUT_MS ?? 3 * 60 * 60 * 1000);
// 绘本最吃轮数：每页要「写字→评审→出图→验图」，14 页光页面就 50+ 轮，再加骨架、
// refs、封面、逐页 asset 上传，80 轮不够——2026-08-31《同一个月亮》就死在这儿
// （turns=81 error_max_turns：图全画完了，卡在还没上传，线上只有字没有图）。
const BOOK_MAX_TURNS = Number(process.env.BOOK_MAX_TURNS ?? 160);

// 写书 skill 的位置。router 的引擎以 engine-router 用户运行，它的 ~/.claude/skills 是指向这里的软链。
const SKILLS_DIR = join(HOME, ".claude", "skills");

// 写书提示词前言（每单都带）。router 可能把书派给没有并行子代理 / Workflow 的引擎（codex），
// 所以 skill 里这些都在这里翻译成「自己读文件 + 自己分步扮演角色」，各家引擎同一份。
export const BOOK_PREAMBLE =
  `你是跑在服务器上的自动写书代理（可跑 bash、读写文件、联网）。\n` +
  `先完整阅读 ${SKILLS_DIR}/wjs-voicedrop-writing-book/SKILL.md 并严格照做；` +
  `按它第 0 步选定书的类型后，把对应写作 skill 的 SKILL.md（同在 ${SKILLS_DIR}/ 下）也完整读进来再动笔。\n` +
  `你没有并行子代理，也没有 Workflow——skill 里说 spawn 写手/评审 subagent 的地方，一律由你自己分步串行扮演：` +
  `写完一章，抛开写作时的思路，按该类型的评审维度独立重读打分并把意见落盘 reviews/NN.json；` +
  `不过就照 must_fix 重写（最多 3 轮），过审立刻 build.mjs done 发布，绝不攒到最后。\n` +
  `其余约定（工作目录、book.json、边写边发、断点续跑、封面用 /opt/claude-agent/bin/paint）一律照 skill 执行。\n` +
  `出图前先读 ${SKILLS_DIR}/paint/SKILL.md（出图说明书）；每张图都带 --group <书的slug>（同组的图服务端始终用同一个引擎，全书一个画风，别自己 --engine 换引擎）。\n` +
  `一次要画多张图（绘本页图等）把它们全部写进一份清单，用 /opt/claude-agent/bin/paint 清单.json --group <slug> 一次交（不拆批、没有张数上限），` +
  `别一张一张串行地等；命令前台最多等约 9 分钟，退出码 3 = 还没画完，原样重跑同一条命令接着等同一批（不会重复画）。\n` +
  `paint 和 build.mjs 一律在前台同步跑到出结果，绝不用 run_in_background / nohup / Monitor 丢到后台再写总结——` +
  `你的回合一结束进程就退出，后台任务会被一起杀掉，书就停在半路（2026-09-23《一封一封的写》14 页只发了 1 页）。` +
  `全部章节 build.mjs done、封面上传、目录刷新之后才能结束回合；服务器会对账 book.json，没齐会把你叫回来续写。`;

export type BookOutcome = { ok: boolean; threadId: string; reply: string; error: string };

// router 换账号整单重跑时追加的提示（router 的 resume_hint）：各账号会话不互通，
// 工作目录里的半成品还在，免得同一单写出两本书。
const RESUME_HINT =
  `\n\n补充（本单已换过引擎）：上一次尝试因引擎配额中断，可能已经写了一部分——` +
  `动笔前先列一下 ${WORKSPACE}/ 下本单的工作目录，如果已有 book.json / 章节 / reviews，` +
  `就接着把它写完并发布，**不要另起一本新书、不要换 slug**。`;

// 续跑的补充提示（runner 进程被杀后重拉：VPS 整机重启、runner 自身崩溃）。与换账号的
// RESUME_HINT 同理但原因不同、要求更具体：半成品可能已经很完整——9/8《嘟嘟和山上的
// 灯塔》被 restart 杀掉时 14 页 14 图全在，只差发布；这时最怕引擎「重新来过」把图
// 重画一遍、把章节重写一遍。
export function resumeAfterRestartHint(jobId?: string): string {
  return (
    `\n\n补充（本单是服务器重启后的续跑）：上一次尝试被服务重启打断，很可能已经写了一部分甚至接近完成——` +
    `动笔前先列一下 ${WORKSPACE}/ 下本单的工作目录` + (jobId ? `（book.json 里 jobId=「${jobId}」的那个）` : "") +
    `，用 build.mjs status 看每章是 done / 待发(有稿) / 待写：有稿的直接发布，缺的补写，缺封面就补封面。` +
    `**不要另起一本新书、不要换 slug、不要重画已有的插图、不要重写已过审的章节。**`
  );
}

export type BookEngineOpts = {
  key?: string; // 幂等键：book-runner 重启后重提交会接回同一个 router 任务，不会两个引擎写同一本书
  taskClass?: "book" | "revise";
  label?: string; // router 状态页上显示的一句（书还没有 book.json 时靠它认）
};

export async function runBookEngine(prompt: string, onThread?: (id: string) => void, opts: BookEngineOpts = {}): Promise<BookOutcome> {
  let run: any;
  try {
    run = await submitRun({
      prompt:
        prompt +
        `\n\n补充：skill 里说的「工作目录 book-<slug>」一律用绝对路径 ${WORKSPACE}/book-<slug>。`,
      task_class: opts.taskClass ?? "book",
      workdir: WORKSPACE,
      context_dirs: [SKILLS_DIR],
      env: process.env.PAINT_API_TOKEN ? { PAINT_API_TOKEN: process.env.PAINT_API_TOKEN } : {},
      budget: { max_turns: BOOK_MAX_TURNS, timeout_ms: BOOK_TIMEOUT_MS, size: "large" },
      priority: "user",
      continuity: "none", // 每轮都是新会话，文件是真源
      resume_hint: RESUME_HINT.trim(),
      idempotency_key: opts.key,
      label: opts.label,
    });
  } catch (e: any) {
    // router 连不上（服务没起 / token 错）：这一单失败，book-runner 照常退款 + 告警
    const error = `engine-router 提交失败：${e?.message ?? e}`;
    console.error(`[book] ${error}`);
    return { ok: false, threadId: "", reply: "", error };
  }
  const threadId = `router:${run.run_id}`;
  onThread?.(threadId);
  console.log(`[book] router run=${run.run_id} key=${opts.key ?? "-"}`);
  try {
    const out = await followRun(run.run_id, (ev) => {
      if (ev.type === "started") console.log(`[book] router attempt ${ev.attempt} → ${ev.account}`);
      if (ev.type === "switched") console.log(`[book] router 换账号：${ev.from} 用不了 → ${String(ev.reason ?? "").slice(0, 120)}`);
      if (ev.type === "queued" && ev.reason) console.log(`[book] router 排队：${String(ev.reason).slice(0, 160)}`);
    });
    return { ok: out.ok, threadId, reply: out.reply ?? "", error: out.ok ? "" : out.error || `router run ${out.status}` };
  } catch (e: any) {
    return { ok: false, threadId, reply: "", error: `router: ${e?.message ?? e}` };
  }
}
