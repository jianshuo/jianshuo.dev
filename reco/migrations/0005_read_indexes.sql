-- 二轮压读放大（2026-09-02 晚，接 0004）。0004 干掉了最大的一条后重新按
-- rowsRead 排，剩下两条「读得多、返回得少」的：
--
-- ① likedBy：SELECT share_id FROM engagement WHERE user_sub=? AND action='like'
--    AND share_id IN (…90 个…) —— 每次读 ~93 行只返回两三行。engagement 的主键是
--    (share_id, user_sub, action)，按 user_sub 查根本用不上，只能靠 90 次 share_id
--    定位再过滤。补一条 (user_sub, action, share_id) 覆盖索引后，改成「一次查出这个
--    用户赞过的全部」（见 store.js），读的行数从「feed 帖子数」变成「这个人赞过几个」。
--    注意：这条索引是 store.js 那个新写法的前提——没有它，去掉 IN 会退化成全表扫
--    18,638 行，比原来还糟。索引与代码必须同进同退。
CREATE INDEX IF NOT EXISTS idx_engagement_user ON engagement(user_sub, action, share_id);

-- ② community/replies：WHERE reply_to=? AND hidden=0 ORDER BY first_shared_at ASC。
--    0004 里建的单列 idx_posts_reply(reply_to) 实测没被选中——EXPLAIN 显示
--    「SEARCH community_posts USING INDEX idx_posts_feed (hidden=?)」：查询带
--    ORDER BY first_shared_at，SQLite 宁可顺着 feed 索引扫 450 行也不愿排序。
--    改成把 WHERE 的等值列和 ORDER BY 列一起放进复合索引，seek 完天然有序、零排序。
DROP INDEX IF EXISTS idx_posts_reply;
CREATE INDEX IF NOT EXISTS idx_posts_reply ON community_posts(reply_to, hidden, first_shared_at);
