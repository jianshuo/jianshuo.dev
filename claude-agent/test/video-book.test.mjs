// 视频书下单判定的单测（2026-10-25）。跑法：npm test。
// 钉的是「什么情况下会真的开一台机器」：已发布、在做、排队、失败冷却中都不能再下单；只查（/status）永不下单。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideVideo, videoUnit, videoUrl, SLUG_RE, publicEvents, queueSnapshot } from "../dist/video-book.js";

test("对外日志：只留时间和文字，路径、IP 被滤掉，非法条目丢弃", () => {
  const ev = publicEvents([
    { t: 1, text: "读到书：《炮声里的股市》共 13 章" },
    { t: 2, text: "失败：/opt/claude-agent/motion-book/books/x/cloud.log 第 3 行" },
    { t: 3, text: "连接 45.77.178.210 超时" },
    { t: 4, text: "~/art-films/x/音频/ch01.mp3" },
    { t: "x", text: "坏" }, null, { t: 5 },
  ]);
  assert.deepEqual(ev, [{ t: 1, text: "读到书：《炮声里的股市》共 13 章" }, { t: 2, text: "失败： 第 3 行" }, { t: 3, text: "连接 超时" }]);
  assert.deepEqual(publicEvents([{ t: 1, text: "取口播（书架听书）：13/13 章" }]), [{ t: 1, text: "取口播（书架听书）：13/13 章" }]);
  assert.deepEqual(publicEvents("not array"), []);
});

test("2026-10-25 真实泄露的旧 state.json：答复里没有路径、文件名、机器 ID、error", () => {
  const leaked = { state: "failed", step: "没有做出 HTML（看 cloud.log / claude.err）", updatedAt: 9, instance: "2e5452bc-b5d4-4d94-b3d9-c5ab18cdc226",
    error: "没有发布 === 结束，产物 /opt/claude-agent/motion-book/books/us-wars-markets === 已销毁 2e5452bc-b5d4-4d94-b3d9-c5ab18cdc226" };
  const s = JSON.stringify(decideVideo("us-wars-markets", { published: false, running: false, queued: null, trigger: true, now: 10, state: leaked }));
  for (const bad of ["/opt", "cloud.log", "claude.err", "2e5452bc", "error", "instance"]) assert.equal(s.includes(bad), false, bad);
  assert.match(s, /没有做出 HTML/);
});

test("logTail（内部日志尾巴，可能带路径）不会出现在失败答复里", () => {
  const d = decideVideo("x", { published: false, running: false, queued: null, trigger: true, now: 10, state: { state: "failed", step: "开机超时", updatedAt: 9, logTail: "/opt/claude-agent/secrets.env" } });
  assert.equal(JSON.stringify(d).includes("logTail"), false); assert.equal(JSON.stringify(d).includes("/opt"), false);
});

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

test("排队快照（给 router 状态页）：额度满时每本写出哪个名额什么时候空出", () => {
  // 缺省每天 2 本：窗口里两次开工（北京 10-25 23:00、10-26 01:00），队里三本
  const now = Date.parse("2026-10-26T10:00:00Z"), l1 = Date.parse("2026-10-25T15:00:00Z"), l2 = Date.parse("2026-10-25T17:00:00Z");
  const q = [{ slug: "a", title: "甲", requestedAt: now - 1000 }, { slug: "b", requestedAt: now }, { slug: "c", title: "丙", requestedAt: now }];
  const s = queueSnapshot(q, 0, [l1 - 2 * 86400000, l1, l2], now);
  assert.equal(s.note, "24 小时内已开工 2/2 本 · 在做 0/1 本 · 下个名额 10-26 23:00");
  assert.deepEqual(s.items.map((x) => x.label), ["《甲》", "《b》", "《丙》"]);
  assert.deepEqual(s.items.map((x) => x.note), ["a · 额度 10-26 23:00 空出", "b · 额度 10-27 01:00 空出", "c · 额度要等再往后的名额"]);
  // 额度还有：头一本只等前一本做完
  assert.equal(queueSnapshot(q.slice(0, 1), 1, [l2], now).items[0].note, "a · 额度有，等前一本做完");
  assert.deepEqual(queueSnapshot([], 0, [], now).items, []);
});
