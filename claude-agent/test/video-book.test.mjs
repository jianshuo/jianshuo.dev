// 视频书下单判定的单测（2026-10-25）。跑法：npm test。
// 钉的是「什么情况下会真的开一台机器」：已发布、在做、排队、失败冷却中都不能再下单；只查（/status）永不下单。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVideo, videoUnit, videoUrl, SLUG_RE } from "../dist/video-book.js";

const now = 1792924000000;
const base = { published: false, running: false, queued: null, state: null, trigger: true, now };

test("已发布：直接答 done 和公开地址，不下单", () => {
  const d = decideVideo("home-inventory", { ...base, published: true, state: { state: "failed", updatedAt: now } });
  assert.deepEqual(d, { kind: "answer", status: 200, body: { state: "done", url: "https://voicedrop.cn/books/home-inventory/video/" } });
});

test("单元在跑：报 state.json 里的进度；state.json 还是上一轮的 failed/done 时报开机中", () => {
  const d = decideVideo("x", { ...base, running: true, state: { state: "making", step: "口播 3 章", startedAt: 1, updatedAt: 2 } });
  assert.equal(d.kind, "answer"); assert.equal(d.status, 202); assert.equal(d.body.state, "making"); assert.equal(d.body.step, "口播 3 章");
  const stale = decideVideo("x", { ...base, running: true, state: { state: "failed", step: "旧的", updatedAt: now - 1e9 } });
  assert.equal(stale.body.state, "booting");
});

test("在排队：报第几位，不重复下单", () => {
  assert.deepEqual(decideVideo("x", { ...base, queued: 2 }), { kind: "answer", status: 202, body: { state: "queued", position: 2 } });
});

test("失败后 6 小时内不重试，过了才重新下单", () => {
  const recent = decideVideo("x", { ...base, state: { state: "failed", step: "开机超时", error: "e", updatedAt: now - 3600e3 } });
  assert.equal(recent.kind, "answer"); assert.equal(recent.body.state, "failed"); assert.equal(recent.body.retryAfter, now - 3600e3 + 6 * 3600e3);
  assert.deepEqual(decideVideo("x", { ...base, state: { state: "failed", updatedAt: now - 7 * 3600e3 } }), { kind: "enqueue" });
});

test("只查（/status）永不下单；触发且没有任何记录才入队", () => {
  assert.deepEqual(decideVideo("x", { ...base, trigger: false }), { kind: "answer", status: 200, body: { state: "none" } });
  assert.deepEqual(decideVideo("x", base), { kind: "enqueue" });
});

test("单元名和 slug 校验：只收书架 slug 的字符，单元名 video-<slug>", () => {
  assert.equal(videoUnit("home-inventory"), "video-home-inventory");
  assert.equal(videoUrl("a-b"), "https://voicedrop.cn/books/a-b/video/");
  for (const ok of ["home-inventory", "read-the-fed", "a1"]) assert.match(ok, SLUG_RE);
  for (const bad of ["", "../etc", "a b", "A-B", "-x", "x;rm"]) assert.doesNotMatch(bad, SLUG_RE);
});
