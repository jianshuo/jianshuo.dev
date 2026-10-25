// 挑选器单测：配速线、红线、三种策略、软/硬约束、冷却、Seedream 日上限、同池预留。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { select, weeklyLine, type SelectState } from "../src/selector.ts";
import type { Usage } from "../src/probes.ts";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const WEEK = 7 * 86400_000;

const cfg = (extra: any = {}) =>
  parseConfig({
    engines: {
      claude: { accounts: [{ id: "claude-1", token_env: "C1" }, { id: "claude-2", token_env: "C2" }] },
      codex: { accounts: [{ id: "codex-1", codex_home: "/x" }] },
      kimi: { accounts: [{ id: "kimi-1", key_env: "K1" }] },
    },
    ...extra,
  });

// 周窗口：默认这一周已经过去一半（reset 在 3.5 天后）→ 配速线 = 50 + 10 = 60
const u = (used5h: number, used7d: number, extra: Partial<Usage> = {}): Usage => ({
  used5h,
  reset5h: NOW + 2 * 3600_000,
  used7d,
  reset7d: NOW + WEEK / 2,
  healthy: true,
  probedAt: NOW - 60_000,
  ...extra,
});

const state = (usage: Record<string, Usage>, extra: Partial<SelectState> = {}): SelectState => ({
  usage,
  inflight: {},
  cooldown: {},
  dailyCount: {},
  learned: {},
  cursors: {},
  ...extra,
});

test("weeklyLine：一周过半 → 50% + 宽限 10；刚重置 → 只有宽限；封顶 cap_7d", () => {
  const c = cfg();
  assert.equal(weeklyLine(c.limits, NOW + WEEK / 2, NOW), 60);
  assert.equal(weeklyLine(c.limits, NOW + WEEK, NOW), 10);
  assert.equal(weeklyLine(c.limits, NOW + 1000, NOW), 92);
  assert.equal(weeklyLine(c.limits, null, NOW), 92);
});

test("headroom：挑余量最大的引擎和账号", () => {
  const c = cfg();
  const r = select(c, state({ "claude/claude-1": u(70, 30), "claude/claude-2": u(10, 20), "codex/codex-1": u(40, 40), "kimi/kimi-1": u(44, 55) }), { kind: "text" }, NOW);
  assert.equal(r.pick?.key, "claude/claude-2");
});

test("5h 红线：已用 + 预估 > 85 就不合格，等到 5h 重置", () => {
  const c = cfg();
  const r = select(c, state({ "kimi/kimi-1": u(80, 10) }), { kind: "text", require: ["kimi"] }, NOW);
  assert.equal(r.pick, null);
  assert.match(r.candidates[0].reason, /5h 80% \+ est 10 > cap 85/);
  assert.equal(r.waitUntil, NOW + 2 * 3600_000);
});

test("周配速：一周过半时用到 59% 再加 2 点超过配速线 60 → 不合格", () => {
  const c = cfg();
  const r = select(c, state({ "kimi/kimi-1": u(0, 59) }), { kind: "text", require: ["kimi"] }, NOW);
  assert.equal(r.pick, null);
  assert.match(r.candidates[0].reason, /pace line 60/);
  assert.ok(r.waitUntil! > NOW, "配速线随时间上涨，有恢复时刻");
});

test("周初（重置后第一天）配速线约 24%：用到 25% 就拦住，15% 放行——防止周初烧光", () => {
  const c = cfg();
  const reset7d = NOW + 6 * 86400_000; // 过了 1/7 → 线 = 14.3 + 10 = 24.3
  const blocked = select(c, state({ "kimi/kimi-1": u(0, 25, { reset7d }) }), { kind: "text", require: ["kimi"] }, NOW);
  assert.equal(blocked.pick, null);
  const ok = select(c, state({ "kimi/kimi-1": u(0, 15, { reset7d }) }), { kind: "text", require: ["kimi"] }, NOW);
  assert.equal(ok.pick?.key, "kimi/kimi-1");
});

