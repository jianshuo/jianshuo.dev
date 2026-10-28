// 出图批次：一批一个引擎、按账号并发排队、撞墙暂停不换引擎（batches.ts）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "../src/pool.ts";
import { Batches, MAX_PAUSE_MS, publicBatch } from "../src/batches.ts";

const NOW = Date.now();
const fresh = (used5h: number, used7d = 2) => ({ used5h, reset5h: NOW + 3600_000, used7d, reset7d: NOW + 3.5 * 86400_000, healthy: true, probedAt: NOW });

async function setup(over: any = {}) {
  const d = await mkdtemp(join(tmpdir(), "batches-"));
  await writeFile(
    join(d, "config.json"),
    JSON.stringify({
      engines: {
        codex: { accounts: [{ id: "codex-1", codex_home: "/x" }] },
        "gpt-image": { quota_from: "codex", accounts: [{ id: "codex-1" }] },
        seedream: { accounts: [{ id: "ark-1", daily_cap: 200 }] },
      },
      policies: { image: { engines: "failover", keys: "headroom", order: ["gpt-image", "seedream"], limits: { pacing: false, cap_5h: 90, cap_7d: 90 } } },
      estimates: { image: { "gpt-image": { d5h: 3, d7d: 1 } } },
      concurrency: { image_per_account: 4, image_total: 6, ...(over.concurrency ?? {}) },
    }),
  );
  const pool = new Pool(join(d, "config.json"), join(d, ".env"), join(d, "pool.json"));
  const probes: string[] = [];
  pool.probe = async (e: any, id: string) => (probes.push(`${e}/${id}`), undefined);
  pool.selectState().usage["codex/codex-1"] = fresh(over.used5h ?? 10);
  const file = join(d, "batches.json");
  return { pool, batches: new Batches(pool, file), probes, file };
}

const jobs = (n: number, p = "j") => Array.from({ length: n }, (_, i) => ({ job_id: `${p}${i + 1}`, key: `/w/p${i + 1}.jpg` }));
const ids = (xs: { job_id: string }[]) => xs.map((x) => x.job_id);

test("一批 15 张：开批定 gpt-image，每账号 4 张并发，其余排队；画完一张补一张，始终同一个引擎", async () => {
  const { pool, batches, probes } = await setup();
  const { batch } = batches.submit({ items: jobs(15), group: "dudu", label: "《嘟嘟》" }, "paint");
  assert.equal(batch.engine, "gpt-image");
  const first = batches.claim("paint", 10);
  assert.deepEqual(ids(first), ["j1", "j2", "j3", "j4"], "按账号并发 4 张");
  assert.ok(first.every((x) => x.engine === "gpt-image"));
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 4);
  assert.equal(pool.inflight["codex/codex-1"].d5h, 12, "额度预留按张记在 codex 上");
  assert.deepEqual(batches.claim("paint", 10), [], "满了不派，也不外溢到 seedream");
  batches.complete("paint", "j1", { ok: true });
  assert.deepEqual(ids(batches.claim("paint", 10)), ["j5"]);
  for (let n = 2; n <= 15; n++) {
    batches.complete("paint", `j${n}`, { ok: true });
    batches.claim("paint", 10);
  }
  const b = batches.get(batch.id)!;
  assert.equal(b.status, "done");
  assert.ok(b.items.every((i) => i.status === "done"));
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 0);
  assert.deepEqual(probes, ["codex/codex-1"], "整批完了探一次 codex");
  assert.equal(publicBatch(b).counts.done, 15);
});

test("全站上限：两批分在两个引擎，合计不超过 image_total；interactive 单张插到整本书前面", async () => {
  const { batches } = await setup();
  batches.submit({ items: jobs(10, "g"), engine: "gpt-image" }, "paint");
  batches.submit({ items: jobs(10, "s"), engine: "seedream" }, "paint");
  const got = batches.claim("paint", 20);
  assert.equal(got.length, 6, "全站 6 张");
  assert.equal(got.filter((x) => x.engine === "gpt-image").length, 4);
  assert.equal(got.filter((x) => x.engine === "seedream").length, 2);
  batches.submit({ items: [{ job_id: "vd1" }], priority: "interactive" }, "paint");
  batches.complete("paint", "g1", { ok: true });
  assert.deepEqual(ids(batches.claim("paint", 5)), ["vd1"], "空出来的位子先给插队的单张");
});

