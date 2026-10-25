# engine-router：Tokyo VPS 上的 AI 引擎调度器（计划）

> 2026-10-25 · 状态：P0–P3 完成，四个账号（claude-1、claude-2、codex-1、kimi-1）全部在线（`engine-router/`，见其 README）；P4/P5 待开工

## 进度（2026-10-25）

- **部署形态改动**：按要求不开新端口——服务只听 Unix socket `/run/engine-router/router.sock`，由 Caddy 挂在 `lab.jianshuo.dev/router/` 下（API 用 Bearer token、豁免 basic_auth；状态页走 lab 的 basic_auth）。计划里的 `127.0.0.1:8790` 作废。
- **P0**：claude-agent、codex-agent 两条过期的 Codex 链用各自服务用户真跑 `codex exec`，都还活着（只是太久没用），auth.json 已刷新。claude-2（第二个订阅 setup-token）、codex-1（同一个 ChatGPT 账号的新 device-auth 链，router 独占）当天接入。四条 Codex 链 id_token 核对过是同一个账号，`wham/usage` 读数一致——用量按账号算，监控不受多链影响。
- **P1 监控**：三家探针上线，账号不健康即推送。
- **P2 挑选器**：headroom / failover / round_robin、5h 红线、周配速、冷却、在飞预留、avoid / require、干跑接口，全部单测覆盖。上线当天的干跑就拦下了 kimi-1：周用量 54.9%，而周窗口只过了约 29%（配速线 38.8%）。
- **P3 执行层 + 会话**：真实端到端跑通 claude-1、kimi-1、codex-1；第 ① 档（Claude SDK resume、`codex exec resume` 都通过）、第 ③ 档（kimi → claude、claude → codex 交接）实测通过。**第 ② 档实测结论：claude ↔ kimi 双向、fast 与 best 两档都能 resume 同一会话 → `portable.claude_family` 默认开**；Codex 跨 CODEX_HOME 待 codex-1 登录后再测。
- **单测**：64 个（含从 book-legs 搬来的全部换腿判据测试）。

## 一句话

在 Tokyo VPS 上起一个独立服务 `engine-router`，统一管理 Codex、Claude Code、Kimi 三类文字引擎，以及 Codex gpt-image-2、火山 Seedream 两类出图引擎的全部账号/Key。它持续监控每个账号的 5 小时额度和每周额度，按可配置的策略挑一个账号执行任务，还负责保管多轮会话。调用方只说「跑这个任务」或「接着这个会话说」，不知道背后是哪个引擎、哪个 Key。

## 已拍板的决定（2026-10-25）

| 问题 | 决定 |
|---|---|
| 执行放在哪 | **放在 router 里**：凭据、会话文件、引擎进程都归 router 一个系统用户 |
| 默认策略 | **`headroom`**，引擎层和 Key 层都是（挑剩余额度最多的） |
| 额度红线 | 5h 上限 85%，周上限 92%，周配速宽限 10 个百分点 |
| 账号数量 | Claude 2 个；Codex 1 个；Kimi 1 个 |
| 历史消息 | router 管会话，调用方只拿 `thread_id`；按调用方声明的连续性要求，分三档换账号（见「会话」一节） |
| paint | 接入：Codex gpt-image-2 和 Seedream 的选择、额度、降级都交给 router |

> 注：拍板时说的是「seedance」。paint 现在接的火山模型是 **Seedream**（出图），Seedance 是火山的视频模型。本计划按 Seedream 写；如果要的是 Seedance 视频，单独加一个 `video` 任务类，P5 之后另排。

## 目标 / 非目标

**目标**

1. 每类引擎可挂多个账号/Key，热增删，不用改代码。
2. **事前避开**额度墙：5 小时窗口留余量，每周额度按时间配速，任何账号都不被打穿。
3. 策略可配：`headroom`（默认）、`failover`（按顺序，前一个不合格才换下一个）、`round_robin`（在合格账号里轮流）。引擎之间、同一引擎的多个 Key 之间各一层，可按任务类覆盖。
4. 调用方零引擎知识：统一的任务 API、统一的事件流、统一的会话。中途撞墙自动换账号，调用方只看到一条 `switched` 事件。
5. 自带体检：凭据过期、链被吊销、模型被拒，都在**没有任务的时候**就报出来（「备用腿不监控就等于不存在」）。

**非目标（本期不做）**

