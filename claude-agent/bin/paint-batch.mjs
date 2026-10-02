// paint-batch — 一条前台命令画一批图（2026-10-01 起，绘本出图提速用；2026-10-02 并入统一客户端）。
//
//   paint-batch 清单.json [--group <书的slug>] [--engine auto|codex|seedream] [--force]
//
// 清单 = JSON 数组，每项一张图：
//   {"out":"/abs/book-x/p01.jpg","prompt":"…","image":"/abs/book-x/refs.png","size":"1024x1024","quality":"high"}
// out / prompt 必填；image/size/quality/transparent/format/compression/engine/group 与 bin/paint 同义。
// 命令行的 --group / --engine 作用于清单里没写这两项的条目。
//
// 和 bin/paint 用的是同一个客户端（paint-client.mjs）：提交 → 等 → 下载，别的一概不管。
// 降级、重试、限流、冷却、尺寸规整、group 画风粘性全在 paint 服务端（说明书 paint/USAGE.md）。
//
// 行为：
//   - 整批一次全提交，服务端按 3 并发排队画；每张都有服务端 8 分钟整单期限（从提交算），
//     所以整条命令最长 ~9 分钟必返回，不碰 agent 单条 Bash 10 分钟上限。每批别超过 6 张，
//     多了排在后面的会 deadline_exceeded（重跑本清单即可，画好的自动跳过）；
//   - out 已存在就跳过（续跑友好），--force 才重画；
//   - 一张失败不拖垮整批：逐张报 ok / FAIL <code>: <message>，有失败退出码 1；
//   - 最后报这批图（含跳过的已有图）的引擎分布；codex/seedream 混用时点名少数派，按 skill 统一重画。
import { existsSync, readFileSync } from "node:fs";
import { paintOne, formatError, engineTally } from "./paint-client.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const VALUED = new Set(["--concurrency", "--group", "--engine"]); // --concurrency 旧参数，已无意义，收下不报错
const manifestPath = args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
const force = args.includes("--force");
const group = flag("--group");
const engine = flag("--engine");

if (!manifestPath) {
  console.error('usage: paint-batch 清单.json [--group slug] [--engine auto|codex|seedream] [--force]\n清单: [{"out":"p01.jpg","prompt":"…","image":"refs.png"}, …]');
  process.exit(2);
}

let items;
try {
  items = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(items)) throw new Error("清单顶层必须是数组");
  items.forEach((it, i) => {
    if (!it || typeof it.out !== "string" || typeof it.prompt !== "string" || !it.out || !it.prompt)
      throw new Error(`第 ${i + 1} 项缺 out 或 prompt`);
  });
  const outs = items.map((it) => it.out);
  const dup = outs.find((o, i) => outs.indexOf(o) !== i);
  if (dup) throw new Error(`out 重复：${dup}`);
} catch (e) {
  console.error(`清单读不了：${e.message}`);
  process.exit(2);
}

const t0 = Date.now();
const todo = items.filter((it) => force || !existsSync(it.out));
for (const it of items) if (!todo.includes(it)) console.log(`skip  ${it.out}  (已存在，--force 才重画)`);
console.error(`paint-batch：${todo.length} 张，一次提交，服务端 3 并发${group ? `，group=${group}` : ""}`);

const results = await Promise.all(todo.map(async (it) => {
  const r = await paintOne({ group, engine, ...it });
  const secs = Math.round(r.secs);
  console.log(r.ok
    ? `ok    ${it.out}  (${secs}s, ${r.engine}${r.model ? " " + r.model : ""}${r.fallback_reason ? "，降级：" + r.fallback_reason : ""})`
    : `FAIL  ${it.out}  (${secs}s)  ${formatError(r.error)}`);
  return r;
}));

const failed = results.filter((r) => !r.ok);
console.log(`— ${results.length - failed.length}/${results.length} 张画好，跳过 ${items.length - todo.length}，用时 ${Math.round((Date.now() - t0) / 1000)}s` +
  (failed.length ? `；失败 ${failed.length} 张：${failed.map((f) => f.out).join(" ")}（单独重跑本清单即可，已画好的会自动跳过）` : ""));

const t = engineTally(items.map((it) => it.out).filter((p) => existsSync(p)));
if (t.minority.length) {
  console.log(`⚠ 引擎混用：codex ${t.counts.codex} / seedream ${t.counts.seedream}。多数是 ${t.majority}；` +
    `全书画完后把这些少数派删掉，再跑「paint-batch 本清单 --engine ${t.majority}」只重画它们：${t.minority.join(" ")}`);
} else if (t.majority) {
  console.log(`引擎：全部 ${t.majority}`);
}
process.exit(failed.length ? 1 : 0);
