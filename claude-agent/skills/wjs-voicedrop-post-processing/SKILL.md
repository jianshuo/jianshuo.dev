---
name: wjs-voicedrop-post-processing
description: Use when a newly mined VoiceDrop article needs automated post-processing — invoked headless by the 5-minute poller (launchd com.jianshuo.voicedrop-postprocess) with the article stem as argument. 后处理动作 = 判断要不要配题图，需要就配一张 AI 题图并写成新版本。Triggers — "/wjs-voicedrop-post-processing <stem>".
---

# VoiceDrop 文章后处理

输入：文章 stem，由调用参数给出（`$ARGUMENTS`）。

运行环境：无人值守 `claude -p`，voicedrop MCP 已接好（读文章/写版本工具可用；发布、删除、社区、花钱类工具已被调用方禁用）。不要问任何问题，跑完即退。读写文章用 voicedrop MCP 工具，或 `wjs-voicedrop` skill 的等价 HTTP 接口（`GET/PUT /files/api/articles/<stem>`、照片 `PUT /files/api/upload/...`）——二者等价，MCP 优先。

## 流程

1. 取回该 stem 的文章全文与元数据（`articles[*].body`、`title`）。读不到就重试一次，再失败以非零退出（轮询器下一轮会重试）。

2. **判断要不要配题图**（核心，按 `wjs-voicedrop-choosing-cover` 的 Step 1 表；需细节用 Skill 工具加载它）：
   - 正文 `body` 首行已是 `[[photo:` → 已有题图，**不配**。输出 `skip` 行，退出 0。
   - 正文中已有与主题相关的实拍照片 `[[photo:...]]` → 真素材优先，**不配**。输出 `skip` 行（注明用哪张作首图），退出 0。
   - 极短碎碎念（<100 字）且不像单独发 → **暂不配**。输出 `skip` 行，退出 0。
   - 否则（无图、完整文章）→ **要配**，进入第 3 步。

3. **选风格 + 出图**（仅「要配」时）：
   - 读全文（**别只看标题**）按 `choosing-cover` 的 Step 2 风格表判断气质选风格；提炼 **6–10 汉字**标题（极简概念图可用 1–4 大字）。
   - 出图（硬规格 **2.45:1 / 1568×640**，调 Bash 时 timeout 设 600000ms）：
     ```bash
     /opt/claude-agent/bin/paint "<按选定风格拼的完整中文 prompt>" /tmp/cover_<stem>.png --size 1568x640 --quality high
     convert /tmp/cover_<stem>.png -quality 90 /tmp/cover_<stem>.jpg
     ```
     prompt 写清：浅色底 / 大留白 / 标题大字清晰可读 / 主视觉在下标题在上；**避免清单**：乱码文字、多余小字、真实品牌 logo、纯氛围壁纸、厚重蓝紫渐变、廉价营销海报感、卡通夸张（哀伤/悼念文尤其绝不卡通亮色）。

4. **上传照片**：从 stem 取录音会话时间戳（`VoiceDrop-<yyyy-MM-dd-HHmmss>-...` 的前段）作 `<sessionTs>`；`RAND`=3 位 base36；`KEY=photos/<sessionTs>/0-<RAND>.jpg`（`0`=首图 offset）。
   ```bash
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/jpeg" \
     --data-binary @/tmp/cover_<stem>.jpg "https://jianshuo.dev/files/api/upload/<KEY>"   # → {ok:true,name:...}
   ```

5. **写新版本**（绝不切 head）：重新读该文章最新版，把 `[[photo:<KEY>]]\n\n` 插到 `body` 首行（保留原 `title` 与原 `body`），用「写文章」工具存一个**新版本**（`PUT /files/api/articles/<stem>`，body `{"articles":[{"title":...,"body":...}]}` → `{ok:true,head:<新版本号>}`）。版本化，可 `PATCH /articles/<stem>/head` 回滚。

6. **输出一行**收尾：
   - 配了：`postprocess ok: <stem> — 配题图 <风格> <KEY> → v<新版本号>`
   - 跳过：`postprocess skip: <stem> — <不配原因>`
   - 失败：非零退出，stderr 写清失败在哪步（轮询器下一轮重试）。

## 铁律（同夜班编辑）

- 绝不发布、绝不删除、绝不碰文风库和社区。
- 改文章只能走「写新版本」，**不切 head**。
- 幂等：靠「首行是否已 `[[photo:]]`」判重，重复触发/轮询重叠都安全。
- 只动**自己 scope** 的数据（token 决定）。

## 依赖

- `wjs-voicedrop-choosing-cover`（配不配 + 风格表）
- `/opt/claude-agent/bin/paint`（出图）+ ImageMagick `convert`（PNG→JPEG）
- 认证 `$TOKEN`：见 `wjs-voicedrop`（`~/.config/voicedrop/credentials` 或 MCP 已接好的 session）
