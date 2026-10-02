# paint 出图 · 使用说明书

> 单一真源（2026-10-02）。agent 用的精简版在 `claude-agent/skills/paint/SKILL.md`，两边冲突以本文为准。

## 一个接口

出图只有一个接口：**`POST https://paint.jianshuo.dev/api/jobs`**（VPS 本机 `http://127.0.0.1:8788`），
查结果 `GET /api/jobs/:id`（或 SSE `/api/jobs/:id/events`），完成后可选回调。

引擎选择（Codex / Seedream）、Codex 模型候选、瞬时限流重试、额度冷却、自动降级、尺寸规整、
group 画风粘性、整单期限——**全在服务端**（`src/worker.ts`）。调用方只需要知道两件事：成功（拿 `result_url`），
或失败（`error.code` + `error.message`）。不要在客户端再写一层重试/降级/尺寸吸附。

现有调用方（都只是这个接口的薄壳）：

| 调用方 | 位置 | 方式 |
|---|---|---|
| `bin/paint` | `claude-agent/bin/paint` | 单张 CLI，提交+轮询+下载 |
| `bin/paint-batch` | `claude-agent/bin/paint-batch.mjs` | 一批，与 `bin/paint` 共用 `bin/paint-client.mjs` |
| VoiceDrop edit_photo / new_photo / 题图调优页 | `agent/src/paint-client.js` 的 `paintSubmit()` | 提交 + 回调 |
| 网页 | `https://paint.jianshuo.dev/`（Caddy 密码） | 手动 |

## 请求

`POST /api/jobs`，头 `Authorization: Bearer <API_TOKEN>`，JSON body：

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✓ | ≤4000 字 |
| `image_url` / `image_b64` | | 给了就是**改图**（edit）。url 须 http(s) 公网；b64 ≤25MB |
| `size` | | 缺省 `2K`。任意合理 `宽x高`，服务端规整：两边吸附到 16 倍数、总像素 ≥655,360 且 ≤8,294,400、单边 ≤3840、长短边比 ≤3:1（等比调整）；或关键字 `auto` / `2K` / `4K`。实际尺寸看 202 回包与结果里的 `size`。乱填（`huge`）→ 400 |
| `format` | | `png`（缺省）/ `jpeg` / `webp` |
| `compression` | | 0–100，jpeg/webp 用；书和 VoiceDrop 一律 80 |
| `quality` | | `low` / `medium` / `high`（缺省）/ `auto`，只对 Codex 有效 |
| `transparent` | | `true` = 透明底 PNG。**只有 Codex 能做**；不能和改图同用 |
| `engine` | | `auto`（缺省）/ `codex` / `seedream`，见下 |
| `group` | | 画风一致性分组，如书的 slug（`[A-Za-z0-9_.:-]{1,80}`），见下 |
| `callback_url` / `callback_token` / `callback_meta` | | 完成后 POST 回调，见下 |
| `xmp_prompt` / `xmp_meta` | | 图片内嵌 XMP 溯源：`xmp_prompt:false` 不写 prompt；`xmp_meta` 自定义键值（≤4KB） |

回 `202 {job_id, status:"queued", poll_url, events_url, size, deadline_at}`。

### engine：谁来画

| engine | 行为 |
|---|---|
| `auto` | Codex（ChatGPT Plus 订阅的 gpt-image-2）优先；**只在下列情况**自动改用火山方舟 Seedream |
| `codex` | 只用 Codex，失败就失败，绝不降级 |
| `seedream` | 直接走 Seedream（`doubao-seedream-5-0-pro` → `4-0` 依次试）。服务端没配 `ARK_API_KEY` → 提交即 400；`transparent` → 400 |

`auto` 单改走 Seedream 的条件（`fallback_reason` 会写明是哪条）：

1. **Codex 真额度打满**：429 `usage_limit_reached` 或响应带 `resets_at`/`resets_in_seconds`。同时设冷却到额度重置时刻（没给就 30 分钟），冷却期内所有 `auto` 单不再打 Codex，直走 Seedream。
2. **Codex 候选模型全被账号拒**（400 not supported / 404 does not exist）。冷却 30 分钟。
3. **瞬时限流**（泛泛的 HTTP 429 / too many requests）：先原地等 15s、30s 各重试一次；仍不行**只这一单**降级，**不设冷却**，下一单照常先试 Codex。
4. **group 粘性**：这组已有图是 Seedream 出的（见下）。

