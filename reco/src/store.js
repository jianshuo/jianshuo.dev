// report 走默认 INSERT OR IGNORE 路径:每用户去重、一次性、不可撤销(无 on=false 分支)。
const ACTIONS = new Set(["view", "finish", "like", "report"]);

// 读放大治理（2026-08-25 缓存 → 2026-09-02 计数表）：feed 每次请求要 ① 拉全部
// 可见帖（~400 行）② 拿每帖红心/浏览数。②原本是对 engagement 做全表聚合
// （~1.85 万行且随互动量无限长），reco 库因此反复读爆 5M/日 的 D1 免费额度。
// 2026-08-25 先加 60 秒进程内缓存压次数；2026-09-02 再把聚合本身换成增量维护的
// engagement_counts 表（行数 = 帖子数 × 动作数，与互动量脱钩），两层叠加后
// 一天的聚合读量从 350 万级降到 10 万级。写路径按 meta.changes 增减（INSERT OR
// IGNORE 被忽略时 changes=0，不重复计），漂移由每日 cron 的 rebuildCounts 全量
// 重算兜底——计数不是硬不变量，差一个红心无害，能自愈就够。
// likedBy（自己的红心态）保持每请求实时查询，不缓存。
const CACHE_TTL_MS = 60_000;
let feedCache = { at: 0, rows: null };
let countsCache = { at: 0, map: null };

// 测试钩子：清缓存，防止用例间串数据（生产代码不调用）。
export function __resetStoreCaches() {
  feedCache = { at: 0, rows: null };
  countsCache = { at: 0, map: null };
}

// D1 的 run() 回 meta.changes：INSERT OR IGNORE 被忽略 / DELETE 没删到都是 0。
// meta 缺失（老 fake、异常 shape）时按「改动了」处理——宁可多计一个红心，也不
// 少计；反正每日 rebuild 会把账抹平。
function changed(res) {
  const n = res?.meta?.changes;
  return n === undefined ? true : n > 0;
}

export async function recordEngagement(env, shareId, sub, action, on, now) {
  if (!ACTIONS.has(action)) return;
  if (action === "like" && on === false) {
    const res = await env.DB.prepare(
      "DELETE FROM engagement WHERE share_id=? AND user_sub=? AND action='like'",
    ).bind(shareId, sub).run();
    if (changed(res)) {
      await env.DB.prepare(
        "UPDATE engagement_counts SET c=MAX(c-1,0) WHERE share_id=? AND action='like'",
      ).bind(shareId).run();
    }
    countsCache = { at: 0, map: null };
    return;
  }
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO engagement (share_id, user_sub, action, created_at) VALUES (?,?,?,?)",
  ).bind(shareId, sub, action, now).run();
  if (changed(res)) {
    await env.DB.prepare(
      `INSERT INTO engagement_counts (share_id, action, c) VALUES (?,?,1)
       ON CONFLICT(share_id, action) DO UPDATE SET c=c+1`,
    ).bind(shareId, action).run();
  }
  countsCache = { at: 0, map: null };
}

// 计数表全量重算（每日 cron，见 index.js 的 scheduled）：engagement 才是真源，
// engagement_counts 是可随时重建的派生表。一次约 1.85 万行读/天，可忽略。
// 一个 batch = 一个事务，中途挂掉不会留下空计数表。
export async function rebuildCounts(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM engagement_counts"),
    env.DB.prepare(
      `INSERT INTO engagement_counts (share_id, action, c)
       SELECT share_id, action, COUNT(*) FROM engagement GROUP BY share_id, action`,
    ),
  ]);
  countsCache = { at: 0, map: null };
}

export async function countsFor(env, shareIds) {
  if (!countsCache.map || Date.now() - countsCache.at > CACHE_TTL_MS) {
    const map = {};
    const { results } = await env.DB.prepare(
      "SELECT share_id, action, c FROM engagement_counts WHERE c>0",
    ).all();
    for (const r of results || []) {
      (map[r.share_id] ||= {})[r.action] = r.c;
    }
    countsCache = { at: Date.now(), map };
  }
  const out = {};
  for (const id of shareIds) if (countsCache.map[id]) out[id] = countsCache.map[id];
  return out;
}

// 社区展示索引（community_posts,files API 双写维护）：feed 用的可见帖全量行,
// 时间倒序。500 封顶——超过再谈分页,现在整个社区才百余帖。
export async function feedRows(env) {
  // 2026-07-22 提示词退出社区 feed（Prompt Manager 设计定稿第 8 轮）：feed 只出
  // 文章帖；提示词的浏览/导入入口移到提示词管理页（/agent/prompt-market）。
  // 旧 kind='prompt' 行保留不删——回滚 = 去掉这个过滤条件。
  if (feedCache.rows && Date.now() - feedCache.at <= CACHE_TTL_MS) return feedCache.rows;
  const { results } = await env.DB.prepare(
    `SELECT share_id, owner, author, title, preview, cover_photo_key, has_photo,
            article_count, first_shared_at, updated_at, reply_to, kind
     FROM community_posts WHERE hidden=0 AND kind!='prompt'
     ORDER BY first_shared_at DESC LIMIT 500`,
  ).all();
  feedCache = { at: Date.now(), rows: results || [] };
  return feedCache.rows;
}

// 我赞过哪些（每请求实时，不缓存——自己的红心态不能陈旧）。
//
// 2026-09-02 从「把 feed 的 shareId 切成 90 个一批的 IN (?,?,…) 查 5 次」改成
// 「一次查出这个人赞过的全部，再在内存里取交集」：读的行数从「feed 有多少帖」
// （每次 ~93 行只为返回两三行）变成「这个人赞过几个」（多数用户个位数）。
// 顺带把 D1 的 100 个绑定参数上限这个雷整个拆掉——没有 IN 就没有分块。
//
// 前提是 migrations/0005 的 idx_engagement_user(user_sub, action, share_id)：
// engagement 主键是 (share_id, user_sub, action)，按 user_sub 查用不上，缺了这条
// 索引本查询会退化成全表扫 18,638 行，比改之前还糟。索引与本函数必须同进同退。
//
// 仍按 shareIds 过滤后再返回：/reco/rank 会把这个集合原样下发给 app（liked 字段），
// 混进本次请求没问的帖子就是改了接口语义。
export async function likedBy(env, sub, shareIds) {
  const wanted = new Set(shareIds);
  const set = new Set();
  const { results } = await env.DB.prepare(
    "SELECT share_id FROM engagement WHERE user_sub=? AND action='like'",
  ).bind(sub).all();
  for (const r of results || []) if (wanted.has(r.share_id)) set.add(r.share_id);
  return set;
}
