// src/book-engine.ts — 写书引擎：三条腿（kimi / codex / claude）与降级链（2026-09-11 从
// server.ts 搬出）。跑在 book-runner 进程里，与 web 进程无关。
//
// 引擎（2026-08-20 起）：写书/修书跑 OpenAI Codex CLI（`codex exec --json`，与
// codex.jianshuo.dev 同款，走 ChatGPT 订阅）——lab 网页聊天仍是 Claude，只有书换引擎。
// 凭据是 claude-agent 自己的独立登录链 CODEX_HOME=$HOME/.codex（沙箱可写区内；
// 绝不与 /opt/codex-agent 或 paint 共链——refresh token 轮换互踢，见记忆
// codex-subscription-auth-chains）。重登：
//   ssh root@VPS 'sudo -u claude-agent HOME=/opt/claude-agent codex login --device-auth'
import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseLegs, availableLegs, shouldTryNextLeg, type BookLeg } from "./book-legs.js";
import { APP_ROOT, CODEX_BIN, CODEX_HOME, HOME, MODEL, WORKSPACE } from "./env.js";

const BOOK_CODEX_MODEL = process.env.BOOK_CODEX_MODEL ?? ""; // 空 = 用该链 config.toml 的默认模型
// 兜底防挂死，写整本书要给足。三条腿同用：codex 腿 SIGKILL 子进程，claude/kimi 腿
// abort 掉 SDK 会话（2026-09-11 前只有 codex 腿有超时——一条挂死的 kimi 腿会把整单
// 永久卡住：登记永远 running、不退款、不告警）。
export const BOOK_TIMEOUT_MS = Number(process.env.BOOK_TIMEOUT_MS ?? 3 * 60 * 60 * 1000);

// --- 写书引擎的凭据（三条腿共用这几个常量）---
// claude 腿不配 BOOK_ANTHROPIC_* 时吃 lab 自己的 Claude 订阅 OAuth；配了则按次
// 注入 ANTHROPIC_BASE_URL/API_KEY——Kimi 等 Anthropic 兼容端点（订阅/按量都行），
// 只作用于写书子进程，聊天路径的凭据与模型完全不受影响。
// 2026-09-02 起 BOOK_ENGINE 开关废除：改由 BOOK_LEGS 的降级链决定跑哪条腿。
const BOOK_CLAUDE_MODEL = process.env.BOOK_CLAUDE_MODEL || MODEL;
const BOOK_ANTHROPIC_BASE_URL = process.env.BOOK_ANTHROPIC_BASE_URL ?? "";
const BOOK_ANTHROPIC_API_KEY = process.env.BOOK_ANTHROPIC_API_KEY ?? "";
// 绘本最吃轮数：每页要「写字→评审→出图→验图」，14 页光页面就 50+ 轮，再加骨架、
// refs、封面、逐页 asset 上传，80 轮不够——2026-08-31《同一个月亮》就死在这儿
// （turns=81 error_max_turns：图全画完了，卡在还没上传，线上只有字没有图）。
const BOOK_MAX_TURNS = Number(process.env.BOOK_MAX_TURNS ?? 160); // 仅 claude 腿（codex 腿无轮数概念）
// claude 腿的 cwd：独立目录=独立 Claude Code 项目=零 auto-memory。不能用 WORKSPACE
// 当 cwd——那个项目积累的记忆笔记（含《江泽民传》等书的内容）会自动注入请求，
// Kimi 风控直接 400 high risk（2026-08-24 二分定位实锤）。书文件仍落 WORKSPACE
// （提示词里给绝对路径），本目录只是进程落脚点。
export const BOOK_RUN_DIR = process.env.BOOK_RUN_DIR ?? join(APP_ROOT, "bookrun");

const SKILLS_DIR = join(HOME, ".claude", "skills");