**不会**降级的：参数错（`invalid_argument`）、安全拦截（`missing_image_result`，自动重试 1 次）、401 登录失效、超时、透明图（Seedream 没有透明底）、`SEEDREAM_FALLBACK=off`。

冷却在进程内存里，服务重启即清；group 粘性落盘，重启不丢。

### group：整本书一个画风

Codex（gpt-image-2）和 Seedream 画风明显不同，一本书混着用会很难看。规则：

- 同一本书的每张图带同一个 `group`（书的 slug）。
- 组里**任何一张**由 Seedream 出图成功（降级或显式），该组从此**粘在 Seedream**：之后这组的 `auto` 单直接走 Seedream，不再回头试 Codex（`fallback_reason: group "xxx" sticky on seedream since …`）。落盘 `DATA_DIR/groups.json`，保留 7 天（每次命中顺延）。
- 显式 `engine:"codex"` 不受粘性影响（用来重画少数派）。
- 粘性只往 Seedream 粘；粘之前已经由 Codex 画好的页还是 Codex 的——所以**全书画完要对一次账**：`paint --engines 所有页.jpg`（或 paint-batch 结尾的引擎统计），两种引擎混用时，把少数派用多数派的 `--engine` 重画（平票选 seedream）。

## 结果

`GET /api/jobs/:id` →

```json
{ "job_id": "…", "status": "queued|running|done|failed", "percent": 100,
  "result_url": "https://paint.jianshuo.dev/results/<id>.jpg", "format": "jpeg", "size": "1024x1536", "bytes": 512345,
  "engine": "codex|seedream", "model": "gpt-5.4-mini | doubao-seedream-5-0-pro-260628",
  "fallback_reason": null, "engine_pref": "auto", "group": "book-xxx",
  "error": null, "attempts": 1, "created_at": "…", "done_at": "…", "deadline_at": "…" }
```

- `engine`：实际出图（或失败时栽在）的引擎。`model`：codex 时是外层 Codex 模型（真正出图的是它调用的 gpt-image-2），seedream 时是方舟模型 id。
- `result_url` 公开可访问（路径不可猜），保留 30 天。图里嵌 XMP：`paint:Model` = `gpt-image-2` 或方舟模型 id（`bin/paint --engines` 就是读它）。
- 回调：`POST callback_url`，头 `X-Paint-Signature: sha256=<HMAC(body, CALLBACK_SIGNING_SECRET)>`、可选 `Authorization: Bearer <callback_token>`；body
  `{job_id, status, result_url, format, size, bytes, error, callback_meta, engine, model, fallback_reason}`。失败最多重送 3 次。

## 错误码与对策

| `error.code` | 含义 | 该怎么办 |
|---|---|---|
| 400 `prompt required` / `bad size` / `bad engine` / `bad group` / `seedream cannot do transparent` / `seedream not configured…` | 提交被拒（同步） | 改参数；不要重试同一请求 |
| `invalid_argument` | 参数组合非法（如 transparent + 改图） | 改参数 |
| `input_download_failed` | `image_url` 拉不下来 | 检查原图 URL |
| `missing_image_result` | OpenAI 安全过滤扣了图（已自动重试 1 次） | 改写 prompt（去掉敏感/真人/品牌），再提交 |
| `http_error` | Codex 侧错误（详见 message：401 登录失效 / 429 额度 / 400 …） | 401 要人工修 Codex 登录；额度类 `auto` 会自己降级，显式 `codex` 只能等或改 `auto` |
| `seedream_error` | 方舟两个模型都失败（含内容审核 400） | 看 message；审核类改 prompt |
| `seedream_unavailable` | 需要 Seedream 但不可用（透明图 / 没配 key） | 透明图只能等 Codex 额度 |
| `postprocess_error` | Seedream 已出图，但本机 ImageMagick 裁缩/转格式失败（不会再换模型二次付费） | 服务端问题，报给维护者（`convert` 是否装了） |
| `deadline_exceeded` | 超过整单期限（从提交算 8 分钟，含排队） | 一般是排队太长或 Codex 卡住；直接重提交 |
| `no_output` / `parse_error` / `unknown` | 引擎异常 | 重试一次，仍失败报维护者 |
| 客户端 `rejected` / `client_timeout` / `download_failed` | `bin/paint` 侧：提交 HTTP 非 202 / 等过期限无终态 / 结果下载失败 | 看 message |

