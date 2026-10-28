// 租约：router 只挑账号、调用方自己执行（只剩文字长活，如视频书；出图走 batches.ts）。
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

test("出图租约已下线：kind 不是 text 一律 400，指向 /v1/image-batches", async () => {
  const { leases } = await setup();
  assert.throws(() => leases.create({ kind: "image" }, "paint"), /image-batches/);
  assert.throws(() => leases.create({}, "paint"), /image-batches/);
});

test("文字租约：预留记在账号上；过期自动释放；别人的租约回报不了", async () => {
  const { pool, leases } = await setup();
  const l = leases.create({ kind: "text", ttl_ms: 60_000 }, "book-runner").lease!;
  assert.equal(l.engine, "codex");
  assert.equal(pool.inflight["codex/codex-1"].count, 1);
  assert.throws(() => leases.complete(l.id, "intruder", { ok: true }), /lease not found/);
  leases.sweep(Date.now() + 61_000);
  assert.equal(pool.inflight["codex/codex-1"].count, 0);
  assert.equal(leases.active().length, 0);
  assert.throws(() => leases.complete(l.id, "book-runner", { ok: true }), /lease not found/);
});

test("长租约：label + progress 续期；完成后进最近记录；落盘后重启能接回预留和显示", async () => {
  const { pool } = await setup();
  const d = await mkdtemp(join(tmpdir(), "leases-file-"));
  const file = join(d, "leases.json");
  const leases = new Leases(pool, file);
  const t0 = Date.now();
  const { lease } = leases.create({ kind: "text", label: "《随机》视频书", ttl_ms: 600_000 }, "book-runner", t0);
  assert.equal(lease?.label, "《随机》视频书");
  leases.progress(lease!.id, "book-runner", { step: "安装制作环境" }, t0 + 500_000);
  assert.equal(lease!.progress?.step, "安装制作环境");
  assert.equal(lease!.expiresAt, t0 + 500_000 + 600_000, "报进度按原 ttl 续期");
  assert.throws(() => leases.progress(lease!.id, "paint", { step: "x" }), /not found/, "别人的租约不能报");
  leases.putQueue("video-book", "book-runner", { title: "视频书", note: "24h 4/4", items: [{ label: "《恒生科技》", at: t0 }] }, t0);
  await new Promise((r) => setTimeout(r, 50));

  // 「重启」：新的 Pool 读同一个租约文件
  const { pool: fresh } = await setup();
  const again = new Leases(fresh, file);
  assert.equal(again.active().length, 1);
  assert.equal(again.active()[0].progress?.step, "安装制作环境");
  assert.equal(fresh.inflight["codex/codex-1"].count, 1, "预留接回来了");
  assert.equal(again.queueSnapshots()[0].items[0].label, "《恒生科技》");
  assert.throws(() => again.putQueue("video-book", "paint", { items: [] }), /another caller/);

  again.complete(again.active()[0].id, "book-runner", { ok: true });
  assert.equal(again.active().length, 0);
  assert.equal(again.recent()[0].ok, true);
  assert.equal(fresh.inflight["codex/codex-1"].count, 0);
});
