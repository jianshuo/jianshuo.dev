#!/usr/bin/env node
// 一次性迁移（2026-08-23，在 VPS 上以 claude-agent 用户跑）：
//   1. 本地 bookmeta/<slug>.json（对话线）→ R2 books/<slug>/_src/bookmeta.json
//   2. owner（= bookmeta.scope）写进线上 _src/book.json 和工作目录 book.json
//   3. 迁移成功后删本地文件（真源从此在 R2；_unmatched-* 保留）
// 之后产权读 book.json 的 owner，对话线读 _src/bookmeta.json，VPS 重装不再丢。
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API = "https://jianshuo.dev/files/api";
const TOKEN = JSON.parse(readFileSync(join(homedir(), ".config/voicedrop/credentials"), "utf8")).token;
const DIR = "/opt/claude-agent/bookmeta";
const WS = "/opt/claude-agent/workspace";

async function put(key, body) {
  const r = await fetch(`${API}/upload/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
}

let migrated = 0, ownered = 0, wspatched = 0, failed = 0;
for (const f of readdirSync(DIR)) {
  if (!f.endsWith(".json") || f.startsWith("_unmatched")) continue;
  const slug = f.slice(0, -5);
  try {
    const meta = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    await put(`books/${slug}/_src/bookmeta.json`, JSON.stringify(meta, null, 2) + "\n");
    migrated++;
    // owner → 线上 _src/book.json（老书没有 _src 就跳过，产权由 bookmeta.json 的 scope 兜着）
    try {
      const r = await fetch(`https://jianshuo.dev/voicedrop/books/${slug}/_src/book.json?_=${Date.now()}`);
      if (r.ok) {
        const book = await r.json();
        if (!book.owner && meta.scope) {
          book.owner = meta.scope;
          await put(`books/${slug}/_src/book.json`, JSON.stringify(book, null, 2) + "\n");
          ownered++;
        }
      }
    } catch (e) { console.error(slug, "book.json patch failed:", e.message); }
    // owner → 工作目录（防未来 republish 用无 owner 的旧稿冲掉线上的）
    const wsf = join(WS, `book-${slug}`, "book.json");
    if (existsSync(wsf)) {
      try {
        const b = JSON.parse(readFileSync(wsf, "utf8"));
        if (!b.owner && meta.scope) {
          b.owner = meta.scope;
          writeFileSync(wsf, JSON.stringify(b, null, 2) + "\n");
          wspatched++;
        }
      } catch {}
    }
    unlinkSync(join(DIR, f));
    console.log("ok", slug);
  } catch (e) {
    failed++;
    console.error("FAIL", slug, e.message);
  }
}
console.log(`done: 对话线迁移 ${migrated}，owner 写入线上 book.json ${ownered}，工作目录补丁 ${wspatched}，失败 ${failed}`);
