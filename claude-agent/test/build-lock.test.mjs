// build.mjs 的工作目录锁：并行档里多个评审子代理同时 `build.mjs done`，一章都不能丢。
// 起一个本地假 files API 收 PUT，8 个 done 同时发，最后 book.json 和线上目录页都得是 8/8。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUILD = new URL("../skills/wjs-voicedrop-writing-book/build.mjs", import.meta.url).pathname;
const N = 8;

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BUILD, ...args], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("并发 done 不丢章：book.json 8/8 done，最后上传的目录页也点亮全部 8 章，锁用完即放", async () => {
  const store = new Map();
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") { store.set(req.url, Buffer.concat(chunks).toString("utf8")); res.end("{}"); }
      else { res.statusCode = 404; res.end(); }   // mergeLiveFields 读线上 book.json：当作首发
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const env = { BOOK_FILES_API: base + "/files/api", BOOK_SITE: base, BOOK_TOKEN: "t" };

  const dir = mkdtempSync(join(tmpdir(), "book-lock-"));
  mkdirSync(join(dir, "chapters"));
  const chapters = Array.from({ length: N }, (_, i) => ({ no: i + 1, title: `第 ${i + 1} 章`, brief: "b", status: "planned" }));
  writeFileSync(join(dir, "book.json"), JSON.stringify({ slug: "lock-test", title: "锁", type: "explainary", chapters }, null, 2));
  for (let i = 1; i <= N; i++)
    writeFileSync(join(dir, "chapters", String(i).padStart(2, "0") + ".html"), `<p>${"第 " + i + " 章的正文，够长才过发布前的空章闸。".repeat(12)}</p>`);

  try {
    const rs = await Promise.all(chapters.map((c) => run(["done", dir, String(c.no)], env)));
    for (const r of rs) assert.equal(r.code, 0, r.out);
    const book = JSON.parse(readFileSync(join(dir, "book.json"), "utf8"));
    assert.equal(book.chapters.filter((c) => c.status === "done").length, N);
    assert.ok(book.createdAt, "首次发布目录页时盖了 createdAt");
    const src = JSON.parse(store.get("/files/api/upload/books/lock-test/_src/book.json"));
    assert.equal(src.chapters.filter((c) => c.status === "done").length, N, "线上 _src/book.json 也是 8/8");
    const index = store.get("/files/api/upload/books/lock-test/index.html");
    for (let i = 1; i <= N; i++) assert.ok(index.includes(`href="${String(i).padStart(2, "0")}.html"`), `目录页点亮第 ${i} 章`);
    assert.equal(existsSync(join(dir, ".build.lock")), false);
  } finally {
    srv.close();
  }
});