## 时间

- **整单期限 8 分钟**（`JOB_DEADLINE_MS`），**从提交时刻算**，含排队、Codex 各次尝试、Seedream 降级与下载。每条腿的超时都取「自身上限」与「剩余时间」的较小者；降级时剩余不足 45s 就不再花钱调方舟，直接 `deadline_exceeded`。
- 典型耗时：Codex 1–3 分钟；Seedream 约 30–60 秒；降级 = Codex 失败那一下 + Seedream，大约多 1 分钟；冷却/粘性期间直走 Seedream 反而更快。
- 服务端同时画 3 张（`MAX_CONCURRENCY`），多的排队，排队也计入 8 分钟。
- `bin/paint` 等到 `deadline_at + 60s`（约 9 分钟）必返回；agent 的 Bash timeout 给 600000ms（10 分钟）够用。

## 费用

- **Codex**：吃 ChatGPT Plus 订阅额度，与写书的 codex 腿同一个池。高质量竖图约每周额度的 5%/张，5 小时窗口只够十几张——批量出图先想清楚。
- **Seedream**：火山方舟按张计费（真金白银，账单在火山引擎控制台）。降级不是免费的；也正因如此，后处理失败不会再换模型重画一次。

## 命令行（claude-agent VPS 上）

```bash
# 单张（前台，Bash timeout 600000）
/opt/claude-agent/bin/paint "提示词" out.jpg                           # 文生图
/opt/claude-agent/bin/paint "提示词" out.jpg --image ref.png            # 改图
/opt/claude-agent/bin/paint "提示词" cover.jpg --size 1024x1536 --group book-slug
/opt/claude-agent/bin/paint "提示词" p03.jpg --image refs.png --engine seedream --group book-slug   # 重画少数派
#   其它：--transparent --quality low|medium|high --format png|jpeg|webp --compression 0-100 --engine auto|codex|seedream
#   成功 stdout：saved: … / result_url: … / engine: codex (gpt-5.4-mini) / job: <id>
#   失败 stderr：paint job failed: <code>: <message> (job <id>…)，退出码 1

# 一批（≤6 张一批，一条前台命令，整批 ~9 分钟内必返回）
/opt/claude-agent/bin/paint-batch 清单.json --group book-slug [--engine …] [--force]
#   清单：[{"out":"/abs/p01.jpg","prompt":"…","image":"/abs/refs.png","size":"1024x1024","quality":"high"}, …]
#   逐张 ok/FAIL <code>: <message>；已存在跳过；结尾报引擎分布，混用时点名少数派

# 对账：一组图各是哪个引擎画的
/opt/claude-agent/bin/paint --engines book-slug/p*.jpg
```

格式缺省按输出扩展名（.jpg→jpeg、.webp→webp、其余 png）；jpeg/webp 缺省压缩 80。环境变量 `PAINT_API`（缺省 `http://127.0.0.1:8788`）、`PAINT_API_TOKEN`（必需）。

## 运维

- 部署：`paint/deploy.sh`（先确认 `data/jobs` 里没有 queued/running）。依赖 ImageMagick `convert`（`deploy/provision.sh` 会装）。
- 关键 env 见 `.env.example`：`ARK_API_KEY`、`SEEDREAM_MODELS`、`SEEDREAM_FALLBACK`、`CONVERT_BIN`、`JOB_DEADLINE_MS`、`RATE_LIMIT_RETRY_MS`、`QUOTA_COOLDOWN_MS`、`MODEL_REJECTED_COOLDOWN_MS`、`GROUP_TTL_MS`。
- 看日志：`https://paint.jianshuo.dev/log`（seedream 单标橙色，悬停看降级原因；带 group 的显示组名），`journalctl -u paint`。