- lab 网页聊天（`/api/chat`）先不迁。它会和 router 用同一个 Claude 账号，用量是按账号算的，router 的监控照样能看到它吃掉的额度。
- codex.jianshuo.dev（codex-agent）先不迁，理由同上（P6 可选）。
- 不做按量计费 API 的成本优化。唯一例外是 Seedream：它按张计费，所以给它设每日预算。

## 现状盘点（2026-10-25 实测）

| 引擎 | 现在谁在用 | 凭据位置 | 额度能不能查（不花额度） |
|---|---|---|---|
| Codex（ChatGPT Plus） | 写书 codex 腿、paint 出图、codex.jianshuo.dev | 同一个 ChatGPT 账号的三条 device-auth 链：`/opt/{claude-agent,codex-agent,paint}/.codex` | ✅ `GET chatgpt.com/backend-api/wham/usage` → `primary_window`(5h) / `secondary_window`(周) 的 `used_percent` + `reset_after_seconds`。用量按**账号**算，三条链共用一个池。实测 5h 10%、周 4%。**claude-agent、codex-agent 两条链 access token 已过期（401 token_expired）**，auth.json 停在 10/14 |
| Claude Code（订阅） | 写书 claude 腿、lab 聊天 | `/opt/claude-agent/.env` 的 `CLAUDE_CODE_OAUTH_TOKEN`（setup-token） | ⚠️ `api/oauth/usage` 被拒（setup-token 缺 `user:profile` scope）。**替代**：haiku `max_tokens:1` 请求读响应头 `anthropic-ratelimit-unified-{5h,7d}-utilization` / `-reset` / `-status`。实测 5h 0%、周 19% |
| Kimi（coding 订阅） | 写书 kimi 腿 | `.env` 的 `BOOK_ANTHROPIC_API_KEY` | ✅ `GET api.kimi.com/coding/v1/usages` → `usages.limit_5h.used_ratio` / `limit_7d.used_ratio` + `reset_time`。实测 5h 44%、周 55% |
| Seedream（火山方舟） | paint 降级 / 显式 `engine:"seedream"` | `/opt/paint/.env` 的 `ARK_API_KEY` | 无额度窗口，按张计费。router 自己记账 |

现有的调度雏形：

- 写书：`claude-agent/src/book-engine.ts` 的三腿降级链 + `book-legs.ts` 的 `shouldTryNextLeg` / `classifyResult`。这是**事后**判别（倒在 403 上才换），一类引擎只能挂一个 Key。四次「判据漏一类」事故（9/2 吊销、9/7 模型被拒、10/1 错误藏在 assistant 消息、10/24 审核拒答）都出在这条路径上。
- 出图：`paint/src/worker.ts`：Codex 优先，额度满/模型被拒/瞬时限流时降级 Seedream，冷却存在进程内存里（重启即清），group 画风粘性落盘。

engine-router 把这两套合成一套：**事前挑选 + 事后兜底**两道闸。`shouldTryNextLeg`、`classifyResult` 和 paint 的降级判别连同各自的单测原样搬过去，当第二道闸。

VPS 约束：1 核、951MB 内存。全局并发闸门收在 router 手里。

## 架构