// codex 是单代理循环，没有 Claude 的 skill 装载/并行 subagent/Workflow——skill 里
// 这三样都要在 prompt 里翻译成「自己读文件 + 自己分步扮演角色」。
export const CODEX_BOOK_PREAMBLE =
  `你是跑在服务器上的自动写书代理（可跑 bash、读写文件、联网）。\n` +
  `先完整阅读 ${SKILLS_DIR}/wjs-voicedrop-writing-book/SKILL.md 并严格照做；` +
  `按它第 0 步选定书的类型后，把对应写作 skill 的 SKILL.md（同在 ${SKILLS_DIR}/ 下）也完整读进来再动笔。\n` +
  `你没有并行子代理，也没有 Workflow——skill 里说 spawn 写手/评审 subagent 的地方，一律由你自己分步串行扮演：` +
  `写完一章，抛开写作时的思路，按该类型的评审维度独立重读打分并把意见落盘 reviews/NN.json；` +
  `不过就照 must_fix 重写（最多 3 轮），过审立刻 build.mjs done 发布，绝不攒到最后。\n` +
  `其余约定（工作目录、book.json、边写边发、断点续跑、封面用 /opt/claude-agent/bin/paint）一律照 skill 执行。`;

export type CodexOutcome = { ok: boolean; threadId: string; reply: string; error: string };

// claude 腿：与 runCodexExec 同一契约。复用同一份写书 preamble（读 skill 文件、
// 串行扮演写手/评审，引擎无关），会话落 ~/.claude/projects（lab 侧栏可回看）。
// 2026-08-20 前的老实现的复活版 + 按次 env 注入（Kimi 兼容端点）。
async function runClaudeExec(
  prompt: string,
  onThread?: (id: string) => void,
  injectCompat = true, // false = 忽略 BOOK_ANTHROPIC_*，走 lab 自己的 Claude 订阅
): Promise<CodexOutcome> {
  await mkdir(BOOK_RUN_DIR, { recursive: true });
  // 每单清空本项目的 auto-memory：书的真源在 skill 与 _src，不需要跨单记忆；
  // 让它积累书内容迟早再次触发 Kimi 风控（workspace 项目就是前车之鉴）。
  const memDir = join(HOME, ".claude", "projects", BOOK_RUN_DIR.replace(/\//g, "-"), "memory");
  await rm(memDir, { recursive: true, force: true }).catch(() => {});
  // skill 里说的「工作目录 book-<slug>」按绝对路径落 WORKSPACE——cwd 只是落脚点。
  prompt = `${prompt}\n\n补充：你的当前目录不是书库根目录；skill 里说的「工作目录 book-<slug>」一律用绝对路径 ${WORKSPACE}/book-<slug>。`;
  const env: Record<string, string | undefined> = { ...process.env };
  // 兼容端点在配且本单被指派 → 注入；否则模型退回 lab 默认（订阅端点不认 k3 这类第三方名）。
  const useCompat = Boolean(BOOK_ANTHROPIC_BASE_URL) && injectCompat;
  const model = useCompat ? BOOK_CLAUDE_MODEL : MODEL;
  if (useCompat) {
    env.ANTHROPIC_BASE_URL = BOOK_ANTHROPIC_BASE_URL;
    env.ANTHROPIC_API_KEY = BOOK_ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN; // 订阅 token 在场会抢道，明确让位给兼容端点
    // 第三方端点只认自家模型名：把 Claude Code 内部各档位（含子任务的 haiku 档）
    // 全部映射到同一个模型，否则内部小任务会拿 claude-* 模型名打 Kimi 端点报错。
    env.ANTHROPIC_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = BOOK_CLAUDE_MODEL;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = BOOK_CLAUDE_MODEL;
    env.CLAUDE_CODE_SUBAGENT_MODEL = BOOK_CLAUDE_MODEL;
    env.CLAUDE_CODE_EFFORT_LEVEL = process.env.BOOK_CLAUDE_EFFORT ?? "high";
    if (process.env.BOOK_CLAUDE_CONTEXT) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.BOOK_CLAUDE_CONTEXT;
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = process.env.BOOK_CLAUDE_CONTEXT;
    }
  }
  // 墙钟兜底：maxTurns 只限轮数不限时间，一个挂死的工具调用能把整单卡到天荒地老。
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, BOOK_TIMEOUT_MS);
  timer.unref?.();
  const q = query({
    prompt,
    options: {
      cwd: BOOK_RUN_DIR,
      model,
      maxTurns: BOOK_MAX_TURNS,
      permissionMode: "bypassPermissions",
      systemPrompt: { type: "preset", preset: "claude_code" },
      env,
      abortController: ac,
    },
  });
  let threadId = "";
  let ok = false;
  let reply = "";
  let error = "";
  try {
    for await (const msg of q as AsyncIterable<any>) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        threadId = msg.session_id;
        onThread?.(threadId);
      }
      if (msg.type === "result") {
        ok = msg.subtype === "success" && !msg.is_error;
        reply = typeof msg.result === "string" ? msg.result : "";
        // CLI 正常退出但第一轮就是 API 错误（401/无效 key 等）时 subtype 仍是
        // success——按文本识别，别把认证失败当成书写完了（2026-08-24 自检踩到）。
        if (ok && /Failed to authenticate|API Error: \d{3}/i.test(reply.slice(0, 300))) {
          ok = false;
          error = reply.slice(0, 200);
        }
        // 真正的报错文案在 result.errors[]（配额/认证/状态码都在这里），subtype 只是
        // 分类名——只记 subtype 的话换腿判别看不到「403 usage limit」这些字样。
        if (!ok && !error) {
          const errs = Array.isArray(msg.errors) ? msg.errors.map(String).filter(Boolean) : [];
          error = errs.length ? `${msg.subtype ?? "error"}: ${errs.join("; ").slice(0, 400)}` : String(msg.subtype ?? "error");
        }
        console.log(
          `[book] claude-engine done model=${model} compat=${useCompat} turns=${msg.num_turns} cost=${msg.total_cost_usd ?? "-"}` +
            (ok ? "" : ` ERROR=${error}`),
        );
      }
    }
  } catch (e: any) {
    // 别覆盖已经识别出的具体错误。SDK 常在 result 之后再抛一个笼统的
    // 「process exited with code 1」——2026-09-02 的日志里配额 403 就是这样被
    // 盖成通用消息的，换腿判别会因此瞎掉（shouldTryNextLeg 认不出没有配额字样的串）。
    if (!error) error = String(e?.message ?? e);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    ok = false;
    error = `书没写完就超时了（${Math.round(BOOK_TIMEOUT_MS / 60000)} 分钟兜底）`;
  }
  return { ok, threadId, reply, error: ok ? "" : error || "no result" };
}

