// 租约学单次消耗（视频书这类长租约进「学到的单次消耗」表）：开租拍快照，complete 后探一次前后相减。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "../src/pool.ts";
import { Leases } from "../src/leases.ts";

const NOW = Date.now();
const R5 = NOW + 3600_000, R7 = NOW + 3.5 * 86400_000;
const usage = (used5h: number, used7d: number, r5 = R5) => ({ used5h, reset5h: r5, used7d, reset7d: R7, healthy: true, probedAt: NOW });
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(after: ReturnType<typeof usage>) {
  const d = await mkdtemp(join(tmpdir(), "leases-learn-"));
  await writeFile(
    join(d, "config.json"),
    JSON.stringify({
      engines: {
        claude: { accounts: [{ id: "claude-1" }] },
        codex: { accounts: [{ id: "codex-1", codex_home: "/x" }] },
        "gpt-image": { quota_from: "codex", accounts: [{ id: "codex-1" }] },
      },
      policies: {
        text: { engines: "failover", keys: "headroom", order: ["claude"] },
        image: { engines: "failover", keys: "headroom", order: ["gpt-image"] },
      },
      // video 用 20 而不是线上的 40：两张租约同时开才不撞 85 红线
      estimates: { video: { claude: { d5h: 20, d7d: 8 } }, image: { "gpt-image": { d5h: 5, d7d: 3 } } },
      concurrency: { per_account: 3 },
    }),
  );
  const pool = new Pool(join(d, "config.json"), join(d, ".env"), join(d, "pool.json"));
  const probes: string[] = [];
  pool.probe = async (e: any, id: string) => (probes.push(`${e}/${id}`), e === "claude" ? after : usage(30, 10));
  pool.selectState().usage["claude/claude-1"] = usage(10, 20);
  pool.selectState().usage["codex/codex-1"] = usage(10, 5);
  return { pool, leases: new Leases(pool), probes };
}

test("视频书租约独占账号、同窗口内成功 → 学到 video|claude（前后相减）", async () => {
  const { pool, leases } = await setup(usage(42, 27));
  const { lease } = leases.create({ kind: "text", task_class: "video", engine_hints: { require: ["claude"] }, ttl_ms: 6 * 3600_000 }, "video");
  assert.equal(lease?.engine, "claude");
  assert.deepEqual(lease?.before, { u5: 10, r5: R5, u7: 20, r7: R7, shared: false });
  leases.complete(lease!.id, "video", { ok: true, engine_used: "claude" });
  await tick(); await tick();
  assert.deepEqual(pool.learnedTable()["video|claude"], { d5h: 32, d7d: 7 });
  assert.deepEqual(lease!.learned, { d5h: 32, d7d: 7 });
});

test("开租时账号上已有别的活 → 不学（会混进别人的消耗）", async () => {
  const { pool, leases } = await setup(usage(42, 27));
  const a = leases.create({ kind: "text", task_class: "video", engine_hints: { require: ["claude"] } }, "video").lease!;
  const b = leases.create({ kind: "text", task_class: "video", engine_hints: { require: ["claude"] } }, "video").lease!;
  assert.equal(b.before?.shared, true);
  leases.complete(b.id, "video", { ok: true, engine_used: "claude" });
  await tick(); await tick();
  assert.equal(pool.learnedTable()["video|claude"], undefined, "b 开租时 a 在跑");
  leases.complete(a.id, "video", { ok: true, engine_used: "claude" });
  await tick(); await tick();
  assert.ok(pool.learnedTable()["video|claude"], "a 开租时独占、结束时 b 已还 → 学");
});

test("失败、跨 5h 窗口都不学", async () => {
  const { pool, leases } = await setup(usage(42, 27, R5 + 5 * 3600_000));
  const a = leases.create({ kind: "text", task_class: "video", engine_hints: { require: ["claude"] } }, "video").lease!;
  leases.complete(a.id, "video", { ok: false, error: "做书失败" });
  const b = leases.create({ kind: "text", task_class: "video", engine_hints: { require: ["claude"] } }, "video").lease!;
  leases.complete(b.id, "video", { ok: true, engine_used: "claude" });
  await tick(); await tick();
  assert.equal(pool.learnedTable()["video|claude"], undefined);
});

test("出图租约照旧只探不学（不动 paint 的预估）", async () => {
  const { pool, leases, probes } = await setup(usage(42, 27));
  const { lease } = leases.create({ kind: "image" }, "paint");
  leases.complete(lease!.id, "paint", { ok: true, engine_used: "gpt-image" });
  await tick(); await tick();
  assert.deepEqual(probes, ["codex/codex-1"]);
  assert.equal(pool.learnedTable()["image|gpt-image"], undefined);
});