test("group 绑定引擎：书的第一批定了 seedream，后面补画的批次即便 codex 有余量也走 seedream", async () => {
  const { batches } = await setup({ used5h: 80 });
  const a = batches.submit({ items: jobs(15, "a"), group: "book-x" }, "paint").batch;
  assert.equal(a.engine, "seedream", "15 张 × 3 点放不进 codex 的 90 红线 → 整批 seedream");
  const again = batches.submit({ items: jobs(2, "b"), group: "book-x" }, "paint").batch;
  assert.equal(again.engine, "seedream");
  assert.match(again.decidedReason ?? "", /group book-x/);
  const other = batches.submit({ items: jobs(1, "c") }, "paint").batch;
  assert.equal(other.engine, "gpt-image", "别的书照常按额度挑");
});

test("透明图只能 gpt-image；点名 seedream + 透明 → 400；坏请求 400；同一批重复交返回原批次", async () => {
  const { batches } = await setup({ used5h: 89 });
  const t = batches.submit({ items: [{ job_id: "t1", transparent: true }] }, "paint").batch;
  assert.equal(t.engine, "gpt-image", "透明图 force 到 gpt-image（不被红线拦）");
  assert.throws(() => batches.submit({ items: [{ job_id: "t2", transparent: true }], engine: "seedream" }, "paint"), /transparent/);
  assert.throws(() => batches.submit({ items: [] }, "paint"), /items/);
  assert.throws(() => batches.submit({ items: [{ job_id: "x" }, { job_id: "x" }] }, "paint"), /duplicate/);
  assert.throws(() => batches.submit({ items: [{ job_id: "y" }], engine: "dalle" }, "paint"), /engine/);
  const r = batches.submit({ items: [{ job_id: "t1", transparent: true }] }, "paint");
  assert.equal(r.existing, true);
  assert.equal(r.batch.id, t.id);
});

test("撞额度：冷却账号、这张放回队列、整批暂停，不换引擎；冷却结束接着用同一个引擎", async () => {
  const { pool, batches } = await setup();
  const { batch } = batches.submit({ items: jobs(6) }, "paint");
  batches.claim("paint", 10);
  const t0 = Date.now();
  batches.complete("paint", "j1", { ok: false, error: "usage_limit_reached: The usage limit has been reached (resets in 40m)" }, t0);
  const b = batches.get(batch.id)!;
  assert.equal(b.status, "running", "还有 3 张在画");
  assert.equal(b.items[0].status, "queued");
  const cool = pool.cooldownUntil("codex/codex-1");
  assert.ok(cool > t0);
  for (const j of ["j2", "j3", "j4"]) batches.complete("paint", j, { ok: true }, t0 + 1000);
  assert.equal(b.status, "paused");
  assert.deepEqual(batches.claim("paint", 10, t0 + 2000), [], "冷却中不派，也不改派 seedream");
  assert.equal(b.engine, "gpt-image");
  const resumed = batches.claim("paint", 10, cool + 1000);
  assert.deepEqual(ids(resumed), ["j1", "j5", "j6"]);
  assert.ok(resumed.every((x) => x.engine === "gpt-image"));
});

test("暂停超过 2 小时：剩下的图判失败，批次 failed", async () => {
  const { pool, batches } = await setup();
  const { batch } = batches.submit({ items: jobs(3) }, "paint");
  const t0 = Date.now();
  batches.claim("paint", 1, t0);
  batches.complete("paint", "j1", { ok: false, error: "429 usage_limit_reached weekly limit" }, t0);
  pool.setCooldown("codex/codex-1", t0 + 5 * 3600_000);
  batches.expire(t0 + MAX_PAUSE_MS - 1000);
  assert.equal(batches.get(batch.id)!.status, "paused");
  batches.expire(t0 + MAX_PAUSE_MS + 1000);
  const b = batches.get(batch.id)!;
  assert.equal(b.status, "failed");
  assert.ok(b.items.every((i) => i.status === "failed" && /paused over 2h/.test(i.error ?? "")));
});

