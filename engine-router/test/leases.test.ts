// 租约：router 只挑账号、调用方自己执行（paint 出图）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "../src/pool.ts";
import { Leases } from "../src/leases.ts";

const NOW = Date.now();
const fresh = (used5h: number, used7d = 2) => ({ used5h, reset5h: NOW + 3600_000, used7d, reset7d: NOW + 3.5 * 86400_000, healthy: true, probedAt: NOW });

async function setup() {
  const d = await mkdtemp(join(tmpdir(), "leases-"));
  await writeFile(
    join(d, "config.json"),
    JSON.stringify({
      engines: {
        codex: { accounts: [{ id: "codex-1", codex_home: "/x" }] },
        "gpt-image": { quota_from: "codex", accounts: [{ id: "codex-1" }] },
        seedream: { accounts: [{ id: "ark-1", daily_cap: 2 }] },
      },
      policies: { image: { engines: "failover", keys: "headroom", order: ["gpt-image", "seedream"] } },
      estimates: { image: { "gpt-image": { d5h: 5, d7d: 3 } } },
      concurrency: { per_account: 3 },
    }),
  );
  const pool = new Pool(join(d, "config.json"), join(d, ".env"), join(d, "pool.json"));
  const probes: string[] = [];
  pool.probe = async (e: any, id: string) => (probes.push(`${e}/${id}`), undefined);
  pool.selectState().usage["codex/codex-1"] = fresh(10);
  return { pool, leases: new Leases(pool), probes };
}

test("出图租约：先给 gpt-image，预留记在 codex 账号上；回报后释放并探一次", async () => {
  const { pool, leases, probes } = await setup();
  const { lease } = leases.create({ kind: "image" }, "paint");
  assert.equal(lease?.engine, "gpt-image");
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 1, "并发记在真实账号键");
  assert.equal(pool.inflight["codex/codex-1"].d5h, 5, "额度预留记在 codex 上");
  leases.complete(lease!.id, "paint", { ok: true, engine_used: "gpt-image" });
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 0);
  assert.equal(pool.inflight["codex/codex-1"].d5h, 0);
  assert.deepEqual(probes, ["codex/codex-1"]);
});

test("回报 codex 额度报错 → codex 冷却，下一张改派 seedream，并记张数；日上限到了就没有可用引擎", async () => {
  const { pool, leases } = await setup();
  const a = leases.create({ kind: "image" }, "paint").lease!;
  leases.complete(a.id, "paint", { ok: true, engine_used: "seedream", error: "429 usage_limit_reached: The usage limit has been reached" });
  assert.ok(pool.cooldownUntil("codex/codex-1") > Date.now());
  assert.equal(pool.selectState().dailyCount["seedream/ark-1"], 1, "租的是 gpt-image、实际降级到 seedream 也记张数");
  const b = leases.create({ kind: "image" }, "paint").lease!;
  assert.equal(b.engine, "seedream");
  leases.complete(b.id, "paint", { ok: true });
  const none = leases.create({ kind: "image" }, "paint");
  assert.equal(none.lease, null);
  assert.ok(none.selection.candidates.some((c) => /daily cap/.test(c.reason)));
});

test("require / force：显式要 codex 时强制（配速线上也给），透明图只能 gpt-image", async () => {
  const { pool, leases } = await setup();
  pool.selectState().usage["codex/codex-1"] = fresh(10, 58); // 周窗口过半，配速线 60：58 + 3 超线
  assert.equal(leases.create({ kind: "image" }, "paint").lease?.engine, "seedream");
  assert.equal(leases.create({ kind: "image", engine_hints: { require: ["gpt-image"] } }, "paint").lease, null);
  assert.equal(leases.create({ kind: "image", engine_hints: { require: ["gpt-image"] }, force: true }, "paint").lease?.engine, "gpt-image");
});

test("过期自动释放；别人的租约回报不了", async () => {
  const { pool, leases } = await setup();
  const l = leases.create({ kind: "image", ttl_ms: 60_000 }, "paint").lease!;
  assert.throws(() => leases.complete(l.id, "intruder", { ok: true }), /lease not found/);
  leases.sweep(Date.now() + 61_000);
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 0);
  assert.equal(leases.active().length, 0);
  assert.throws(() => leases.complete(l.id, "paint", { ok: true }), /lease not found/);
});
