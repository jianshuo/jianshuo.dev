// 状态页：排队、租约两栏；最近任务带开始时间和书名（按幂等键反查书库 book.json）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "../src/pool.ts";
import { Leases } from "../src/leases.ts";
import { bookForKey, resetBookIndex } from "../src/book-index.ts";
import { renderStatus } from "../src/status-page.ts";

test("书名反查：写书键 <jobId>:main / contN、修书键 revise:<slug>#ts", async () => {
  const ws = await mkdtemp(join(tmpdir(), "ws-"));
  await mkdir(join(ws, "book-aging"));
  await writeFile(join(ws, "book-aging", "book.json"), JSON.stringify({ title: "如何对抗衰老", slug: "aging", jobId: "d3250c15-88c3-40ea-8e62-bfb598bb58fd" }));
  resetBookIndex();
  assert.deepEqual(bookForKey("d3250c15-88c3-40ea-8e62-bfb598bb58fd:main", ws), { book: { title: "如何对抗衰老", slug: "aging" }, what: "写书" });
  assert.equal(bookForKey("d3250c15-88c3-40ea-8e62-bfb598bb58fd:cont2", ws).what, "续写 2");
  assert.equal(bookForKey("revise:aging#1792900000000", ws).book?.title, "如何对抗衰老");
  assert.deepEqual(bookForKey("whatever", ws), {});
  resetBookIndex();
});

test("状态页渲染排队快照、租约步骤、任务开始时间（北京时间）和 label", async () => {
  const d = await mkdtemp(join(tmpdir(), "sp-"));
  await writeFile(
    join(d, "config.json"),
    JSON.stringify({ engines: { claude: { accounts: [{ id: "claude-1" }] } }, policies: {}, estimates: { video: { claude: { d5h: 40, d7d: 8 } } } }),
  );
  const pool = new Pool(join(d, "config.json"), join(d, ".env"), join(d, "pool.json"));
  const now = Date.parse("2026-10-26T10:50:00Z");
  pool.selectState().usage["claude/claude-1"] = { used5h: 10, reset5h: now + 3600_000, used7d: 5, reset7d: now + 3 * 86400_000, healthy: true, probedAt: now };
  const leases = new Leases(pool);
  const { lease } = leases.create({ kind: "text", task_class: "video", label: "《随机》视频书", engine_hints: { require: ["claude"] }, force: true }, "book-runner", now);
  assert.ok(lease, "租到了");
  leases.progress(lease!.id, "book-runner", { step: "Claude 开始制作" }, now);
  leases.putQueue("video-book", "book-runner", { title: "视频书排队", note: "下个名额 18:50", items: [{ label: "《恒生科技指数》", at: now }] }, now);
  const run: any = {
    id: "r_x", caller: "book-runner", createdAt: now - 600_000, status: "running", attempts: [], tried: [],
    threadId: "t", req: { task_class: "book", idempotency_key: "nope", label: "写书 · 关于随机的一本书" },
  };
  const html = renderStatus(pool, [run], leases, now);
  for (const s of ["视频书排队", "《恒生科技指数》", "下个名额 18:50", "《随机》视频书", "Claude 开始制作", "10-26 18:40", "写书 · 关于随机的一本书", "北京时间 10-26 18:50"])
    assert.ok(html.includes(s), `页面里应有 ${s}`);
});
