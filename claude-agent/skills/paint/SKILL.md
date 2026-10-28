---
name: paint
description: 出图说明书——凡是要生成图片、改图、画封面/插图/绘本页时先读它。本机唯一出图入口是 /opt/claude-agent/bin/paint：一批图写进清单一次交（一本书的所有页一条命令），或单张。背后是 paint.jianshuo.dev + engine-router：一批一个引擎（Codex gpt-image-2 或火山方舟 Seedream），同一本书始终同一个引擎，按并发排队画完。Triggers — "画图", "生成图片", "改图", "出图", "配图", "封面", "插图", "paint".
---

# paint：出图说明书

完整版（接口字段、全部错误码、运维）：`paint/USAGE.md`。本文是 agent 要知道的部分。

## 只有一个入口：`/opt/claude-agent/bin/paint`

- **一批（两张以上一律这样）**：`/opt/claude-agent/bin/paint 清单.json --group <书的slug> [--label 书名] [--engine e] [--force]`
- 单张：`/opt/claude-agent/bin/paint "提示词" 输出.jpg [选项]`（就是 1 张的批次）
- 整批一次交给 engine-router：**它给这一批定一个引擎，中途不换；同一个 `--group` 的所有批次也用同一个引擎**（所以整本书天然一个画风，不用对账）。每个账号同时画 4 张，其余排队，排多久都不算失败。
- 选引擎、排队、并发、额度撞墙后暂停等恢复、限流重试、尺寸规整全在服务端——你不用、也不要自己重试、拆批或换引擎兜底。
- **绝不用任何本地生图/改图/叠字工具**（ImageMagick、PIL、canvas…）替代 paint。

## 清单

```json
[{"out":"/abs/book-x/p01.jpg","prompt":"…","image":"/abs/book-x/refs.png","size":"1024x1024"},
 {"out":"/abs/book-x/p02.jpg","prompt":"…","image":"/abs/book-x/refs.png"}]
```

`out` / `prompt` 必填，其余同下面的单张选项（`image` / `size` / `quality` / `transparent` / `format` / `compression`）。同一张参考图只上传一次，放心每项都写。**一本书的页图（加封面）写进一份清单一次交完，不用分批、没有张数上限。**

## 选项

| 选项 | 说明 |
|---|---|
| `--group <slug>` | **写书必带，值 = 书的 slug**。同组所有批次（refs.png、封面、各页、补画）用同一个引擎 |
| `--label 书名` | 状态页上显示的名字（可选） |
| `--image 参考图` | 改图 / 带参考图出图（只吃一张） |
| `--size WxH` | 缺省 1024x1024。任意合理比例都行，服务端自动吸附成合法尺寸（如 1365x1024 → 1360x1024） |
| `--engine auto\|codex\|seedream` | 缺省 `auto`：router 按额度挑。点名后这一批只用它 |
| `--quality low\|medium\|high` | 缺省 `medium`，**一律用 medium，别写 high**（high 太吃 Codex 额度）。只对 Codex 有效 |
| `--transparent` | 透明底 PNG，只有 Codex 能画 |
| `--format` / `--compression` | 缺省按扩展名：.jpg → JPEG q80（书里一律用 .jpg） |
| `--force` | 已存在的 out 也重画（缺省跳过） |

## 输出与退出码（照此判断成败）

| 退出码 | 意思 | 你该做什么 |
|---|---|---|
| 0 | 全部画好（逐张 `ok  <out>  (引擎 模型)`，单张是 `saved: …`） | 继续 |
| 3 | **还没画完**（排队 / 在画 / 额度撞墙暂停中），打印「还在画：完成 x/n…」 | **原样重跑同一条命令**接着等同一批——不会重复交、不会重复画。可以一直重跑，最多等到 router 判失败（暂停超过 2 小时） |
| 1 | 批次结束但有图失败（逐张 `FAIL  <out>  <code>: <message>`） | 按下表处理后**原样重跑**：画好的自动跳过，只重画失败的 |
| 2 | 用法错 / 清单坏了 | 改命令 |

| 失败 code | 你该做什么 |
|---|---|
| `missing_image_result` | 安全过滤扣图（已自动重试过）：改写那一页的提示词（去真人/品牌/敏感），再跑 |
| `seedream_error` 含审核字样 | 同上，改提示词 |
| `engine_unavailable`（message 含 `paused over 2h`） | 引擎额度用完 2 小时没恢复：如实报告，别换引擎重画（会破坏整本一个画风） |
| `rejected: HTTP 400 …` | 参数错（看 message），改参数 |
| `http_error`（401 等）/ `postprocess_error` / `seedream_unavailable` | 服务端问题，重跑一次仍失败就如实报告，别自己绕 |

## 时间与调用方式

- Codex 一张 1–3 分钟，Seedream 约 30–60 秒；4 张并发，15 张的绘本约 10–15 分钟。
- 一条命令最多等约 9 分钟就返回（退出码 3 = 没等完，原样重跑）。**Bash timeout 一律给 600000ms，前台同步跑**。绝不 `run_in_background` / `nohup` / `Monitor`——回合结束后台进程全被杀。
- 先画的图要当后面的参考图（如 `refs.png`）：先单独跑完它（同样带 `--group`），再交依赖它的那一批。

## 费用

Codex 吃 ChatGPT Plus 额度（与写书 codex 腿同池）；Seedream 火山方舟按张真付钱。别无谓重画，别为「看看效果」批量试图。
