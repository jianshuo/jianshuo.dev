// 内存版 D1 = 真 SQLite（better-sqlite3）跑真迁移，与 agent/test/fakes.js 同一套路。
// 2026-09-02 从手写 SQL 解释器换过来：手写 fake 比真库宽松（它忽略 feed 的
// kind!='prompt' 过滤、也没有 engagement_counts 这张表），而这次要改的恰恰是
// 「计数与 engagement 必须对得上」这条不变量——用假 SQL 测等于没测。
//
// 签名保持 fakeD1(seedEngagement, posts) 不变：seed 行灌进 engagement，
// posts 灌进 community_posts，随后重算一次 engagement_counts。
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let _sqlCache = null;
export function recoSql() {
  if (_sqlCache) return _sqlCache;
  const f = (n) => readFileSync(fileURLToPath(new URL("../migrations/" + n, import.meta.url)), "utf8");
  _sqlCache = [
    f("0001_engagement.sql"),
    f("0002_community_posts.sql"),
    f("0003_community_posts_kind.sql"),
    f("0004_engagement_counts.sql"),
    f("0005_read_indexes.sql"),
  ].join("\n");
  return _sqlCache;
}

const POST_COLS = [
  "share_id", "owner", "article_key", "author", "title", "preview", "cover_photo_key",
  "has_photo", "article_count", "first_shared_at", "updated_at", "reply_to", "hidden", "kind",
];

export function fakeD1(seed = [], posts = []) {
  const db = new Database(":memory:");
  db.exec(recoSql());

  const ins = db.prepare(
    "INSERT OR IGNORE INTO engagement (share_id, user_sub, action, created_at) VALUES (?,?,?,?)",
  );
  for (const r of seed) ins.run(r.share_id, r.user_sub, r.action, r.created_at ?? 0);

  const insPost = db.prepare(
    `INSERT OR REPLACE INTO community_posts (${POST_COLS.join(",")})
     VALUES (${POST_COLS.map(() => "?").join(",")})`,
  );
  for (const p of posts) {
    insPost.run(...POST_COLS.map((c) => {
      const v = p[c];
      if (v === undefined || v === null) {
        if (c === "has_photo" || c === "hidden") return 0;
        if (c === "article_count") return 1;
        if (c === "kind") return "article";
        return null;
      }
      return typeof v === "boolean" ? (v ? 1 : 0) : v;
    }));
  }

  db.exec(`INSERT INTO engagement_counts (share_id, action, c)
             SELECT share_id, action, COUNT(*) FROM engagement GROUP BY share_id, action
             ON CONFLICT(share_id, action) DO UPDATE SET c=excluded.c`);

  // 执行过的 SQL 流水：给「这条路径到底打了几次库」这类断言用（读放大回归）。
  const queries = [];

  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    let args = [];
    const log = () => queries.push(" ".concat(sql).split(/\s+/).join(" ").trim());
    const api = {
      bind(...a) {
        // 真 D1(SQLite) 单条 SQL 绑定参数上限 100。社区过百帖时 IN (?,?,…) 一次
        // 绑 100+ 参数整条炸掉的事故（2026-07-13）必须能在单测里复现。
        if (a.length > 100) throw new Error(`too many SQL variables (${a.length} > 100)`);
        args = a; return api;
      },
      async run() {
        log();
        const r = stmt.run(...args);
        return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
      },
      async first(col) {
        log();
        const row = stmt.get(...args);
        if (col != null) return row ? row[col] : null;
        return row ?? null;
      },
      async all() { log(); return { results: stmt.all(...args) }; },
    };
    return api;
  };

  return {
    DB: {
      prepare,
      async batch(statements) {
        const out = [];
        for (const s of statements) out.push(await s.run());
        return out;
      },
      _db: db,
      _queries: queries,
    },
  };
}
