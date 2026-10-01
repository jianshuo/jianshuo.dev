// bin/paint-batch 单测：用假 paint（PAINT_BIN）模拟出图，验并发上限、跳过已存在、失败重试、退出码。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BATCH = new URL("../bin/paint-batch", import.meta.url).pathname;

// 假 paint：记录并发峰值；prompt 含 FAILN 时前 N 次失败（按 out 计数），含 RATE 时报 429。
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "paint-batch-"));
  const fake = join(dir, "fake-paint");
  writeFileSync(fake, `#!/usr/bin/env bash
set -u
D=${dir}
touch "$D/run.$$"
echo "$*" >> "$D/calls"
sleep 0.3
n=$(ls "$D"/run.* | wc -l | tr -d ' '); peak=$(cat "$D/peak" 2>/dev/null || echo 0); [ $n -gt $peak ] && echo $n > "$D/peak"
sleep 0.2
tries=$(grep -c -- "$2" "$D/calls")
rm -f "$D/run.$$"
if [[ "$1" =~ FAIL([0-9]) ]] && [ $tries -le \${BASH_REMATCH[1]} ]; then echo "paint job failed: boom" >&2; exit 1; fi
if [[ "$1" == *RATE* ]] && [ $tries -le 1 ]; then echo "paint job failed: 429 Too Many Requests" >&2; exit 1; fi
echo img > "$2"; echo "saved: $2"
`);
  chmodSync(fake, 0o755);
  const run = (items, ...flags) => {
    const m = join(dir, "m.json");
    writeFileSync(m, JSON.stringify(items));
    return spawnSync(BATCH, [m, ...flags], {
      encoding: "utf8",
      env: { ...process.env, PAINT_BIN: fake, PAINT_BATCH_BACKOFF_MS: "10" },
    });
  };
  return { dir, run, calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n") : []) };
}

test("6 张图按 3 并发画完，全部落盘，退出码 0", () => {
  const { dir, run } = setup();
  const items = Array.from({ length: 6 }, (_, i) => ({ out: join(dir, `p0${i + 1}.jpg`), prompt: `page ${i + 1}`, image: join(dir, "refs.png") }));
  const r = run(items);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const it of items) assert.ok(existsSync(it.out), it.out);
  assert.equal(readFileSync(join(dir, "peak"), "utf8").trim(), "3");
  assert.match(r.stdout, /6\/6 张画好/);
});

test("参数原样转给 paint（--image/--size/--quality）", () => {
  const { dir, run, calls } = setup();
  run([{ out: join(dir, "c.jpg"), prompt: "cover", image: "refs.png", size: "1024x1536", quality: "high" }]);
  assert.match(calls()[0], /--image refs\.png --size 1024x1536 --quality high/);
});

test("已存在的图跳过，--force 才重画", () => {
  const { dir, run, calls } = setup();
  const out = join(dir, "p01.jpg");
  writeFileSync(out, "old");
  const r = run([{ out, prompt: "x" }]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skip/);
  assert.equal(calls().length, 0);
  run([{ out, prompt: "x" }], "--force");
  assert.equal(calls().length, 1);
});

test("偶发失败自动重试后成功；429 也能扛过去", () => {
  const { dir, run } = setup();
  const r = run([{ out: join(dir, "a.jpg"), prompt: "FAIL1 a" }, { out: join(dir, "b.jpg"), prompt: "RATE b" }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /重试/);
});

test("一张一直失败不拖垮整批：其余照画，报 FAIL，退出码 1", () => {
  const { dir, run } = setup();
  const r = run([{ out: join(dir, "bad.jpg"), prompt: "FAIL9 bad" }, { out: join(dir, "good.jpg"), prompt: "good" }]);
  assert.equal(r.status, 1);
  assert.ok(existsSync(join(dir, "good.jpg")));
  assert.match(r.stdout, /FAIL\s+\S*bad\.jpg/);
  assert.match(r.stdout, /失败 1 张/);
});

test("清单坏了直接退出码 2", () => {
  const { dir, run } = setup();
  assert.equal(run([{ out: join(dir, "x.jpg") }]).status, 2);
  assert.equal(run([{ out: "same.jpg", prompt: "a" }, { out: "same.jpg", prompt: "b" }]).status, 2);
});
