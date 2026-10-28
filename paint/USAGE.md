# paint 出图 · 使用说明书

> 单一真源（2026-10-02 起，2026-10-28 改为批次调度）。agent 用的精简版在 `claude-agent/skills/paint/SKILL.md`，两边冲突以本文为准。

## 两个接口，一套调度

- **一批**：`POST https://paint.jianshuo.dev/api/batches`（VPS 本机 `http://127.0.0.1:8788`），查进度 `GET /api/batches/:id`，取消 `POST /api/batches/:id/cancel`。一本书的所有图一次交。
- **单张**：`POST /api/jobs`，查结果 `GET /api/jobs/:id`（或 SSE `/api/jobs/:id/events`），完成后可选回调。单张就是 1 张的批次，插队优先。

**调度全在 engine-router**（`engine-router/src/batches.ts`，见 `engine-router/README.md`「出图批次」）：

- 一批**开批时定一个引擎**（Codex gpt-image-2 或火山方舟 Seedream），按整批张数估额度；**中途不换引擎**。
- 带同一个 `group`（书的 slug）的批次**始终用同一个引擎**——第一批定了谁，补画、重画都还是谁。所以整本书天然一个画风，不用对账。
- 每个出图账号同时画 4 张（`concurrency.image_per_account`，可按账号单独配），全站最多 6 张（`image_total`），其余排队。排队多久都不算失败。
- 引擎撞墙（Codex 额度用完 / 模型被账号拒）：冷却这个账号，这张放回队列，**整批暂停到冷却结束，不换引擎**；连续暂停超过 2 小时，剩下的图判失败（`engine_unavailable`，message 带 `paused over 2h`）。
- paint 只执行：向 router 领活、按 router 给的引擎画、画完回报（带引擎报错原文，router 据此判冷却多久）。Codex 模型候选、安全拦截重试、瞬时 429 原地等、尺寸规整、Seedream 后处理、XMP 溯源都在 `src/worker.ts`。

调用方只需要知道：成功（拿 `result_url`）或失败（`error.code` + `error.message`）。不要在客户端再写一层重试 / 降级 / 拆批 / 换引擎。

现有调用方：

| 调用方 | 位置 | 方式 |
|---|---|---|
| `bin/paint` | `claude-agent/bin/paint` + `bin/paint-client.mjs` | 清单一次交一批（或单张），轮询 + 逐张下载 |
| VoiceDrop edit_photo / new_photo / 题图调优页 | `agent/src/paint-client.js` 的 `paintSubmit()` | 单张提交 + 回调 |
| 网页 | `https://paint.jianshuo.dev/`（Caddy 密码） | 手动 |

## 单张请求

`POST /api/jobs`，头 `Authorization: Bearer <API_TOKEN>`，JSON body：

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✓ | ≤4000 字 |
| `image_url` / `image_b64` | | 给了就是**改图**（edit）。url 须 http(s) 公网；b64 ≤25MB |
| `size` | | 缺省 `2K`。任意合理 `宽x高`，服务端规整：两边吸附到 16 倍数、总像素 ≥655,360 且 ≤8,294,400、单边 ≤3840、长短边比 ≤3:1（等比调整）；或关键字 `auto` / `2K` / `4K`。实际尺寸看 202 回包与结果里的 `size`。乱填（`huge`）→ 400 |
| `format` | | `png`（缺省）/ `jpeg` / `webp` |
| `compression` | | 0–100，jpeg/webp 用；书和 VoiceDrop 一律 80 |
| `quality` | | `low` / `medium` / `high`（服务端缺省）/ `auto`，只对 Codex 有效；`bin/paint` 不传时一律 `medium` |
| `transparent` | | `true` = 透明底 PNG。**只有 Codex 能做**（router 会把这批定给 gpt-image）；不能和改图同用 |
| `engine` | | `auto`（缺省，router 按额度挑）/ `codex` / `seedream`（点名后这批只用它）。点 `seedream` 而服务端没配 `ARK_API_KEY` → 400；`seedream` + `transparent` → 400 |
| `group` | | 画风分组，如书的 slug（`[A-Za-z0-9_.:-]{1,80}`）：同组的批次用同一个引擎 |
| `callback_url` / `callback_token` / `callback_meta` | | 完成后 POST 回调，见下 |
| `xmp_prompt` / `xmp_meta` | | 图片内嵌 XMP 溯源：`xmp_prompt:false` 不写 prompt；`xmp_meta` 自定义键值（≤4KB） |