// --- 引擎分发：三条腿的降级链（2026-09-02）---------------------------------
//
// 顺序 kimi → codex → claude（BOOK_LEGS 可改）。跑倒一条腿就问一句「是配额满了
// 还是书写坏了」：配额满 → 换下一条腿重跑；书写坏了（撞轮数、崩溃、超时、风控）
// → 直接认输，换腿只会再烧一份别人的额度。三条腿全满才算失败，走原来的
// 退款 + 管理员告警。
//
// 起因是 9/2 上午：单腿吃 Kimi，7 单 11 分钟内涌进来把 5 小时配额打穿，9 本
// 书全灭、每本跑几十轮才倒下，而同机的 Codex 和 Claude 订阅整段时间闲着。
//
// 换腿是**整本重跑**（各腿的会话不互通）。skill 本身有断点续跑约定，工作目录
// WORKSPACE/book-<slug> 还在，所以下面给续跑腿追一句提示，让它先查有没有半成品，
// 免得同一单写出两本书。前一腿烧掉的轮数收不回来，这是换腿的固有代价。
export const BOOK_LEGS = parseLegs(process.env.BOOK_LEGS);

function legLabel(leg: BookLeg): string {
  return leg === "kimi" ? `kimi-compat(${BOOK_CLAUDE_MODEL})` : leg === "claude" ? "claude-sub" : "codex";
}

function runLeg(leg: BookLeg, prompt: string, onThread?: (id: string) => void): Promise<CodexOutcome> {
  if (leg === "codex") return runCodexExec(prompt, onThread);
  return runClaudeExec(prompt, onThread, leg === "kimi"); // kimi=注入兼容端点，claude=吃 lab 订阅
}

const RESUME_HINT =
  `\n\n补充（本单已换过引擎）：上一次尝试因引擎配额中断，可能已经写了一部分——` +
  `动笔前先列一下 ${WORKSPACE}/ 下本单的工作目录，如果已有 book.json / 章节 / reviews，` +
  `就接着把它写完并发布，**不要另起一本新书、不要换 slug**。`;