test("force：无视配速和红线，只要没撞到 100%", () => {
  const c = cfg();
  const st = state({ "kimi/kimi-1": u(90, 80) });
  assert.equal(select(c, st, { kind: "text", require: ["kimi"] }, NOW).pick, null);
  assert.equal(select(c, st, { kind: "text", require: ["kimi"], force: true }, NOW).pick?.key, "kimi/kimi-1");
  const full = state({ "kimi/kimi-1": u(100, 80) });
  assert.equal(select(c, full, { kind: "text", require: ["kimi"], force: true }, NOW).pick, null);
});

test("failover：按 order 取第一个有合格账号的引擎", () => {
  const c = cfg({ policies: { book: { engines: "failover", keys: "failover", order: ["kimi", "codex", "claude"] } } });
  const st = state({ "claude/claude-1": u(0, 0), "claude/claude-2": u(0, 0), "codex/codex-1": u(0, 0), "kimi/kimi-1": u(50, 50) });
  assert.equal(select(c, st, { kind: "text", taskClass: "book" }, NOW).pick?.key, "kimi/kimi-1");
  st.usage["kimi/kimi-1"] = u(84, 50);
  assert.equal(select(c, st, { kind: "text", taskClass: "book" }, NOW).pick?.key, "codex/codex-1");
});

test("round_robin：在合格引擎间轮流，游标前进", () => {
  const c = cfg({ policies: { rr: { engines: "round_robin", keys: "round_robin" } } });
  const st = state({ "claude/claude-1": u(0, 0), "claude/claude-2": u(0, 0), "codex/codex-1": u(0, 0), "kimi/kimi-1": u(0, 0) });
  const picks = [1, 2, 3, 4].map(() => select(c, st, { kind: "text", taskClass: "rr" }, NOW).pick!.engine);
  assert.deepEqual(picks, ["kimi", "codex", "claude", "kimi"]);
});

test("avoid 是软约束：排到最后；其他都满了时仍可兜底", () => {
  const c = cfg();
  const st = state({ "claude/claude-1": u(80, 30), "claude/claude-2": u(80, 30), "codex/codex-1": u(80, 30), "kimi/kimi-1": u(0, 0) });
  assert.equal(select(c, st, { kind: "text", avoid: ["kimi"] }, NOW).pick?.key, "kimi/kimi-1"); // 别人都不合格
  st.usage["codex/codex-1"] = u(50, 30);
  assert.equal(select(c, st, { kind: "text", avoid: ["kimi"] }, NOW).pick?.key, "codex/codex-1");
});

test("require / allow / exclude 是硬约束", () => {
  const c = cfg();
  const st = state({ "claude/claude-1": u(0, 0), "claude/claude-2": u(0, 0), "codex/codex-1": u(0, 0), "kimi/kimi-1": u(0, 0) });
  assert.equal(select(c, st, { kind: "text", require: ["codex"] }, NOW).pick?.key, "codex/codex-1");
  assert.equal(select(c, st, { kind: "text", allow: ["claude/claude-2"] }, NOW).pick?.key, "claude/claude-2");
  const r = select(c, st, { kind: "text", require: ["codex"], exclude: ["codex/codex-1"] }, NOW);
  assert.equal(r.pick, null);
  assert.equal(r.waitUntil, null, "被排除的账号不会恢复 → 没有等待时刻");
});

test("prefer（会话粘性）：原账号合格就继续用它，哪怕别人余量更大", () => {
  const c = cfg();
  const st = state({ "claude/claude-1": u(60, 30), "claude/claude-2": u(0, 0), "codex/codex-1": u(0, 0), "kimi/kimi-1": u(0, 0) });
  assert.equal(select(c, st, { kind: "text", prefer: "claude/claude-1" }, NOW).pick?.key, "claude/claude-1");
  st.usage["claude/claude-1"] = u(84, 30);
  assert.notEqual(select(c, st, { kind: "text", prefer: "claude/claude-1" }, NOW).pick?.key, "claude/claude-1");
});