回 `202 {job_id, status:"queued", poll_url, events_url, size, deadline_at:null}`（排队在 router，开画后 `GET` 里才有 `deadline_at`）。router 一时连不上不影响提交：job 先排着，paint 每分钟补交一次。

## 批次请求

`POST /api/batches`，body：

```json
{ "group": "book-slug", "label": "《书名》", "engine": "auto",
  "inputs": { "i0": "<refs.png 的 base64>" },
  "items": [ { "key": "/abs/book-slug/p01.jpg", "prompt": "…", "image_ref": "i0", "size": "1024x1024", "format": "jpeg", "compression": 80, "quality": "medium" },
             { "key": "/abs/book-slug/p02.jpg", "prompt": "…", "image_ref": "i0" } ] }
```

- 每项字段同单张（`prompt`/`size`/`format`/`quality`/`transparent`/`image_b64`/`image_url`…），另有 `key`（调用方自己的标识，原样带回）和 `image_ref`（引用 `inputs` 里的图——同一张参考图一批只传一次）。批次级 `group` / `engine` 作用于所有项。
- 1–200 项；任何一项不合法整批 400（`items[i]: …`），一张都不建。router 拒收 → 503。
- 回 `202`，与 `GET /api/batches/:id` 同形：

```json
{ "batch_id": "b_…", "status": "queued|running|paused|done|failed|cancelled", "engine": "codex|seedream|null",
  "decided_reason": "group book-slug uses seedream", "paused_until": null, "pause_reason": null,
  "counts": { "total": 15, "queued": 7, "running": 4, "done": 4, "failed": 0 },
  "items": [ { "key": "/abs/book-slug/p01.jpg", "job_id": "…", "status": "done", "attempts": 1,
               "result_url": "https://paint.jianshuo.dev/results/<id>.jpg", "engine": "codex", "model": "gpt-6-astra", "error": null } ] }
```

## 结果

`GET /api/jobs/:id` →

```json
{ "job_id": "…", "status": "queued|running|done|failed", "percent": 100,
  "result_url": "https://paint.jianshuo.dev/results/<id>.jpg", "format": "jpeg", "size": "1024x1536", "bytes": 512345,
  "engine": "codex|seedream", "model": "gpt-6-astra | doubao-seedream-5-0-pro-260628",
  "fallback_reason": null, "engine_pref": "auto", "group": "book-xxx", "batch_id": "b_…", "key": null,
  "error": null, "attempts": 1, "created_at": "…", "done_at": "…", "deadline_at": null }
```

- `engine`：实际出图（或失败时栽在）的引擎。`model`：codex 时是外层 Codex 模型（真正出图的是它调用的 gpt-image-2），seedream 时是方舟模型 id。
- `fallback_reason` 恒为 `null`（2026-10-28 起不再降级，字段为兼容保留）。
- `result_url` 公开可访问（路径不可猜），保留 30 天。图里嵌 XMP：`paint:Model` = `gpt-image-2` 或方舟模型 id。
- 回调：`POST callback_url`，头 `X-Paint-Signature: sha256=<HMAC(body, CALLBACK_SIGNING_SECRET)>`、可选 `Authorization: Bearer <callback_token>`；body
  `{job_id, status, result_url, format, size, bytes, error, callback_meta, engine, model, fallback_reason}`。只在终态回调（router 放回队列的不回调）。失败最多重送 3 次。

## 错误码与对策

