// report 走默认 INSERT OR IGNORE 路径:每用户去重、一次性、不可撤销(无 on=false 分支)。
const ACTIONS = new Set(["view", "finish", "like", "report"]);

// 读放大治理（2026-08-25，D1 免费额度 9/1 起强制执行）：feed 每次请求原本要
// ① 拉全部可见帖（~300 行）② 对 engagement 做聚合（~8K 行且随互动增长）——
// reco 库因此 30 天里 4 天读超 5M/日（峰 7.4M）。两块改 60 秒进程内缓存：
// countsFor 一次全量聚合进 map、按需切子集；本 isolate 的互动写入就地失效；
// 其他 isolate / 其他 worker 的双写最多陈旧 60 秒——feed 计数与新帖出现的
// 场景无感。likedBy（自己的红心态）保持每请求实时查询，不缓存。
const CACHE_TTL_MS = 60_000;
let feedCache = { at: 0, rows: null };
let countsCache = { at: 0, map: null };

// 测试钩子：清缓存，防止用例间串数据（生产代码不调用）。
export function __resetStoreCaches() {
  feedCache = { at: 0, rows: null };
  countsCache = { at: 0, map: null };
}

export async function recordEngagement(env, shareId, sub, action, on, now) {
  if (!ACTIONS.has(action)) return;
  if (action === "like" && on === false) {
    await env.DB.prepare(
      "DELETE FROM engagement WHERE share_id=? AND user_sub=? AND action='like'",
    ).bind(shareId, sub).run();
    countsCache = { at: 0, map: null };
    return;
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO engagement (share_id, user_sub, action, created_at) VALUES (?,?,?,?)",
  ).bind(shareId, sub, action, now).run();
  countsCache = { at: 0, map: null };
}

// D1(SQLite) 单条 SQL 绑定参数上限 100：社区一过 100 帖，IN (?,?,…) 一次绑
// 100+ 个参数直接 500，rank 整个挂掉（app 静默回退 → 推荐退化成时间序、卡片
// 赞数全 0）。按 90 一批分块查再合并（留出 likedBy 里 sub 那 1 个参数的余量）。
const IN_CHUNK = 90;

function chunks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

export async function countsFor(env, shareIds) {
  if (!countsCache.map || Date.now() - countsCache.at > CACHE_TTL_MS) {
    const map = {};
    const { results } = await env.DB.prepare(
      "SELECT share_id, action, COUNT(*) AS c FROM engagement GROUP BY share_id, action",
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

export async function likedBy(env, sub, shareIds) {
  const set = new Set();
  for (const ids of chunks(shareIds)) {
    const ph = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT share_id FROM engagement WHERE user_sub=? AND action='like' AND share_id IN (${ph})`,
    ).bind(sub, ...ids).all();
    for (const r of results || []) set.add(r.share_id);
  }
  return set;
}
