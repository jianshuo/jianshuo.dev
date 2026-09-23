// 写书完成度对账的单测。起因：2026-09-23《一封一封的写》——引擎把画图丢后台后提前
// 交卷，runner 当成功收尾推送「书写好了」，用户拿到 1/14 的书。跑法：npm test。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessBook, isHardGap, continueHint } from "../dist/book-complete.js";

const book = (statuses, extra = {}) => ({
  slug: "dudu-de-xin",
  chapters: statuses.map((status, i) => ({ no: i + 1, title: `第 ${i + 1} 页`, status })),
  ...extra,
});

test("全 done + 有封面文件 = 齐了", () => {
  assert.equal(assessBook(book(["done", "done", "done"]), true), null);
});

test("全 done + book.json 已记 cover（老书封面早传过）= 齐了", () => {
  assert.equal(assessBook(book(["done", "done"], { cover: "cover.jpg" }), false), null);
});

test("dudu-de-xin 现场：1/14 done → 点名缺第 2–14 章，是硬缺口", () => {
  const gap = assessBook(book(["done", ...Array(13).fill("planned")]), false);
  assert.ok(gap);
  assert.equal(gap.done, 1);
  assert.equal(gap.total, 14);
  assert.deepEqual(gap.missing, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(gap.coverMissing, true);
  assert.match(gap.summary, /1\/14 章 done/);
  assert.match(gap.summary, /缺封面/);
  assert.equal(isHardGap(gap), true);
});

test("只缺封面：有缺口但不是硬缺口（不能因此退款）", () => {
  const gap = assessBook(book(["done", "done"]), false);
  assert.ok(gap);
  assert.deepEqual(gap.missing, []);
  assert.equal(gap.coverMissing, true);
  assert.equal(gap.summary, "缺封面");
  assert.equal(isHardGap(gap), false);
});

test("status 缺失 / writing / reviewing 都算没 done；没 no 字段按序号补", () => {
  const b = { slug: "x", chapters: [{ status: "done" }, { status: "writing" }, {}, { status: "reviewing" }] };
  const gap = assessBook(b, true);
  assert.deepEqual(gap.missing, [2, 3, 4]);
});

test("book.json 没 chapters（建筑师还没落章节表）= 只按封面判", () => {
  assert.equal(assessBook({ slug: "x", cover: "cover.jpg" }, false), null);
  assert.equal(assessBook({ slug: "x" }, false)?.coverMissing, true);
});

test("续写提示：点名缺的章、禁后台、三不", () => {
  const gap = assessBook(book(["done", "planned", "planned"]), false);
  const hint = continueHint(gap, 1);
  assert.match(hint, /第 1 次续写/);
  assert.match(hint, /第 2、3 章/);
  assert.match(hint, /封面/);
  assert.match(hint, /run_in_background/);
  assert.match(hint, /不要另起一本新书、不要换 slug/);
  assert.match(hint, /book-dudu-de-xin/);
});