| `error.code` | 含义 | 该怎么办 |
|---|---|---|
| 400 `prompt required` / `bad size` / `bad engine` / `bad group` / `seedream cannot do transparent` / `seedream not configured…` / `image_ref … not in inputs` | 提交被拒（同步） | 改参数；不要重试同一请求 |
| `invalid_argument` | 参数组合非法（如 transparent + 改图） | 改参数 |
| `input_download_failed` | `image_url` 拉不下来 | 检查原图 URL |
| `missing_image_result` | OpenAI 安全过滤扣了图（已自动重试 1 次） | 改写 prompt（去掉敏感/真人/品牌），再提交 |
| `http_error` | Codex 侧错误（详见 message：401 登录失效 / 400 …）。额度类不会到这里——router 会暂停批次等恢复 | 401 要人工修 Codex 登录 |
| `seedream_error` | 方舟两个模型都失败（含内容审核 400） | 看 message；审核类改 prompt |
| `seedream_unavailable` | 派给了 Seedream 但不可用（透明图 / 没配 key） | 报维护者（router 配置与 paint 不一致） |
| `engine_unavailable` | router 判失败：这批的引擎暂停超过 2 小时（额度没恢复），或批次已不在 router | 等额度恢复后重交；别换引擎重画（会破坏整本一个画风） |
| `cancelled` | 批次被取消 | — |
| `postprocess_error` | Seedream 已出图，但本机 ImageMagick 裁缩/转格式失败（不会再换模型二次付费） | 服务端问题，报给维护者（`convert` 是否装了） |
| `deadline_exceeded` | 开画后 8 分钟没画完（router 会自动重排一次，第二次才判失败） | 重交 |
| `router_unavailable` | 交批时 engine-router 不可用（批次接口返回 503） | 稍后重交 |
| `no_output` / `parse_error` / `crash` / `unknown` | 引擎异常 | 重试一次，仍失败报维护者 |
| 客户端 `rejected` / `download_failed` | `bin/paint` 侧：提交 HTTP 非 202 / 结果下载失败 | 看 message |

## 时间

- **执行期限 8 分钟**（`JOB_DEADLINE_MS`），**从开画算**（排队在 router，不算）。每条腿的超时取「自身上限」与「剩余时间」的较小者。
- 典型耗时：Codex 1–3 分钟；Seedream 约 30–60 秒。4 张并发，15 张的绘本约 10–15 分钟。
- `bin/paint` 一条命令最多等约 9 分钟（`PAINT_WAIT_MS`）：没画完退出码 3，**原样重跑接着等同一批**（清单旁的 `<清单>.batch` 记着批次号），不会重复画。

## 费用

- **Codex**：吃 ChatGPT Plus 订阅额度，与写书的 codex 腿同一个池——批量出图先想清楚。
- **Seedream**：火山方舟按张计费（真金白银，账单在火山引擎控制台）。也正因如此，后处理失败不会再换模型重画一次。

## 命令行（claude-agent VPS 上）

```bash
# 一批（两张以上一律这样；前台，Bash timeout 600000）
/opt/claude-agent/bin/paint 清单.json --group book-slug [--label 书名] [--engine auto|codex|seedream] [--force]
#   清单：[{"out":"/abs/p01.jpg","prompt":"…","image":"/abs/refs.png","size":"1024x1024","quality":"medium"}, …]
#   逐张 ok <out> (引擎 模型) / FAIL <out> <code>: <message>；已存在跳过
#   退出码：0 全好 / 1 有失败（原样重跑只重画失败的）/ 2 用法错 / 3 没等完（原样重跑接着等）

# 单张（= 1 张的批次）
/opt/claude-agent/bin/paint "提示词" out.jpg                           # 文生图
/opt/claude-agent/bin/paint "提示词" out.jpg --image ref.png            # 改图
/opt/claude-agent/bin/paint "提示词" cover.jpg --size 1024x1536 --group book-slug
#   其它：--transparent --quality low|medium|high --format png|jpeg|webp --compression 0-100 --engine auto|codex|seedream
#   成功 stdout：saved: … / result_url: … / engine: codex (gpt-6-astra) / job: <id>
#   失败 stderr：paint job failed: <code>: <message> (job <id>…)，退出码 1
```

格式缺省按输出扩展名（.jpg→jpeg、.webp→webp、其余 png）；jpeg/webp 缺省压缩 80。环境变量 `PAINT_API`（缺省 `http://127.0.0.1:8788`）、`PAINT_API_TOKEN`（必需）、`PAINT_WAIT_MS`。

## 运维

- 部署：`paint/deploy.sh`。重启安全：启动时把手上没画完的交还 router（`release-all`），router 重新派。依赖 ImageMagick `convert`（`deploy/provision.sh` 会装）。
- 关键 env 见 `.env.example`：`ROUTER_URL`、`ROUTER_TOKEN`（**必配**，没有就起不来）、`ARK_API_KEY`、`SEEDREAM_MODELS`、`CONVERT_BIN`、`JOB_DEADLINE_MS`、`RATE_LIMIT_RETRY_MS`、`MAX_CONCURRENCY`（本进程兜底上限，缺省 8；真正的并发闸门在 router）。
- 看进度：`https://lab.jianshuo.dev/router/` 的「出图批次」表（每批的引擎、进度、暂停原因）；单张日志 `https://paint.jianshuo.dev/log`；`journalctl -u paint` / `journalctl -u engine-router`。