test("不健康 / 冷却 / 并发满 都不合格；用量未知排在已知可用之后", () => {
  const c = cfg();
  const st = state(
    {
      "claude/claude-1": u(0, 0, { healthy: false, error: "401" }),
      "codex/codex-1": u(0, 0),
      "kimi/kimi-1": u(10, 10),
    },
    { cooldown: { "codex/codex-1": NOW + 60_000 }, inflight: {} },
  );
  const r = select(c, st, { kind: "text" }, NOW);
  assert.equal(r.pick?.key, "kimi/kimi-1"); // claude-2 未知，排后面
  const reasons = Object.fromEntries(r.candidates.map((x) => [x.key, x.reason]));
  assert.match(reasons["claude/claude-1"], /unhealthy/);
  assert.match(reasons["codex/codex-1"], /cooling down/);
  assert.equal(reasons["claude/claude-2"], "usage unknown");
  st.inflight["kimi/kimi-1"] = { count: 1, d5h: 10, d7d: 2 };
  assert.equal(select(c, st, { kind: "text" }, NOW).pick?.key, "claude/claude-2", "只剩未知的也能选");
});

test("在飞预留计入 5h 用量", () => {
  const c = cfg({ concurrency: { per_account: 3 } });
  const st = state({ "kimi/kimi-1": u(60, 10) }, { inflight: { "kimi/kimi-1": { count: 1, d5h: 20, d7d: 2 } } });
  const r = select(c, st, { kind: "text", require: ["kimi"] }, NOW);
  assert.equal(r.pick, null); // 60 + 20 + 10 > 85
});

test("学到的单次消耗优先于配置预估；size=large 翻倍", () => {
  const c = cfg({ estimates: { book: { kimi: { d5h: 5, d7d: 1 } } } });
  const st = state({ "kimi/kimi-1": u(60, 10) });
  assert.ok(select(c, st, { kind: "text", require: ["kimi"], taskClass: "book" }, NOW).pick);
  st.learned["book|kimi"] = { d5h: 30, d7d: 5 };
  assert.equal(select(c, st, { kind: "text", require: ["kimi"], taskClass: "book" }, NOW).pick, null);
  st.learned["book|kimi"] = { d5h: 15, d7d: 1 }; // 60 + 15 = 75 合格；large 翻倍 60 + 30 = 90 超红线
  assert.ok(select(c, st, { kind: "text", require: ["kimi"], taskClass: "book" }, NOW).pick);
  assert.equal(select(c, st, { kind: "text", require: ["kimi"], taskClass: "book", size: "large" }, NOW).pick, null);
});

test("capabilities：做不到的引擎不选（审查 #6）", () => {
  const c = cfg();
  const st = state({ "claude/claude-1": u(0, 0), "claude/claude-2": u(0, 0), "codex/codex-1": u(50, 30), "kimi/kimi-1": u(0, 0) });
  // network:false 但允许 shell → Claude 系能 curl 出网，只有 codex（workspace-write 断网）做得到
  const r1 = select(c, st, { kind: "text", capabilities: { network: false } }, NOW);
  assert.equal(r1.pick?.key, "codex/codex-1");
  assert.match(r1.candidates.find((x) => x.key === "kimi/kimi-1")!.reason, /network:false while shell/);
  // shell:false → codex 做不到；Claude 系可以
  const r2 = select(c, st, { kind: "text", capabilities: { shell: false } }, NOW);
  assert.notEqual(r2.pick?.engine, "codex");
  assert.match(r2.candidates.find((x) => x.key === "codex/codex-1")!.reason, /shell:false/);
  // network:false + shell:false → 只有 Claude 系（禁 Bash + WebFetch/WebSearch）
  const r3 = select(c, st, { kind: "text", capabilities: { network: false, shell: false } }, NOW);
  assert.ok(r3.pick && r3.pick.engine !== "codex");
  // 没要求 → 不影响
  assert.ok(select(c, st, { kind: "text", capabilities: {} }, NOW).pick);
});

test("不健康的账号给出下次探测的恢复时刻，排队模式能等它（审查 #5）", () => {
  const c = cfg();
  const r = select(c, state({ "kimi/kimi-1": u(0, 0, { healthy: false, error: "401", probedAt: NOW - 1000 }) }), { kind: "text", require: ["kimi"] }, NOW);
  assert.equal(r.pick, null);
  assert.ok(r.waitUntil && r.waitUntil > NOW);
});

