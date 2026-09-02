// 写书三腿链的判别单测。跑法：npm test（先 tsc build，再 node --test）。
// 这些错误串全部抄自 2026-09-02 事故当天 journalctl 的真实日志。
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldTryNextLeg, parseLegs, availableLegs, DEFAULT_LEGS } from "../dist/book-legs.js";

// ── 配额耗尽 → 必须换腿 ──────────────────────────────────────────────
test("Kimi 5 小时配额耗尽（9/2 事故原文）判为配额", () => {
  const real =
    "Failed to authenticate. API Error: 403 You've reached your 5-hour usage limit. " +
    "Your quota will reset when the current 5-hour window ends. To continue now, " +
    "purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota";
  assert.equal(shouldTryNextLeg(real), true);
});

test("各家配额/限流文案都判为配额", () => {
  for (const s of [
    "Claude AI usage limit reached",
    "You've hit your usage limit for this 5-hour window",
    "429 Too Many Requests",
    "rate_limit_error",
    "rate limit exceeded",
    "insufficient_quota",
    "API Error: 403",
    "overloaded_error",
  ]) assert.equal(shouldTryNextLeg(s), true, s);
});

test("令牌被吊销/失效也换腿（9/2 傍晚《易经在说什么》事故原文）", () => {
  // codex 腿当天的原话——整单就是卡在这句上没换第三条腿。
  const codexReal =
    "Your access token could not be refreshed because your refresh token was revoked";
  assert.equal(shouldTryNextLeg(codexReal), true);
  for (const s of [
    "refresh_token_invalidated",                      // paint 同日 401 的机器码
    "Your session has ended. Please log in again.",   // OpenAI 掉登录的人话版
    "the token was revoked",
    "auth token invalidated",
  ]) assert.equal(shouldTryNextLeg(s), true, s);
});

test("上下文超长不是凭据问题，别被 token 二字带偏", () => {
  // 防止上面那条泛化模式误伤：这些都该认输，换腿只会再烧一份额度。
  for (const s of [
    "prompt is too long: 250000 tokens > 200000 maximum",
    "max_tokens exceeded",
    "token limit reached for this request",
  ]) assert.equal(shouldTryNextLeg(s), false, s);
});

test("凭据失效也换腿：腿一样是废的", () => {
  for (const s of [
    "Not logged in. Run codex login",
    "401 Unauthorized",
    "invalid api key",
    "authentication_error",
    "Your credit balance is too low to access the API",
    "Failed to authenticate.",
  ]) assert.equal(shouldTryNextLeg(s), true, s);
});

// ── 不是配额 → 不换腿（换了也是白烧一份额度）────────────────────────
test("书本身写坏了的错误不判为配额", () => {
  for (const s of [
    "error_max_turns",
    "书没写完就超时了（180 分钟兜底）",
    "codex exit 1",
    "Claude Code process exited with code 1",
    "ENOENT: no such file or directory",
    "",
    undefined,
    null,
  ]) assert.equal(shouldTryNextLeg(s), false, String(s));
});

test("Kimi 内容风控 400 high risk 不换腿：换了必然重蹈覆辙", () => {
  assert.equal(shouldTryNextLeg("API Error: 400 high risk content detected"), false);
});

test("否定模式优先于配额模式：撞轮数上限即便文中带 quota 也不换腿", () => {
  assert.equal(shouldTryNextLeg("error_max_turns (quota fine)"), false);
});

// ── 顺序解析 ────────────────────────────────────────────────────────
test("默认顺序就是用户定的 kimi → codex → claude", () => {
  assert.deepEqual(DEFAULT_LEGS, ["kimi", "codex", "claude"]);
  assert.deepEqual(parseLegs(undefined), ["kimi", "codex", "claude"]);
  assert.deepEqual(parseLegs(""), ["kimi", "codex", "claude"]);
});

test("BOOK_LEGS 可改顺序、去重、忽略非法名", () => {
  assert.deepEqual(parseLegs("codex,kimi"), ["codex", "kimi"]);
  assert.deepEqual(parseLegs(" CLAUDE , kimi "), ["claude", "kimi"]);
  assert.deepEqual(parseLegs("kimi,kimi,codex"), ["kimi", "codex"]);
  assert.deepEqual(parseLegs("gpt5,bogus"), ["kimi", "codex", "claude"]); // 全非法 → 默认
});

// ── 可用性过滤 ──────────────────────────────────────────────────────
test("没配凭据的腿被跳过，不浪费一次必败的重跑", () => {
  assert.deepEqual(
    availableLegs(["kimi", "codex", "claude"], { kimi: false }),
    ["codex", "claude"],
  );
  assert.deepEqual(
    availableLegs(["kimi", "codex", "claude"], { kimi: true, codex: true, claude: true }),
    ["kimi", "codex", "claude"],
  );
  // 未声明的腿视为可用（codex 默认装着）
  assert.deepEqual(availableLegs(["kimi", "codex"], {}), ["kimi", "codex"]);
});
