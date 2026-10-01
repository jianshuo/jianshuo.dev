// 10/1 Kimi 周配额事故的回归测试：错误藏在 SDK 的 assistant 消息里，
// result.errors[] 为空，引擎把 error 记成了字面 "success"，换腿判据瞎掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiErrorFromMessage, classifyResult, shouldTryNextLeg } from "../dist/book-legs.js";

const KIMI_WEEKLY =
  "Failed to authenticate. API Error: 403 You've reached your weekly (7-day) usage limit. " +
  "Your quota will reset when the current 7-day window ends. To continue now, " +
  "purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota";

test("SDK 把 403 伪装成 assistant 文本消息 → apiErrorFromMessage 抠出原话", () => {
  // 形状抄自 /opt/claude-agent/.claude/projects/-opt-claude-agent-bookrun/7bc05273….jsonl
  const msg = {
    type: "assistant",
    message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: KIMI_WEEKLY }] },
    error: "authentication_failed",
    isApiErrorMessage: true,
  };
  const got = apiErrorFromMessage(msg);
  assert.match(got, /weekly \(7-day\) usage limit/);
  assert.match(got, /^authentication_failed: Failed to authenticate/);
  assert.equal(shouldTryNextLeg(got), true);
});

test("没有标记位时按文案识别 API 错误；普通 assistant 文本不算", () => {
  const plain = { type: "assistant", message: { content: [{ type: "text", text: "第三章写好了，开始第四章。" }] } };
  assert.equal(apiErrorFromMessage(plain), "");
  const unflagged = { type: "assistant", message: { content: [{ type: "text", text: "API Error: 429 Too Many Requests" }] } };
  assert.match(apiErrorFromMessage(unflagged), /429/);
  assert.equal(apiErrorFromMessage({ type: "result", subtype: "success", result: KIMI_WEEKLY }), "");
});

test("classifyResult：result.errors[] 空 + is_error → 用流里的 API 错误，不再记成 \"success\"", () => {
  // 10/1 事故原形：subtype=success, is_error=true, errors=[]，引擎记 ERROR=success。
  const r = classifyResult({ subtype: "success", is_error: true, errors: [], result: "" }, KIMI_WEEKLY);
  assert.equal(r.ok, false);
  assert.match(r.error, /^success: Failed to authenticate/);
  assert.equal(shouldTryNextLeg(r.error), true);
});

test("classifyResult：result.errors[] 有货优先；真成功不受流里历史错误影响", () => {
  const r = classifyResult({ subtype: "error_during_execution", is_error: true, errors: ["Not logged in"] }, KIMI_WEEKLY);
  assert.equal(r.error, "error_during_execution: Not logged in");
  const ok = classifyResult({ subtype: "success", is_error: false, result: "书写完了。" }, "");
  assert.deepEqual(ok, { ok: true, error: "" });
  // subtype=success 且 is_error=false 但流里出过 API 错误 → 不算写完（8/24 自检那类）
  const fake = classifyResult({ subtype: "success", is_error: false, result: "" }, KIMI_WEEKLY);
  assert.equal(fake.ok, false);
  assert.equal(shouldTryNextLeg(fake.error), true);
  // 撞轮数没有 API 错误 → 仍是 subtype，判据照旧不换腿
  const mt = classifyResult({ subtype: "error_max_turns", is_error: true, errors: [] }, "");
  assert.equal(mt.error, "error_max_turns");
  assert.equal(shouldTryNextLeg(mt.error), false);
});