```
 调用方：book-runner（写书/修书）· paint（出图）· 以后的任何服务
        │  POST /v1/runs {kind, task_class, prompt, thread_id?, ...}
        ▼
 ┌──────────────── engine-router（127.0.0.1:8790，系统用户 engine-router）─────────────┐
 │  Registry   账号注册表（config.json + .env 密钥）                                    │
 │  Monitor    每个账号定时探额度 → usage 缓存（落盘）；Seedream 记账                    │
 │  Selector   策略 + 配速 + 在飞预留 + 引擎提示 → 挑 (engine, account)                  │
 │  Threads    会话登记簿：thread → 各次 run、各引擎原生会话号、统一事件记录              │
 │  Runner     每个 run 一个 systemd-run --user 瞬态单元，事件写 runs/<id>.jsonl        │
 │  Adapters   文字：codex-exec / claude-sdk(订阅) / claude-sdk(Kimi 兼容端点)          │
 │             出图：codex gpt-image-2 / seedream                                      │
 │  Fallback   中途撞墙 → 判别 → 账号冷却 → 换下一个账号                                │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

**执行放在 router 里的理由**

- **单一写者**：Codex 的 refresh token 是轮换式的，一条链只能有一个写者（见记忆 codex-subscription-auth-chains）。router 独占全部链，monitor 刷新 token 和 run 使用 token 是同一个进程。
- **会话可移植**：Claude Code 和 Codex 的会话文件都在执行用户的 HOME 下。只有凭据和会话文件在同一个用户手里，才能拿 A 账号的会话换 B 账号的 token 接着跑（会话第 ② 档）。
- **全局并发和在飞预留**只有集中执行才算得准。
- **重启不杀任务**：每个 run 跑在独立的瞬态单元里，照搬 2026-09-11 book-runner 的做法。

代价是工作目录权限：建 `engines` 组，调用方的工作目录（如 `/opt/claude-agent/workspace`）改成 setgid + 组可写，router 的 unit 用 `ReadWritePaths` 放行。workdir 必须在白名单根目录下。

## 账号注册表

`/opt/engine-router/config.json`（不含密钥，进 vps-tokyo 灾备仓库），密钥在 `/opt/engine-router/.env`（600）：

```json
{
  "engines": {
    "claude":   { "kind": "text",  "accounts": [
      { "id": "claude-1", "token_env": "CLAUDE_TOKEN_1" },
      { "id": "claude-2", "token_env": "CLAUDE_TOKEN_2" }
    ]},
    "codex":    { "kind": "text",  "accounts": [
      { "id": "codex-1", "codex_home": "/opt/engine-router/accounts/codex-1" }
    ]},
    "kimi":     { "kind": "text",  "accounts": [
      { "id": "kimi-1", "key_env": "KIMI_KEY_1", "base_url": "https://api.kimi.com/coding/" }
    ]},
    "gpt-image":{ "kind": "image", "quota_from": "codex", "accounts": [
      { "id": "codex-1" }
    ]},
    "seedream": { "kind": "image", "accounts": [
      { "id": "ark-1", "key_env": "ARK_API_KEY", "daily_cap": 200 }
    ]}
  },
  "models": {
    "claude": { "best": "claude-opus-4-8", "fast": "claude-haiku-4-5" },
    "codex":  { "best": "gpt-6-astra",     "fast": "gpt-6-astra" },
    "kimi":   { "best": "k3",              "fast": "k3" },
    "seedream": ["doubao-seedream-5-0-pro", "doubao-seedream-4-0"]
  },
  "limits": { "cap_5h": 85, "cap_7d": 92, "weekly_slack": 10, "probe_every_s": 300 },
  "policies": {
    "default": { "engines": "headroom", "keys": "headroom" },
    "image":   { "engines": "failover", "order": ["gpt-image", "seedream"], "keys": "headroom" }
  },
  "concurrency": { "global_text": 2, "global_image": 3, "per_account": 1 }
}
```

- **Claude ×2**：`claude-1` 沿用现在 lab 的 setup-token；`claude-2` 是你另一个订阅新生成的 setup-token。订阅 token 按 ToS 仅限本人使用。
- **Codex ×1**：在 `accounts/codex-1/` 给同一个 ChatGPT 账号**新登**一条 device-auth 链。绝不拷 auth.json。迁移完成后退役 claude-agent、paint 的旧链；codex-agent 的链留着，用的是同一个额度池，router 通过账号级用量能看到它的消耗。
- **gpt-image 和 codex 同池**：`quota_from: "codex"` 表示出图不单独探额度，读 codex-1 的用量。一张高质量竖图约吃周额度 5%（见记忆 codex-plus-image-quota-cost），出图和写书在 router 里第一次能互相看见对方的消耗。
- **出图类覆盖为 `failover`**：Seedream 按张花真钱，又没有额度窗口，用 headroom 比较会一直选它。所以出图保持现在的行为：Codex 优先，不合格再走 Seedream。
- 增删账号：改 config/.env → `POST /v1/admin/reload`（或 SIGHUP），不重启。

## 额度监控（Monitor）

每个账号一个探针，统一输出 `{used_5h, reset_5h, used_7d, reset_7d, healthy, error, probed_at}`：

| 引擎 | 探法 | 频率 |
|---|---|---|
| Kimi | `GET /coding/v1/usages` | 每 5 分钟 |
| Codex | `GET wham/usage`；access token 过期就先用 refresh token 换新（router 是唯一写者，tmp+rename 原子写回，保留最近 3 份备份） | 每 5 分钟 |
| Claude | haiku `max_tokens:1` 读限流响应头 | 每 15 分钟；有 run 在飞时，run 结束再探一次 |
| Seedream | 不探；router 本地账本记当日张数 | 实时 |

- 探针失败分类：凭据失效 / 吊销 / 模型被拒 → `healthy:false`，立刻发管理员推送（复用 worker `POST /agent/push/admin`，2 小时节流）。
- 每次 run 前后各记一次用量，按 (task_class, engine) 分桶算**单次消耗**的指数滑动平均，用于在飞预留。例如「一本书在 Kimi 上平均吃掉 5h 窗口的 30%」「一张高质量竖图吃 Codex 周额度 5%」。
- usage 缓存落 `state/usage.json`；超过 2 个探测周期没刷新视为「未知」，选择时排在已知可用的账号后面。

## 挑选规则（Selector）

一个账号**合格**要同时满足：

1. `healthy`，且不在冷却期（撞过墙的冷却到 `reset_5h`；模型被拒冷却 30 分钟）。
2. **5 小时余量**：`used_5h + 在飞预留 + 本次预估 ≤ cap_5h`（85%）。
3. **周配速**：`used_7d ≤ min(cap_7d, 本周已过时间比例 × 100 + weekly_slack)`。周一中午（过了约 7%）最多用到 17%，周日晚上才允许接近 92%。
4. 账号并发未满；Seedream 另看当日张数 < `daily_cap`。
5. 满足调用方的硬约束（`engine_hints.require` / 能力要求，例如透明底只有 gpt-image 能做）。

**headroom 怎么算**：账号余量 = min(`cap_5h − used_5h − 预留`, `周配速线 − used_7d`)，取两者里更紧的一个。引擎层比较各引擎里最好的那个账号，Key 层比较同引擎内的账号。`engine_hints.avoid` 里的引擎排到最后，不是剔除：比如政治题材避开 Kimi，但其他引擎都满了时 Kimi 仍可兜底。

全部不合格时：默认**排队**，等最早的 `reset_5h` 或下一次探测后再选（返回 `queued` 和预计开始时间）；`on_exhausted:"fail"` 立刻失败；`force:true` 无视配速，只要没撞墙就跑（手动救急用）。

## 会话（历史消息怎么处理）

三个文字引擎都是 agent CLI，不是聊天 API。历史里有大量工具调用和工具结果，不能当消息数组塞回去，只能「恢复会话」。所以**会话归 router 管，调用方只拿 `thread_id`**：

```
第一次：POST /v1/runs {prompt, ...}              → {run_id, thread_id}
续聊：  POST /v1/runs {thread_id, prompt, ...}
```

router 为每个 thread 登记：各次 run、每个引擎的原生会话号（Claude session_id / Codex thread id）、统一事件记录（`threads/<id>.jsonl`）。

续聊时如果上次用的账号已不合格，按跨度分三档：

| 换到哪 | 怎么接 | 历史保留 |
|---|---|---|
| ① 同一账号 | 原生恢复：Claude SDK `resume` / `codex exec resume` | 完整 |
| ② 同类引擎的另一个账号 | 会话文件是本地 jsonl、不绑凭据：claude-1 ↔ claude-2 换 token 直接 resume；Codex 把会话文件复制进目标账号的 CODEX_HOME 再 resume。**Kimi 腿也是 Claude Code CLI**，理论上 claude ↔ kimi 也属于这一档 | 完整（**P3 实测后才启用**） |
| ③ 跨类（Claude 系 ↔ Codex） | 移植：把统一事件记录压成一份交接摘要（目标、已做的事、关键结论、文件现状、未完成项），作为新会话的开头；工作目录照旧 | 有损 |

调用方声明连续性要求：

- `continuity:"strict"`：只接受 ①②，不行就排队等原账号或同类账号。适合聊天。
- `continuity:"loose"`（默认）：允许 ③。适合写书这类历史本来就在文件里的任务。
- `continuity:"none"`：每次都是新会话。适合出图、一次性评审。

**P3 必须实测的风险**：Claude 的 thinking 块带签名，Kimi 生成的历史拿回 Claude 可能被拒；Codex 跨 CODEX_HOME 复制会话文件能否 resume。测不过的组合在配置里降级为第 ③ 档，不硬上。

## 任务 API（调用方唯一需要知道的东西）

```
POST /v1/runs
GET  /v1/runs/:id/events?from=<offset>   SSE，可断线重连回放
GET  /v1/runs/:id                        { status, ok, reply, result, error, attempts[] }
POST /v1/runs/:id/cancel
GET  /v1/threads/:id                     会话里的各次 run 与摘要
GET  /v1/status                          账号池总览
POST /v1/select                          干跑：现在会选谁、为什么
```

`POST /v1/runs` 请求体：除 `prompt` 外都可选。

| 字段 | 说明 | 例子 |
|---|---|---|
| `kind` | `text`（缺省）/ `image` | |
| `task_class` | 选策略、分桶算单次消耗 | `book` / `revise` / `image` |
| `prompt` | 任务本身，引擎无关 | |
| `thread_id` | 续聊；不给就新开会话 | |
| `continuity` | `strict` / `loose` / `none` | 见上 |
| `instructions` | 追加到引擎系统提示里，续聊时不用每轮重发 | 写书 preamble |
| `workdir` | 工作目录，须在白名单根下 | `/opt/claude-agent/workspace` |
| `context_dirs` | skill/参考文件位置，适配层翻译成各引擎能读的形式 | `["/opt/claude-agent/.claude/skills"]` |
| `capabilities` | 需要的权限，决定沙箱和权限模式 | `{shell, network, write, images_in}` |
| `env` | 只注入这一次 run 的环境变量 | `{PAINT_API_TOKEN}` |
| `quality` | 档位，不传模型名，由 `models` 映射 | `best` / `fast` |
| `engine_hints` | `avoid`（软）/ `require`（硬） | `{avoid:["kimi"]}` |
| `output_schema` | 结构化输出（Codex `--output-schema`，Claude SDK outputFormat） | 评审打分 |
| `budget` | `{max_turns, timeout_ms, size}`；size 用于预留 | `{size:"large"}` |
| `priority` | 排队顺序 | `user` / `background` |
| `resume_hint` | 换账号整单重跑时追加到 prompt 后 | 现在的 `RESUME_HINT` |
| `idempotency_key` | 重复提交不跑出两份 | 写书 jobId |
| `caller` | 记账、按调用方限流 | `book-runner` / `paint` |
| `callback_url` | 跑完回调（HMAC 签名，同 paint） | |
| `on_exhausted` / `force` | 全满时排队还是失败；救急强跑 | |
| `image` | `kind:"image"` 专用：`{size, format, quality, transparent, input_url/b64}` | |

统一事件：`queued` / `started` / `text` / `tool` / `switched {reason}` / `done {ok, reply, result, error}`。事件里带不透明的 `account` 标签只为排查，调用方不应据此分支。

**适配层抹平的差异**

- 引擎能力垫片：Codex 没有子代理和 Workflow，适配层追加通用说明（「需要并行子代理的地方由你串行扮演」）。书相关说明（`CODEX_BOOK_PREAMBLE`）留在调用方，作为 `instructions` 传入。
- Claude/Kimi 腿的 auto-memory 隔离（独立 cwd、每单清 memory，防 Kimi 风控）搬进适配层。
- Kimi 兼容端点注入（全档位模型名映射、删 OAuth token 防抢道）搬进适配层。

客户端 `engine-router/client.ts`：`runTask(opts, onEvent) → Promise<{ok, reply, error, thread_id}>`，签名兼容现在的 `runBookEngine`，book-runner 迁移基本只改 import。

## paint 接入

paint 保留它擅长的部分，把「谁来画、用哪个账号、额度够不够」交给 router：

| 留在 paint | 搬进 router |
|---|---|
| 对外 API（`POST /api/jobs`、回调、SSE）、`bin/paint`/`paint-batch` 不变 | Codex gpt-image-2 执行（用 router 的 codex-1 链）、Seedream 调用 |
| 任务队列、8 分钟整单期限、尺寸规整、ImageMagick 后处理、XMP 溯源 | 额度判断、降级 Codex → Seedream、冷却（落盘，重启不丢） |
| group 画风粘性：组已粘在 Seedream 时，paint 传 `engine_hints.require:["seedream"]` | Seedream 每日预算 |
| `engine:"codex"` / `"seedream"` 显式指定 → 转成 `require` | 出图消耗计入 Codex 账号用量，和写书互相可见 |

- paint 调 router：`POST /v1/runs {kind:"image", task_class:"image", caller:"paint", continuity:"none", prompt, image:{…}, engine_hints}`，拿到结果文件后照旧做后处理。
- paint 现有的降级判别和单测（额度满 / 模型被拒 / 瞬时限流原地重试 / 不降级清单）搬进 router 的出图适配器，行为一致。
- `/opt/paint/.codex` 链在 P5 验收后退役。

## 分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 清账 + 开户**（半天，要你动手两次） | ①体检 claude-agent、codex-agent 两条过期链（真调用一次，死了登记待重登）；②你在 VPS 上给 `accounts/codex-1` 做一次 device-auth；③你生成第二个 Claude setup-token | 4 个账号（claude×2、codex×1、kimi×1）+ ark key 全部真调用成功 |
| **P1 只看不管**（1 天） | router 骨架 + Registry + 探针 + `GET /v1/status` + `jianshuo.dev/a/` 下浅色状态页 + 不健康告警。不接调用方 | 状态页显示每个账号 5h/周用量和重置时间；故意改错一个 key，5 分钟内收到推送 |
| **P2 挑选器**（1 天） | Selector：三种策略、配速、冷却、预留、引擎提示、排队；`POST /v1/select` 干跑 | 纯函数单测覆盖配速边界、全满排队、headroom/round_robin/failover、avoid 软约束、冷却恢复；干跑结果和状态页对得上 |
| **P3 执行层 + 会话**（2.5 天） | Runner（瞬态单元 + jsonl）、三个文字适配器（从 book-engine.ts 搬）、中途换账号（搬 `shouldTryNextLeg`/`classifyResult` 及全部单测）、全局并发、单次消耗学习；Threads 登记簿 + ①③档；**②档可移植性实测**（claude-1↔claude-2、claude↔kimi、Codex 跨 CODEX_HOME） | 小任务分别强制走三条腿都成功；让第一个账号 403，看到 `switched` 后换账号写完；跑一半重启 router 任务不断；同一 thread 续聊三轮，中间强制换账号，第三轮还记得第一轮的内容；②档每个组合的实测结论写进文档 |
| **P4 迁移写书**（1 天） | book-runner / 修书改调 `runTask`；`engines` 组 + workspace 权限；claude-agent `.env` 里的引擎凭据迁走（只留聊天用的） | 真实下单写一本书走通；把 Kimi 人为标满，书自动走别的引擎；修书走 thread 续接 |
| **P5 迁移 paint**（1.5 天） | 出图适配器（gpt-image-2 + Seedream）+ 降级判别搬家 + paint 改调 router；Seedream 每日预算 | paint 现有单测全过；`bin/paint` 出一张 Codex 图、一张显式 Seedream 图；把 codex-1 标满，`auto` 单自动走 Seedream；group 粘性照旧；`/opt/paint/.codex` 退役 |
| **P6 可选** | codex-agent 接入；lab 聊天接入（`continuity:"strict"`） | 视需要 |

合计 P0–P5 约 7–8 个工作日。代码放 `~/code/jianshuo.dev/engine-router/`，结构照 paint / codex-agent（`src/` + `deploy/provision.sh` + `deploy.sh` + `node --test`）。

## 风险与对策

| 风险 | 对策 |
|---|---|
| router 自己做 Codex refresh，写坏 auth.json 会烧掉一条链 | 原子写 + 最近 3 份备份；router 是唯一写者，调用方不再持有 CODEX_HOME |
| Claude 探针本身也是请求，计入 5h 用量 | haiku + 1 token，实测 5h 仍显示 0.0；频率 15 分钟 |
| 三家用量接口都是非公开接口，随时可能改 | 探针失败只标「未知」不判死；事后判别照样兜底 |
| 会话第 ② 档跨账号/跨供应商可能 resume 失败（thinking 签名等） | P3 逐组合实测，不过的组合降级到第 ③ 档 |
| 单次消耗预估不准（10 页 vs 40 页的书） | 预估只用于预留；按 task_class + size 分桶；撞墙走事后兜底 |
| headroom 不看质量，可能频繁把书派给 Kimi | 账号可设 `weight`，headroom 乘权重；需要时对某个任务类改成 failover |
| router 成为单点 | 瞬态单元保证重启不杀任务；P4/P5 迁移时保留旧代码路径一个周期，env 一行可回退 |
| 951MB 内存 | router 常驻只有几十 MB；重的是引擎 CLI，由全局并发闸门（文字 2、出图 3）控制 |
| 换账号=整单重跑，烧双份额度 | 事前挑选让中途撞墙变成少数情况；`loose` 档靠工作目录续跑，不从零开始 |
