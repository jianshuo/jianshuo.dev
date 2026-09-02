-- 读放大根治（2026-09-02，CF 告警：账号当日 D1 rows_read 已用掉 5M 免费额度的 75%）。
-- 2026-08-25 的 60 秒进程内缓存只是把全表聚合的「次数」压下来，没改「每次多贵」：
--   SELECT share_id, action, COUNT(*) FROM engagement GROUP BY share_id, action
-- 两天里跑 389 次、读 718 万行（每次全表 ~1.85 万行），占 reco 库读量的 96%，
-- 且成本随互动量线性长——迟早再爆。改成增量维护的计数表：行数只随「帖子数 ×
-- 动作数」长（~1.5K），与互动量脱钩，一次全量读比原来便宜一个数量级以上。
-- 漂移兜底见 store.js rebuildCounts（每日 cron 全量重算，一次 1.85 万行/天可忽略）。
CREATE TABLE IF NOT EXISTS engagement_counts (
  share_id TEXT NOT NULL,
  action   TEXT NOT NULL,
  c        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, action)
);

-- 存量回填：本迁移即是第一次 rebuild。
INSERT INTO engagement_counts (share_id, action, c)
  SELECT share_id, action, COUNT(*) FROM engagement GROUP BY share_id, action
  ON CONFLICT(share_id, action) DO UPDATE SET c=excluded.c;

-- 回应列表（Pages functions/files/api/[[path]].js 的 community/replies 快路径）
-- 此前无索引：两天 123 次查询扫 53,804 行只为返回 2 行。
CREATE INDEX IF NOT EXISTS idx_posts_reply ON community_posts(reply_to);
