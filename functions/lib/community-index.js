// 社区展示索引（D1 community_posts 表）的唯一写入层（2026-08-27 统一收口）。
// 此前三处各写各的 SQL：files API 的文章帖 indexUpsert、agent worker 的提示词帖
// indexUpsertPrompt、reco worker 的书架读时混入（旁路，已废除改为写时登记）。
// 现在文章（article）/提示词（prompt）/书（book）三种 kind 全走这里——加列、
// 改冲突策略只动这一个文件。
//
// 约定：写失败一律吞掉并 console.log——展示索引绝不打断主路径；坏了/漂了靠
// POST community/reindex 全量对账重建（files API）。
//
// row 字段（camelCase，与 files API 的 post 语义一致）：
//   shareId(必填) owner author title preview articleKey coverPhotoKey hasPhoto
//   articleCount firstSharedAt updatedAt replyTo hidden kind

export async function upsertCommunityPost(db, row) {
  if (!db) return;
  try {
    await db.prepare(
      `INSERT INTO community_posts (share_id, owner, article_key, author, title, preview,
         cover_photo_key, has_photo, article_count, first_shared_at, updated_at, reply_to, hidden, kind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(share_id) DO UPDATE SET
         owner=excluded.owner, article_key=excluded.article_key, author=excluded.author,
         title=excluded.title, preview=excluded.preview, cover_photo_key=excluded.cover_photo_key,
         has_photo=excluded.has_photo, article_count=excluded.article_count,
         first_shared_at=excluded.first_shared_at, updated_at=excluded.updated_at,
         reply_to=excluded.reply_to, hidden=excluded.hidden, kind=excluded.kind`,
    ).bind(row.shareId, row.owner || '', row.articleKey || null, row.author || '', row.title || '',
           row.preview || null, row.coverPhotoKey || null, row.hasPhoto ? 1 : 0,
           row.articleCount || 1, row.firstSharedAt || null,
           row.updatedAt || row.firstSharedAt || null, row.replyTo || null,
           row.hidden ? 1 : 0, row.kind || 'article').run();
  } catch (e) { console.log('[community-index] upsert failed', String(e?.message || e)); }
}

export async function deleteCommunityPost(db, shareId) {
  if (!db) return;
  try { await db.prepare('DELETE FROM community_posts WHERE share_id=?').bind(shareId).run(); }
  catch (e) { console.log('[community-index] delete failed', String(e?.message || e)); }
}

export async function setCommunityPostHidden(db, shareId, hidden) {
  if (!db) return;
  try { await db.prepare('UPDATE community_posts SET hidden=? WHERE share_id=?').bind(hidden ? 1 : 0, shareId).run(); }
  catch (e) { console.log('[community-index] hide failed', String(e?.message || e)); }
}
