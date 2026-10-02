---
name: paint
description: 出图说明书——凡是要生成图片、改图、画封面/插图/绘本页时先读它。本机唯一出图入口是 /opt/claude-agent/bin/paint（单张）和 /opt/claude-agent/bin/paint-batch（一批），背后是 paint.jianshuo.dev：Codex gpt-image-2 优先，额度满自动降级火山方舟 Seedream，全在服务端。Triggers — "画图", "生成图片", "改图", "出图", "配图", "封面", "插图", "paint", "paint-batch".
---

# paint：出图说明书

完整版（接口字段、全部错误码、运维）：`paint/USAGE.md`。本文是 agent 要知道的部分。

## 只有一个入口

- 单张：`/opt/claude-agent/bin/paint "提示词" 输出.jpg [选项]`
- 一批：`/opt/claude-agent/bin/paint-batch 清单.json [--group slug] [--engine e] [--force]`
- 两者共用同一个客户端，只做「提交 → 等 → 下载」。**选引擎、自动降级、限流重试、额度冷却、尺寸规整全在 paint 服务端**——你不用、也不要自己重试或换引擎兜底。
- **绝不用任何本地生图/改图/叠字工具**（ImageMagick、PIL、canvas…）替代 paint。

## 选项

| 选项 | 说明 |
|---|---|
| `--image 参考图` | 改图 / 带参考图出图（只吃一张） |
| `--size WxH` | 缺省 1024x1024。任意合理比例都行，服务端自动吸附成合法尺寸（如 1365x1024 → 1360x1024） |
| `--engine auto\|codex\|seedream` | 缺省 `auto`：Codex 优先，额度满/限流用尽/模型被拒时自动改用 Seedream。`codex` = 绝不降级；`seedream` = 直走方舟 |
| `--group <slug>` | 画风分组。**写书必带，值 = 书的 slug** |
| `--quality low\|medium\|high` | 只对 Codex 有效 |
| `--transparent` | 透明底 PNG，只有 Codex 能画（额度满时只能等） |
| `--format` / `--compression` | 缺省按扩展名：.jpg → JPEG q80（书里一律用 .jpg） |

## 输出（照此判断成败）

成功（退出码 0，stdout）：

```
saved: book-x/p01.jpg
result_url: https://paint.jianshuo.dev/results/<id>.jpg
engine: codex (gpt-5.4-mini)                 ← 或 engine: seedream (doubao-…) — fallback: <原因>
job: <id> (95s)
```

失败（退出码 1，stderr）：`paint job failed: <code>: <message> (job <id>…)`

| code | 你该做什么 |
|---|---|
| `missing_image_result` | 安全过滤扣图（已自动重试过）：改写提示词（去真人/品牌/敏感），再画 |
| `seedream_error` 含审核字样 | 同上，改提示词 |
| `deadline_exceeded` / `client_timeout` | 排队或卡住，原样重跑一次 |
| `rejected: HTTP 400 …` | 参数错（看 message），改参数，别原样重试 |
| `http_error`（401 等）/ `postprocess_error` / `seedream_unavailable` | 服务端问题，重试一次仍失败就如实报告，别自己绕 |

## 时间与调用方式

- 单张通常 1–3 分钟；降级 Seedream 约多 1 分钟。服务端整单期限 8 分钟（从提交算），`paint` 最长约 9 分钟必返回。
- **Bash timeout 一律给 600000ms，前台同步跑**。绝不 `run_in_background` / `nohup` / `Monitor`——回合结束后台进程全被杀。
- 两张以上用 `paint-batch`：整批一次提交，服务端 3 张并发，**每批 ≤6 张**（多了排在后面的会 `deadline_exceeded`）。已存在的 out 自动跳过，所以失败了原样重跑同一清单即可。
- 清单：`[{"out":"/abs/book-x/p01.jpg","prompt":"…","image":"/abs/book-x/refs.png","size":"1024x1024","quality":"high"}, …]`，`out`/`prompt` 必填，其余同 `paint` 选项（也可逐项写 `engine` / `group`）。

## 费用

Codex 吃 ChatGPT Plus 额度（高质量图约每周额度 5%/张，与写书 codex 腿同池）；Seedream 火山方舟按张真付钱。别无谓重画，别为「看看效果」批量试图。

## 整本书一个画风（写书必守）

Codex（gpt-image-2）和 Seedream 画风明显不同，一本书里混着用很难看：

1. 每张图（封面、refs.png、每一页）都带 `--group <书的slug>`（paint-batch 用 `--group`）。组里只要有一张走了 Seedream，服务端会把这本书后续的 `auto` 图都粘到 Seedream。
2. 全部图画完、上传之前对账：`/opt/claude-agent/bin/paint --engines book-<slug>/*.jpg`（paint-batch 结尾也会报引擎分布）。
3. 若两种引擎混用：把**少数派**删掉，用**多数派**的引擎重画——`paint … --engine <多数派> --group <slug>`，或删掉后 `paint-batch 清单.json --engine <多数派> --group <slug>`（平票选 seedream）。重画完再对一次账，全书上传的图同一引擎才许发布（refs.png 这类不上传的工作文件不算）。
