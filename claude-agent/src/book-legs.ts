// 写书引擎的三条腿与「满了就换下一条」的判别（2026-09-02）。
//
// 背景：8/30 起写书单腿吃 Kimi 订阅，9/2 上午 7 单在 11 分钟内涌进来
// （两个用户各一次点三本），把 Kimi 的 5 小时滚动配额打穿——08:24–09:37
// 之间 9 本书全灭，每本都跑了几十轮才倒在 403 上，用户白等一场，而同机
// 的 Codex 与 Claude 订阅整段时间闲着。
//
// 三条腿的顺序由用户定：kimi → codex → claude。判别与顺序都抽在这里，
// 是为了能脱开 server.ts（import 即起服务）单测。
export type BookLeg = "kimi" | "codex" | "claude";

export const DEFAULT_LEGS: BookLeg[] = ["kimi", "codex", "claude"];

/** 解析 BOOK_LEGS="kimi,codex,claude"。非法名/重复项丢弃；解析不出东西就用默认。 */
export function parseLegs(spec: string | undefined): BookLeg[] {
  const out: BookLeg[] = [];
  for (const raw of String(spec ?? "").split(",")) {
    const s = raw.trim().toLowerCase();
    if ((s === "kimi" || s === "codex" || s === "claude") && !out.includes(s)) out.push(s);
  }
  return out.length ? out : DEFAULT_LEGS;
}

// 「这条腿用不了」的判别 —— 换腿的唯一理由。分两类：
//   ① 配额满（本意）
//   ② 凭据失效（没登录/key 过期）——腿一样是废的，一样该换。漏了这类的话，
//      codex 订阅哪天掉登录，链就会在第二条腿上直接认输，用户照样白等。
//   ③ 模型被账号拒（模型不存在/不给这个账号用）——同理，腿是废的，该换。
// 不命中 = 书本身写坏了（轮数耗尽、崩溃、超时、内容风控），换腿只会再烧一份
// 别人的配额重蹈覆辙，直接认输。
//
// 宁可宽松：漏判=退回「一条腿倒下全线瘫痪」的老样子，误判=多花一条腿重跑一次。
// 前者伤用户，后者只费自己的额度。
const QUOTA_PATTERNS: RegExp[] = [
  /usage limit/i,                       // Kimi「You've reached your 5-hour usage limit」/ Claude 订阅同款
  /quota/i,                             // …reset when the current 5-hour window ends / insufficient_quota
  /rate[ _-]?limit/i,                   // 通用限流
  /too many requests/i,                 // 429 的文字版
  /\b429\b/,                            // 裸状态码
  /api error: 403/i,                    // Kimi 兼容端点把配额耗尽报成 403
  /overloaded/i,                        // Anthropic overloaded_error：换腿比死等强
  /upgrade your plan/i,                 // 三家配额文案共有的尾巴
  /purchase extra usage/i,
  // ② 凭据失效：腿一样是废的，换下一条
  /not logged in/i,                     // codex「Not logged in」
  /unauthorized/i,
  /\b401\b/,
  /invalid.{0,12}api[ _-]?key/i,
  /authentication[ _-]?error/i,
  /credit balance is too low/i,         // 按量付费账户欠费
  /failed to authenticate/i,            // 裸的认证失败（未必带状态码）
  // 令牌被吊销/作废——2026-09-02 傍晚《易经在说什么》栽在这里：codex 腿报
  // 「Your access token could not be refreshed because your refresh token was revoked」，
  // 上面那批词一个都不匹配，于是被当成「不是凭据问题」，第三条腿没试就整单失败。
  // 注意别写成裸 /token/：那会误伤上下文超长（max_tokens / token limit）。
  /refresh[ _-]?token/i,                // codex 人话版 + paint 的 refresh_token_invalidated
  /token.{0,24}(revoked|invalidated)/i, // 「… token was revoked / invalidated」
  /session has ended/i,                 // OpenAI 掉登录：「Your session has ended.」
  /log ?in again/i,                     // 同上的尾巴，三家掉登录文案共有
];

// ③ 模型被账号拒 —— 这条腿的模型用不了，腿本身就是废的，该换（2026-09-07）。
// 当天 42 单里 5 单栽在这里：kimi 撞配额正常换到 codex，而 codex 没设
// BOOK_CODEX_MODEL、吃了 CLI 默认的 gpt-5.5，被这个 ChatGPT 账号拒掉；
// 判据只认配额/凭据 → 判成「书本身写坏了」→ 第三条腿一次都没试就整单失败退款。
// 两种措辞、两种状态码都要认（同日实测）：
//   404  The model `gpt-5.5` does not exist or you do not have access to it.
//   400  The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.
// 都限定在 model 一词附近——否则任何 ENOENT / 「功能不支持」都会被当成换腿理由。
const MODEL_REJECTED_PATTERNS: RegExp[] = [
  /model.{0,40}does not exist/i,        // 404 前半句（模型名夹在中间，带反引号）
  /do not have access to it/i,          // 404 后半句
  /model.{0,40}is not supported/i,      // 400：「'gpt-5.6' model is not supported…」
  /model[ _-]?not[ _-]?found/i,         // 机器码版
];