test("策略级 limits：出图不配速、Codex 用到 90% 才换 seedream；写书照旧按周配速", () => {
  const c = parseConfig({
    engines: {
      codex: { accounts: [{ id: "codex-1", codex_home: "/x" }] },
      "gpt-image": { quota_from: "codex", accounts: [{ id: "codex-1" }] },
      seedream: { accounts: [{ id: "ark-1" }] },
    },
    policies: {
      image: { engines: "failover", keys: "headroom", order: ["gpt-image", "seedream"], limits: { pacing: false, cap_5h: 90, cap_7d: 90 } },
    },
    estimates: { image: { "gpt-image": { d5h: 3, d7d: 1 } } },
  });
  // 周窗口刚过一天（配速线约 24%），已用 70%：写书早被配速拦了，出图照样给 codex
  const reset7d = NOW + 6 * 86400_000;
  const st = state({ "codex/codex-1": u(40, 70, { reset7d }) });
  assert.equal(select(c, st, { kind: "text", require: ["codex"] }, NOW).pick, null, "文字（缺省策略）受配速约束");
  const img = select(c, st, { kind: "image", taskClass: "image" }, NOW);
  assert.equal(img.pick?.key, "gpt-image/codex-1");
  assert.match(img.candidates[0].reason, /cap 90/);
  // 周用量到 89%：89 + 1 = 90 还行；到 90% 就换 seedream
  st.usage["codex/codex-1"] = u(40, 89, { reset7d });
  assert.equal(select(c, st, { kind: "image", taskClass: "image" }, NOW).pick?.key, "gpt-image/codex-1");
  st.usage["codex/codex-1"] = u(40, 90, { reset7d });
  const r = select(c, st, { kind: "image", taskClass: "image" }, NOW);
  assert.equal(r.pick?.key, "seedream/ark-1");
  assert.match(r.candidates.find((x) => x.engine === "gpt-image")!.reason, /week cap 90/);
  // 5h 也按策略的 90：88 + 3 > 90 → seedream
  st.usage["codex/codex-1"] = u(88, 10, { reset7d });
  assert.equal(select(c, st, { kind: "image", taskClass: "image" }, NOW).pick?.key, "seedream/ark-1");
});

test("策略 limits 写错会被拒（reload 时保留旧配置）", () => {
  assert.throws(() => parseConfig({ policies: { image: { engines: "failover", keys: "headroom", limits: { pacing: "no" } } } }), /pacing must be/);
  assert.throws(() => parseConfig({ policies: { image: { engines: "failover", keys: "headroom", limits: { cap_7d: 150 } } } }), /0–100/);
  assert.throws(() => parseConfig({ policies: { image: { engines: "failover", keys: "headroom", limits: { cap: 90 } } } }), /unknown limits/);
});

test("出图：gpt-image 读 codex 的额度；failover 先 gpt-image 再 seedream；seedream 日上限", () => {
  const c = parseConfig({
    engines: {
      codex: { accounts: [{ id: "codex-1", codex_home: "/x" }] },
      "gpt-image": { quota_from: "codex", accounts: [{ id: "codex-1" }] },
      seedream: { accounts: [{ id: "ark-1", key_env: "ARK", daily_cap: 2 }] },
    },
    policies: { image: { engines: "failover", keys: "headroom", order: ["gpt-image", "seedream"] } },
  });
  const st = state({ "codex/codex-1": u(10, 5) });
  assert.equal(select(c, st, { kind: "image" }, NOW).pick?.key, "gpt-image/codex-1");
  st.usage["codex/codex-1"] = u(84, 5);
  assert.equal(select(c, st, { kind: "image" }, NOW).pick?.key, "seedream/ark-1");
  st.dailyCount["seedream/ark-1"] = 2;
  const r = select(c, st, { kind: "image" }, NOW);
  assert.equal(r.pick, null);
  assert.match(r.candidates.find((x) => x.engine === "seedream")!.reason, /daily cap/);
});
