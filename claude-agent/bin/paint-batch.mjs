// paint-batch — 一条前台命令并发画一批图（2026-10-01 起，绘本出图提速用）。
//
//   paint-batch 清单.json [--concurrency 3] [--force]
//
// 清单 = JSON 数组，每项一张图：
//   {"out":"/abs/book-x/p01.jpg","prompt":"…","image":"/abs/book-x/refs.png","size":"1024x1024","quality":"high"}
// 只有 out / prompt 必填；image/size/quality/transparent 原样转给 bin/paint。
//
// 为什么要它：paint 服务同时能画 3 张（MAX_CONCURRENCY=3），而写书 agent 一次只提交 1 张，
// 《嘟嘟说再见》16 页串行画了 39 分钟。又不能把 paint 丢后台（回合结束后台被杀，
// 《一封一封的写》14 页只发 1 页）——所以并发藏在这一条命令里，命令本身前台阻塞到整批画完才返回。
//
// 行为：
//   - out 已存在就跳过（续跑友好），--force 才重画；
//   - 单张失败自动重试 2 次；429/额度/限流类错误退避更久（paint 与 codex 写书腿共用 ChatGPT 额度池）；
//   - 一张失败不拖垮整批：其余照画，最后逐张报 ok / FAIL，有失败退出码 1；
//   - 每批别超过 6 张左右：3 并发 × 两轮 ≈ 5 分钟，不碰 agent 单条命令 10 分钟超时。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAINT_BIN = process.env.PAINT_BIN || join(dirname(fileURLToPath(import.meta.url)), "paint");
const RETRIES = Number(process.env.PAINT_BATCH_RETRIES ?? 2);
const BACKOFF_MS = Number(process.env.PAINT_BATCH_BACKOFF_MS ?? 20_000);
const RATE_LIMIT_RE = /429|rate.?limit|quota|too many requests|usage limit/i;

const args = process.argv.slice(2);
const manifestPath = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--concurrency");
const ci = args.indexOf("--concurrency");
const concurrency = Math.max(1, Number(ci >= 0 ? args[ci + 1] : process.env.PAINT_BATCH_CONCURRENCY ?? 3));
const force = args.includes("--force");

if (!manifestPath) {
  console.error('usage: paint-batch 清单.json [--concurrency 3] [--force]\n清单: [{"out":"p01.jpg","prompt":"…","image":"refs.png"}, …]');
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
  const outs = items.map(it => it.out);
  const dup = outs.find((o, i) => outs.indexOf(o) !== i);
  if (dup) throw new Error(`out 重复：${dup}`);
} catch (e) {
  console.error(`清单读不了：${e.message}`);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function paintOnce(it) {
  const argv = [it.prompt, it.out];
  if (it.image) argv.push("--image", it.image);
  if (it.size) argv.push("--size", it.size);
  if (it.quality) argv.push("--quality", it.quality);
  if (it.transparent) argv.push("--transparent");
  return new Promise(resolve => {
    const p = spawn(PAINT_BIN, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("error", e => resolve({ ok: false, err: e.message }));
    p.on("close", code => {
      const msg = err.split("\n").filter(l => l && !/^\s*(queued|running)\.\.\.$|^job .* submitted/.test(l)).join(" ").trim();
      resolve({ ok: code === 0 && existsSync(it.out), out, err: msg || `exit ${code}` });
    });
  });
}

async function paintWithRetry(it) {
  const t0 = Date.now();
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_MS * attempt * (RATE_LIMIT_RE.test(last.err) ? 3 : 1);
      console.error(`  ↻ ${it.out} 第 ${attempt} 次重试（${Math.round(wait / 1000)}s 后）：${last.err.slice(0, 120)}`);
      await sleep(wait);
    }
    last = await paintOnce(it);
    if (last.ok) break;
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(last.ok ? `ok    ${it.out}  (${secs}s)` : `FAIL  ${it.out}  (${secs}s)  ${last.err.slice(0, 200)}`);
  return { out: it.out, ok: last.ok, err: last.err };
}

const t0 = Date.now();
const todo = items.filter(it => force || !existsSync(it.out));
for (const it of items) if (!todo.includes(it)) console.log(`skip  ${it.out}  (已存在，--force 才重画)`);
console.error(`paint-batch：${todo.length} 张，并发 ${concurrency}`);

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
  while (next < todo.length) results.push(await paintWithRetry(todo[next++]));
}));

const failed = results.filter(r => !r.ok);
console.log(`— ${results.length - failed.length}/${results.length} 张画好，跳过 ${items.length - todo.length}，用时 ${Math.round((Date.now() - t0) / 1000)}s` +
  (failed.length ? `；失败 ${failed.length} 张：${failed.map(f => f.out).join(" ")}（单独重跑本清单即可，已画好的会自动跳过）` : ""));
process.exit(failed.length ? 1 : 0);
