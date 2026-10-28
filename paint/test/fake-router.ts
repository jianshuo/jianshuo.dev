// 假 engine-router（内存版）：交批即排队，领活按提交顺序派，回报后按脚本给判定。
// 真调度（一批一个引擎、按账号并发、撞墙暂停）在 engine-router/test/batches.test.ts 测。
import type { BatchIn, Claim, ImageEngine, ImageRouter, RouterBatch } from "../src/router.ts";

type Item = { job_id: string; key?: string; batch_id: string; engine: ImageEngine; status: string; attempts: number; error?: string };

export function fakeRouter(
  opts: {
    /** 批次用哪个引擎（缺省：点名的那个，否则 gpt-image） */
    engine?: (b: BatchIn) => ImageEngine;
    /** 失败回报后的判定（缺省 failed）；queued = 放回队列但这里先扣住不再派（模拟整批暂停） */
    verdict?: (jobId: string, error: string) => "failed" | "queued";
    /** 交批直接报错（模拟 router 连不上） */
    down?: () => boolean;
  } = {},
) {
  const batches: (BatchIn & { batch_id: string })[] = [];
  const items = new Map<string, Item>();
  const completed: { jobId: string; ok: boolean; error?: string }[] = [];
  const stop = new Set<string>();
  let released = 0;
  const view = (id: string): RouterBatch | null => {
    const b = batches.find((x) => x.batch_id === id);
    if (!b) return null;
    const its = b.items.map((i) => items.get(i.job_id)!);
    return {
      batch_id: id, status: its.every((i) => i.status === "done") ? "done" : "running", engine: its[0]?.engine ?? null,
      account: null, decided_reason: null, group: b.group ?? null, label: b.label ?? null, paused_until: null, pause_reason: null,
      created_at: new Date().toISOString(), finished_at: null, counts: { total: its.length },
      items: its.map((i) => ({ job_id: i.job_id, key: i.key ?? null, status: i.status === "held" ? "queued" : i.status, attempts: i.attempts, error: i.error ?? null })),
    };
  };
  const router: ImageRouter = {
    async submitBatch(b) {
      if (opts.down?.()) throw new Error("router down");
      const batch_id = `b_${batches.length + 1}`;
      batches.push({ ...b, batch_id });
      const engine: ImageEngine = opts.engine?.(b) ?? (b.engine === "seedream" ? "seedream" : "gpt-image");
      for (const i of b.items) items.set(i.job_id, { job_id: i.job_id, key: i.key, batch_id, engine, status: "queued", attempts: 0 });
      return view(batch_id)!;
    },
    async getBatch(id) {
      return view(id);
    },
    async cancelBatch(id) {
      for (const i of items.values())
        if (i.batch_id === id) {
          if (i.status === "running") stop.add(i.job_id);
          else if (i.status !== "done") {
            i.status = "failed";
            i.error = "cancelled";
          }
        }
      return view(id);
    },
    async claim(max) {
      const out: Claim[] = [];
      for (const i of items.values()) {
        if (out.length >= max) break;
        if (i.status !== "queued") continue;
        i.status = "running";
        i.attempts++;
        out.push({ job_id: i.job_id, batch_id: i.batch_id, engine: i.engine });
      }
      return out;
    },
    async complete(jobId, r) {
      completed.push({ jobId, ...r });
      const i = items.get(jobId)!;
      i.status = r.ok ? "done" : (opts.verdict?.(jobId, r.error ?? "") ?? "failed");
      if (i.status === "queued") i.status = "held";
      i.error = r.error;
      return { status: i.status === "held" ? "queued" : i.status };
    },
    async heartbeat(ids) {
      return ids.filter((id) => stop.has(id));
    },
    async releaseAll() {
      released++;
      return 0;
    },
  };
  return { router, batches, items, completed, stop, released: () => released };
}