test("普通失败只算这一张；被打断（paint 重启 / 期限）重排一次", async () => {
  const { batches } = await setup();
  const { batch } = batches.submit({ items: jobs(3) }, "paint");
  batches.claim("paint", 3);
  batches.complete("paint", "j1", { ok: false, error: "missing_image_result: no image" });
  batches.complete("paint", "j2", { ok: false, error: "deadline_exceeded: job exceeded 480s" });
  batches.complete("paint", "j3", { ok: true });
  const b = batches.get(batch.id)!;
  assert.equal(b.items[0].status, "failed");
  assert.equal(b.items[1].status, "queued");
  batches.claim("paint", 3);
  batches.complete("paint", "j2", { ok: false, error: "deadline_exceeded: again" });
  assert.equal(b.items[1].status, "failed", "第二次被打断就判失败");
  assert.equal(b.status, "failed");
});

test("心跳：3 分钟没心跳放回队列；paint 重启 release-all 全部放回；只有执行方能领活", async () => {
  const { pool, batches } = await setup();
  batches.submit({ items: jobs(3) }, "paint");
  const t0 = Date.now();
  batches.claim("paint", 3, t0);
  assert.deepEqual(batches.heartbeat("paint", ["j1", "j2", "nope"], t0 + 150_000), ["nope"]);
  batches.expire(t0 + 200_000);
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 2, "j3 没心跳，放回去了");
  assert.equal(batches.releaseAll("paint"), 2);
  assert.equal(pool.inflight["gpt-image/codex-1"].count, 0);
  assert.throws(() => batches.claim("book-runner", 1), /executor/);
});

test("取消：排队的直接失败，在画的下次心跳叫停，回报后批次 cancelled", async () => {
  const { batches } = await setup();
  const { batch } = batches.submit({ items: jobs(6) }, "book-runner");
  batches.claim("paint", 2);
  assert.throws(() => batches.cancel(batch.id, "intruder"), /not found/);
  batches.cancel(batch.id, "book-runner");
  assert.deepEqual(batches.heartbeat("paint", ["j1", "j2"]).sort(), ["j1", "j2"]);
  batches.complete("paint", "j1", { ok: true });
  batches.complete("paint", "j2", { ok: false, error: "killed" });
  const b = batches.get(batch.id)!;
  assert.equal(b.status, "cancelled");
  assert.ok(b.finishedAt);
  assert.deepEqual(batches.claim("paint", 5), []);
});

test("落盘：重启后批次、group 绑定、在画的预留都接回来", async () => {
  const { batches, file } = await setup();
  batches.submit({ items: jobs(5), group: "g1" }, "paint");
  batches.claim("paint", 2);
  await new Promise((r) => setTimeout(r, 50));
  const { pool: pool2 } = await setup();
  const again = new Batches(pool2, file);
  assert.equal(again.list().length, 1);
  assert.equal(again.pins.get("g1")?.engine, "gpt-image");
  assert.equal(pool2.inflight["gpt-image/codex-1"].count, 2);
  assert.deepEqual(ids(again.claim("paint", 10)), ["j3", "j4"]);
});

test("seedream 每张记当日张数，到上限暂停到明天", async () => {
  const { pool, batches } = await setup();
  const ark = pool.cfg.engines.seedream!.accounts[0];
  ark.daily_cap = 2;
  const { batch } = batches.submit({ items: jobs(2), engine: "seedream" }, "paint");
  batches.claim("paint", 5);
  batches.complete("paint", "j1", { ok: true });
  batches.complete("paint", "j2", { ok: true });
  assert.equal(pool.selectState().dailyCount["seedream/ark-1"], 2);
  assert.equal(batches.get(batch.id)!.status, "done");
  const next = batches.submit({ items: jobs(1, "n"), engine: "seedream" }, "paint").batch;
  assert.deepEqual(batches.claim("paint", 5), []);
  assert.equal(next.status, "paused");
  assert.match(next.pauseReason ?? "", /daily cap/);
});