// 明确「不是配额」的错误：这些词出现时，即便文本里混进了上面某个词也不换腿。
// error_max_turns 是书写太长撞轮数上限，high risk 是 Kimi 内容风控——
// 两者换腿重跑必然重蹈覆辙。
const NOT_QUOTA_PATTERNS: RegExp[] = [
  /error_max_turns/i,
  /high risk/i,
];

export function shouldTryNextLeg(error: string | undefined | null): boolean {
  const s = String(error ?? "");
  if (!s) return false;
  if (NOT_QUOTA_PATTERNS.some((re) => re.test(s))) return false;
  if (MODEL_REJECTED_PATTERNS.some((re) => re.test(s))) return true;
  return QUOTA_PATTERNS.some((re) => re.test(s));
}

// ── 从 SDK 消息流里抠真正的报错文案（2026-10-01）────────────────────────
//
// 第四次被同一个形状的洞咬：10/1 凌晨 Kimi 周配额打穿，SDK 把 403 当成一条
// assistant 文本消息（isApiErrorMessage / error:"authentication_failed"）发下来，
// 随后的 result 是 subtype=success + is_error=true，而 errors[] 是空的——引擎把
// error 记成了字面 "success"，shouldTryNextLeg("success") 自然判 false，codex 和
// claude 两条腿一次没试就整单退款，4 本书 + 2 次修书 20 分钟内全灭。
// 修法：流里每条 assistant 消息都过一遍这个函数，记住最后一条 API 错误；result
// 不带 errors[] 时拿它当 error。

const API_ERROR_TEXT = /Failed to authenticate|API Error: \d{3}|usage limit|rate limit/i;

function messageText(msg: any): string {
  const content = msg?.message?.content ?? msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

/** 一条 SDK 消息若是「API 错误伪装成的 assistant 文本」就返回其文案，否则返回 ""。 */
export function apiErrorFromMessage(msg: any): string {
  if (!msg || msg.type !== "assistant") return "";
  const text = messageText(msg).trim();
  const flagged = msg.isApiErrorMessage === true || (typeof msg.error === "string" && msg.error);
  if (!flagged && !API_ERROR_TEXT.test(text.slice(0, 300))) return "";
  const head = typeof msg.error === "string" && msg.error && !text.includes(msg.error) ? `${msg.error}: ` : "";
  return (head + (text || String(msg.error ?? "api error"))).slice(0, 400);
}

/**
 * 把 SDK 的 result 消息归结成 {ok, error}。lastApiError 是流里最后一条 API 错误
 * 文案（apiErrorFromMessage），result.errors[] 为空时顶上——这样换腿判据看到的
 * 永远是带状态码/配额字样的原话，而不是 "success"/"error" 这种分类名。
 */
export function classifyResult(
  msg: { subtype?: string; is_error?: boolean; errors?: unknown; result?: unknown },
  lastApiError = "",
): { ok: boolean; error: string } {
  const reply = typeof msg.result === "string" ? msg.result : "";
  let ok = msg.subtype === "success" && !msg.is_error;
  // CLI 正常退出但第一轮就是 API 错误（401/无效 key 等）时 subtype 仍是 success、
  // is_error 也可能是 false——按文本识别（2026-08-24 自检踩到）。
  if (ok && (lastApiError || API_ERROR_TEXT.test(reply.slice(0, 300)))) ok = false;
  if (ok) return { ok, error: "" };
  const errs = Array.isArray(msg.errors) ? msg.errors.map(String).filter(Boolean) : [];
  const subtype = String(msg.subtype ?? "error");
  if (errs.length) return { ok, error: `${subtype}: ${errs.join("; ").slice(0, 400)}` };
  if (lastApiError) return { ok, error: `${subtype}: ${lastApiError}` };
  if (API_ERROR_TEXT.test(reply.slice(0, 300))) return { ok, error: reply.slice(0, 400) };
  return { ok, error: subtype };
}

/**
 * 按可用性过滤腿：没配凭据的腿直接跳过，别浪费一次重跑去撞必然的失败。
 * - kimi   需要兼容端点的 BASE_URL（API_KEY 空也允许，某些端点不校验）
 * - claude 需要 lab 自己的订阅 OAuth token
 * - codex  只要有 codex 可执行文件（默认装着，故缺省可用）
 */
export function availableLegs(
  legs: BookLeg[],
  env: { kimi?: boolean; codex?: boolean; claude?: boolean },
): BookLeg[] {
  return legs.filter((l) => env[l] !== false);
}