// 续跑的补充提示（runner 进程被杀后重拉：VPS 整机重启、runner 自身崩溃）。与换腿的
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

export async function runBookEngine(prompt: string, onThread?: (id: string) => void): Promise<CodexOutcome> {
  // 凭据缺失的腿直接跳过，别浪费一次必败的重跑。
  const legs = availableLegs(BOOK_LEGS, {
    kimi: Boolean(BOOK_ANTHROPIC_BASE_URL),
    claude: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  });
  if (!legs.length) return runCodexExec(prompt, onThread); // 全没配：保底还是老路
  let last: CodexOutcome = { ok: false, threadId: "", reply: "", error: "no leg ran" };
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    console.log(`[book] leg ${i + 1}/${legs.length} = ${legLabel(leg)}`);
    last = await runLeg(leg, i === 0 ? prompt : prompt + RESUME_HINT, onThread);
    if (last.ok) {
      if (i > 0) console.log(`[book] leg ${legLabel(leg)} 写成（前 ${i} 条腿用不了）`);
      return last;
    }
    if (!shouldTryNextLeg(last.error)) {
      console.log(`[book] leg ${legLabel(leg)} 失败，但不是配额/凭据问题，不换腿 → ${last.error.slice(0, 120)}`);
      return last;
    }
    console.log(
      `[book] leg ${legLabel(leg)} 用不了（配额满或凭据失效）` +
        (i + 1 < legs.length ? ` → 换 ${legLabel(legs[i + 1])}` : "（已是最后一条腿）"),
    );
  }
  return last;
}

// 跑一次 codex exec 到结束。事件解析与 codex-agent 的 translate() 同源（实机 fixture
// 校准过）：thread.started 拿线程号，item.completed/agent_message 的最后一条是给
// 主人看的答复，turn.failed/error 记错误。三坑防线：flags 在子命令后紧跟（无 resume）、
// --skip-git-repo-check（workspace 不是 git repo）、stdin 必须 ignore（否则等 EOF 挂住）。
function runCodexExec(prompt: string, onThread?: (id: string) => void): Promise<CodexOutcome> {
  return new Promise((resolve) => {
    const args = ["exec", "--json", "-s", "danger-full-access", "-C", WORKSPACE, "--skip-git-repo-check"];
    if (BOOK_CODEX_MODEL) args.push("-m", BOOK_CODEX_MODEL);
    args.push(prompt);
    const child = spawn(CODEX_BIN, args, {
      cwd: WORKSPACE,
      env: { ...process.env, CODEX_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let threadId = "";
    let reply = "";
    let error = "";
    let stderrTail = "";
    let buf = "";
    const timer = setTimeout(() => {
      error = error || `书没写完就超时了（${Math.round(BOOK_TIMEOUT_MS / 60000)} 分钟兜底）`;
      child.kill("SIGKILL");
    }, BOOK_TIMEOUT_MS);
    timer.unref?.();
    // 按 utf8 解码再拼接：裸 Buffer 拼字符串会把落在分块边界上的汉字切成 U+FFFD，
    // 修书说明里就会冒乱码，stderr 里的换腿判据文案也可能因此错过。
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const type = String(ev?.type ?? "");
        const tid = ev?.thread_id ?? ev?.session_id;
        if (!threadId && tid && (type === "thread.started" || type === "session.created")) {
          threadId = String(tid);
          onThread?.(threadId);
        }
        if (type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text)
          reply = String(ev.item.text);
        if (type === "turn.failed" || type === "error")
          error = String(ev?.error?.message ?? ev?.message ?? "turn failed");
      }
    });
    child.stderr.on("data", (c: string) => {
      stderrTail = (stderrTail + c).slice(-2000);
    });
    child.on("error", (e: any) => {
      clearTimeout(timer);
      resolve({ ok: false, threadId, reply, error: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && !!reply;
      resolve({ ok, threadId, reply, error: ok ? "" : error || stderrTail.trim() || `codex exit ${code}` });
    });
  });
}
