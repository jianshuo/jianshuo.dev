// 会话三档：原账号 resume / 同家族 resume（开关）/ 交接记录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { continuation, handoffPrompt, strictAllow, familyOf, type Thread } from "../src/threads.ts";

const base = {
  engines: {
    claude: { accounts: [{ id: "claude-1" }, { id: "claude-2" }] },
    kimi: { accounts: [{ id: "kimi-1" }] },
    codex: { accounts: [{ id: "codex-1" }] },
  },
};
const thread = (): Thread => ({
  id: "t_1",
  createdAt: 0,
  caller: "c",
  workdir: "/w",
  cwd: "/cwd",
  runs: [],
  sessions: { "claude/claude-1": "sess-A" },
  lastKey: "claude/claude-1",
  turns: [{ prompt: "第一轮问题", reply: "第一轮答复", account: "claude/claude-1", ts: 0 }],
});

test("familyOf：Kimi 也是 Claude Code CLI 家族", () => {
  assert.equal(familyOf("kimi"), "claude-cli");
  assert.equal(familyOf("claude"), "claude-cli");
  assert.equal(familyOf("codex"), "codex");
});

test("新会话 → 0 档；原账号 → 1 档 resume", () => {
  const cfg = parseConfig({ ...base, portable: { claude_family: false } });
  assert.deepEqual(continuation(cfg, undefined, "claude/claude-1"), { tier: 0 });
  assert.deepEqual(continuation(cfg, thread(), "claude/claude-1"), { tier: 1, session: "sess-A" });
});

test("同家族他号：可移植关闭 → 3 档交接；打开（缺省）→ 2 档 resume 同一会话", () => {
  const off = parseConfig({ ...base, portable: { claude_family: false } });
  assert.equal(parseConfig(base).portable.claude_family, true, "claude 家族缺省可移植（10/25 实测）");
  assert.equal(continuation(off, thread(), "claude/claude-2").tier, 3);
  const on = parseConfig({ ...base, portable: { claude_family: true } });
  assert.deepEqual(continuation(on, thread(), "claude/claude-2"), { tier: 2, session: "sess-A" });
  assert.deepEqual(continuation(on, thread(), "kimi/kimi-1"), { tier: 2, session: "sess-A" });
  assert.equal(continuation(on, thread(), "codex/codex-1").tier, 3, "跨类永远是交接");
});

test("strict 档允许的账号：原账号；开了可移植再加同家族", () => {
  assert.deepEqual(strictAllow(parseConfig({ ...base, portable: { claude_family: false } }), thread()), ["claude/claude-1"]);
  assert.deepEqual(strictAllow(parseConfig({ ...base, portable: { claude_family: true } }), thread())!.sort(), ["claude/claude-1", "claude/claude-2", "kimi/kimi-1"]);
});

test("交接记录：带上之前各轮问答和本轮请求；超长时从最近往前装", () => {
  const t = thread();
  const p = handoffPrompt(t, "第二轮问题");
  assert.match(p, /交接记录/);
  assert.match(p, /第一轮问题[\s\S]*第一轮答复[\s\S]*本轮请求[\s\S]*第二轮问题/);
  for (let i = 0; i < 20; i++) t.turns.push({ prompt: "问".repeat(1000), reply: "答".repeat(2000), account: "x", ts: 0 });
  const long = handoffPrompt(t, "最后");
  assert.ok(long.length < 16000);
  assert.match(long, /更早的 \d+ 轮已省略/);
  assert.match(long, /第 21 轮/, "最近一轮一定在");
});
