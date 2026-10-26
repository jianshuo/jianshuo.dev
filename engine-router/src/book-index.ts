// src/book-index.ts — 状态页给 run 配书名：书库里每本书的 book.json 有 jobId / slug / title。
// 写书 run 的幂等键是 `<jobId>:main|contN`，修书是 `revise:<slug>#<ts>`（claude-agent book-runner.ts），
// 按键反查就能把老任务也标上书名。只读、60 秒缓存，读不到就当没有。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BookRef = { title: string; slug: string };
type Index = { byJob: Map<string, BookRef>; bySlug: Map<string, BookRef>; at: number };

const ROOT = process.env.BOOKS_WORKSPACE ?? "/opt/claude-agent/workspace";
const TTL_MS = 60_000;
let cache: Index | null = null;

function load(root: string): Index {
  const idx: Index = { byJob: new Map(), bySlug: new Map(), at: Date.now() };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => d.startsWith("book-") || d.startsWith("bk-"));
  } catch {
    return idx;
  }
  for (const d of dirs) {
    try {
      const b = JSON.parse(readFileSync(join(root, d, "book.json"), "utf8"));
      const ref = { title: String(b.title ?? b.slug ?? d), slug: String(b.slug ?? d.replace(/^(book|bk)-/, "")) };
      if (b.jobId) idx.byJob.set(String(b.jobId), ref);
      idx.bySlug.set(ref.slug, ref);
    } catch {
      /* 没有 book.json 的目录 */
    }
  }
  return idx;
}

/** 按 run 的幂等键找书：{ book, what }，what 是「写书」「续写 2」「修书」这样的一句。 */
export function bookForKey(key: string | undefined, root = ROOT, now = Date.now()): { book?: BookRef; what?: string } {
  if (!key) return {};
  if (!cache || now - cache.at > TTL_MS) cache = load(root);
  let m = /^([0-9a-f-]{36}):(main|cont(\d+))$/.exec(key);
  if (m) return { book: cache.byJob.get(m[1]), what: m[3] ? `续写 ${m[3]}` : "写书" };
  m = /^revise:([a-z0-9-]+)#/.exec(key);
  if (m) return { book: cache.bySlug.get(m[1]) ?? { title: m[1], slug: m[1] }, what: "修书" };
  return {};
}

export function resetBookIndex(): void {
  cache = null;
}
