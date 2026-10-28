# engine-router

Tokyo VPS 上的 AI 引擎调度器：统一管理 Codex、Claude Code、Kimi 的全部账号，监控每个账号的 5 小时和每周额度，按策略挑账号执行任务，撞墙自动换账号，并保管多轮会话。调用方只说「跑这个任务」，不知道背后是哪个引擎、哪个 Key。

设计与分期：[`docs/superpowers/plans/2026-10-25-engine-router.md`](../docs/superpowers/plans/2026-10-25-engine-router.md)

## 怎么访问

不开 TCP 端口，只听 Unix socket `/run/engine-router/router.sock`：

| 从哪 | 地址 | 鉴权 |
|---|---|---|
| VPS 本机（engines 组的用户） | `unix:/run/engine-router/router.sock` | Bearer token |
| 远程 | `https://lab.jianshuo.dev/router/` | Bearer token（`/router/v1/*` 豁免 basic_auth） |
| 状态页 | `https://lab.jianshuo.dev/router/` | lab 的 basic_auth（用户 `wjs`） |

调用方 token 在 VPS `/opt/engine-router/.env` 的 `ROUTER_TOKENS`（`名字:token,…`），现有 `book-runner`、`paint`、`admin`。

## 调用

```ts
import { runTask } from "./client.js"; // engine-router/src/client.ts，零依赖，可整个文件拷走
// ROUTER_URL（缺省 unix:/run/engine-router/router.sock）、ROUTER_TOKEN 从环境变量读
const out = await runTask({ task_class: "book", prompt, workdir, instructions }, (ev) => log(ev));
// out = { ok, reply, result, error, run_id, thread_id, status }
```

续聊：把上次的 `thread_id` 带上。

```ts
await runTask({ thread_id: out.thread_id, prompt: "接着改第三章" });
```

HTTP 接口：

```
POST /v1/runs                      提交 → 202 { run_id, thread_id, status, … }
GET  /v1/runs/:id                  状态与结果
GET  /v1/runs/:id/events?from=N    SSE 事件流（N = 上次收到的 id，断线续传）
POST /v1/runs/:id/cancel
GET  /v1/threads/:id               会话里每一轮的问答
GET  /v1/status                    账号池总览
POST /v1/select                    干跑：现在会选谁、为什么（请求体同 /v1/runs）
POST /v1/image-batches             出图批次 { items:[{job_id,key?,transparent?}], group?, label?, engine?, priority? } → 202 批次视图（见「出图批次」）
GET  /v1/image-batches/:id         批次进度 { status, engine, paused_until, pause_reason, counts, items }
POST /v1/image-batches/:id/cancel  取消：排队的判失败，在画的下次心跳叫停
POST /v1/image-jobs/claim          执行方（paint）领活 { max } → { items:[{job_id, batch_id, engine, account}] }
POST /v1/image-jobs/:id/complete   执行方回报 { ok, error? } → { status: done|failed|queued }（queued = 撞墙放回队列 / 被打断重排）
POST /v1/image-jobs/heartbeat      执行方心跳 { job_ids } → { stop:[…] }（3 分钟没心跳的放回队列）
POST /v1/image-jobs/release-all    执行方刚重启：手上的全放回队列
POST /v1/leases                    租约（只剩文字长活，kind 必须 text）：只挑账号不执行 → { lease_id, engine, account } 或 { lease_id:null, reasons, eta }
POST /v1/leases/:id/complete       回报 { ok, engine_used, error } → 释放预留；error 是额度类就冷却该账号
POST /v1/leases/:id/progress       长租约报进度 { step, label? } → 状态页「租约」栏显示这一步，并按原 ttl 续期
PUT  /v1/queues/:name              调用方整份替换自己的排队快照 { title, note, items:[{label, at, note}] } → 状态页「排队」栏（router 不参与排队）
POST /v1/admin/reload              重读 config.json + .env（admin）
POST /v1/admin/probe               立刻探一轮额度（admin）
```

请求字段（除 `prompt` 都可选）：`task_class`、`thread_id`、`continuity`（strict / loose / none）、`instructions`、`workdir`（须在 `WORKDIR_ROOTS` 下）、`context_dirs`、`capabilities` `{shell, network, write}`、`env`、`quality`（best / fast）、`engine_hints` `{avoid, require}`、`output_schema`、`budget` `{max_turns, timeout_ms, size}`、`priority`（user / normal / background）、`resume_hint`、`idempotency_key`、`callback_url`、`on_exhausted`（queue / fail）、`force`。

事件：`queued` / `started` / `session` / `text` / `tool` / `switched` / `done`。

**路径与 env**：`workdir` 必须在 `WORKDIR_ROOTS` 下，`context_dirs` 必须在 `WORKDIR_ROOTS` 或 `CONTEXT_ROOTS`（缺省 `/opt/claude-agent/.claude/skills`）下，都先解析符号链接再比较；router 自己的目录（`work/<thread>` 除外）和 `work/` 根一律拒。`env` 只用来传业务密钥（如 `PAINT_API_TOKEN`），HOME / PATH / NODE_* / LD_* / CLAUDE_* / CODEX_* / XDG_* 等会改变进程行为或隔离边界的变量一律拒。

**capabilities 的真实语义**（做不到的引擎挑选器不选，候选理由里写明）：

| 要求 | codex | claude / kimi |
|---|---|---|
| `write:false` | `read-only` 沙箱（也断网） | 禁 Write / Edit / NotebookEdit |
| `network:false` | `workspace-write` 沙箱（只能写 workdir，断网；10/25 线上实测 curl 解析不了域名） | 只有同时 `shell:false` 才派（否则 Bash 能 curl） |
| `shell:false` | 不派（codex 只靠 shell 干活） | 禁 Bash |

**已知风险（代码审查 #7，暂未处理）**：引擎 CLI 和 router 是同一个系统用户，被注入的任务能读到 `/opt/engine-router/.env`（全部订阅 token 和 ROUTER_TOKENS）和 `accounts/*/auth.json`。别把不可信的内容（陌生网页、用户投稿）原样喂给 router 跑；根治方案是引擎改用单独的低权限用户、每次只拿被选中账号的凭据。

## 接入方（2026-10-25 起生产）

| 调用方 | 方式 | router 不可用时 |
|---|---|---|
| **写书 / 修书**（claude-agent `book-runner`） | 整本书交给 router 执行（`POST /v1/runs`，task_class `book` / `revise`，workdir = `/opt/claude-agent/workspace`，`context_dirs` = 写书 skill，`env` 传 `PAINT_API_TOKEN`，幂等键 `jobId:main` / `jobId:contN` / `revise:slug#ts`）。lab `.env` 配 `ROUTER_URL` / `ROUTER_TOKEN` | 这一单失败（退款 + 管理员告警）。原来的三腿链 2026-10-25 已删，router 是唯一写书引擎 |
| **paint 出图**（2026-10-28 起） | 出图批次：paint 把一批 job 交 `POST /v1/image-batches`（单张也是 1 张的批次，priority interactive 插队），然后循环 `claim` 领活、按给定引擎画、`complete` 回报、`heartbeat` 续命，见下「出图批次」。`/opt/paint/.env` 配 `ROUTER_URL` / `ROUTER_TOKEN`（必配） | 单张 job 先排在 paint 里，每分钟补交；批次接口返回 503；正在画的不受影响，回报失败的 3 分钟后由 router 收回重派 |
| **视频书**（motion-book `run_book.sh`） | 租约：开机前 `POST /v1/leases`（kind text，task_class `video`，`engine_hints.require=["claude"]`，ttl 6h）挑 claude-1 / claude-2；挑不出再带 `force` 问一次（无视配速和红线，只躲撞墙）。router 只回账号名，令牌由 run_book.sh 从 `motion-book/secrets.env` 的 `CLAUDE_TOKEN_<账号 id，- 换 _>` 取，发给一次性做书机；机器销毁时 `complete`（附 claude.err 尾巴，撞墙就冷却）。租约带 `label`（《书名》视频书），每换一步 `progress` 报一次（顺带续期，12h 整本不过期）；lab 每分钟泵完把排队快照 `PUT /v1/queues/video-book`（书目、24 小时配额、下个名额时间）。读 lab `.env` 的 `ROUTER_URL` / `ROUTER_TOKEN` | 连不上 / 挑不出 / 没有该账号的令牌 → 用 lab `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN`（= claude-1）照做 |

三者都经 `https://lab.jianshuo.dev/router` 访问（不必把服务用户加进 engines 组）。

**写书环境**：engine CLI 以 engine-router 用户跑写书 skill，为此——书库 `/opt/claude-agent/workspace` 有 ACL（`u:engine-router:rwX` + 默认 ACL 让新文件两个用户都能读写）、unit 的 `ReadWritePaths` 含书库；`/opt/engine-router/.claude/skills` 软链到 lab 的 skill 目录（skill 里到处是 `~/.claude/skills/…`）；`/opt/engine-router/.config/voicedrop/credentials` 是发布账号凭据的副本（`build.mjs` 读它）。Kimi 账号在 config 里带 `env`（1M 上下文、effort high），模型 `k3[1m]`，与原写书 Kimi 腿一致。

## 出图批次（2026-10-28，`src/batches.ts`）

之前 paint 每张图租一次约：账号一忙就判失败或外溢到 Seedream，外溢一次 paint 的 group 粘性又把整本书钉死在 Seedream 单车道上（10/28《嘟嘟的松木大桌子》15 张画了半小时只出 5 张；7 天 52 次租约 23 次「no engine available」当场失败）。现在 router 负责调度，paint 只执行：

- **一批一个引擎**：开批时按出图策略、**整批剩余张数 × 单张预估**挑引擎（`select` 带 `count`、`ignoreBusy`——忙不算不合格，排队就是了）。中途不换。
- **group 统一引擎**：批次带 `group`（书的 slug）时，第一批定下的引擎记在 `pins`（14 天），之后同组的批次直接用它（force：只要没撞墙，配速和红线不拦）。点名 `engine` 优先；有透明图的批次只能 gpt-image。
- **并发**：每个出图账号 `account.concurrency`（缺省 `concurrency.image_per_account` = 4）张，全站 `concurrency.image_total` = 6 张（1GB 小机器，每张 gpt-image 是一个 node 进程）。interactive（VoiceDrop 单张）排在整本书前面，其余先来后到。
- **撞墙**：回报的 error 是额度 / 模型被拒类（`shouldTryNextLeg`）→ 冷却这个账号（`cooldownFor`），这张放回队列，整批暂停到冷却结束——不换引擎。连续暂停超过 2 小时剩下的图判失败。被打断（paint 重启、`deadline_exceeded`）重排一次。其余错误就是这张失败。
- **执行方协议**：`claim` 只给 `paint`（或 admin）；paint 每 30 秒心跳，3 分钟没心跳的放回队列；paint 启动先 `release-all`。在画的每张都在账号上记预留（并发记 `gpt-image/codex-1`，额度记 `codex/codex-1`），和写书互相看得见；Seedream 每画一张记当日张数，到 `daily_cap` 暂停到明天。整批完了探一次 codex 额度。
- 状态落盘 `state/batches.json`（批次 + group 绑定），重启接着排；终态批次留 3 天。状态页「出图批次」表看每批的引擎、进度、暂停原因，账号表「在跑」列对出图账号显示「在画/并发上限 · 排队」。

**为什么执行留在 paint**：paint 的执行层（模型候选、瞬时限流原地重试、安全拦截重试、ImageMagick 后处理、XMP 溯源）很成熟，整个搬进 router 等于重写；而且 gpt-image-2-skill 写 auth.json 的格式（epoch）和 codex CLI（RFC3339）不兼容，不能与 router 的链共用。所以 router 调度、paint 来领活——router 仍是额度的唯一裁决者。出图策略 `image` = failover（gpt-image → seedream）+ 不配速、红线 90%：优先 Codex，整批放不进 Codex 余量才给 Seedream（按张收费，每日上限 200）。

## 账号

配置分两份：

| 文件 | 真源 | 内容 | 怎么改 |
|---|---|---|---|
| `config.json` | **本仓库 `engine-router/config.json`**（部署时原样同步到 `/opt/engine-router/config.json`，router 从部署目录读） | 账号、模型、红线、策略、估算，不含密钥 | 改仓库 → 提交 → `./deploy.sh config`（本地校验 + 同步 + reload，不重启）。**别直接改 VPS**，下次部署会被覆盖 |
| `.env` | 只在 VPS `/opt/engine-router/.env`（600） | token / key / ROUTER_TOKENS | 在 VPS 上改 → `systemctl reload engine-router` |

`test/config-file.test.ts` 会校验仓库里的 `config.json`（字段、引用、不许出现密钥），写错了 `./deploy.sh config` 会在同步前拦住。

现有账号：claude-1、claude-2、codex-1、kimi-1。各账号的登录身份与订阅档位记在私有记忆库，不放在这个公开仓库里。

加账号都是两步：VPS 的 `.env` 放密钥，仓库的 `config.json` 加一行再 `./deploy.sh config`。

- **加 Claude 账号**：在登录了那个订阅的电脑上跑 `claude setup-token`，把 token 写进 `.env` 的 `CLAUDE_TOKEN_N`，`config.json` 加 `{ "id": "claude-N", "token_env": "CLAUDE_TOKEN_N" }`。
- **加 Codex 账号**：每个账号一条**新的** device-auth 链，绝不拷 auth.json（轮换式 refresh token，拷贝即互踢）：
  ```bash
  ssh -t root@66.42.45.128 'install -d -o engine-router -g engines -m 700 /opt/engine-router/accounts/codex-N &&
    sudo -u engine-router HOME=/opt/engine-router CODEX_HOME=/opt/engine-router/accounts/codex-N codex login --device-auth'
  ```
  然后 `config.json` 加 `{ "id": "codex-N", "codex_home": "/opt/engine-router/accounts/codex-N" }`。router 是这条链唯一的写者（探针刷新 token 加文件锁；有任务在跑时探针不刷新）。
- **加 Kimi Key**：`.env` 加 `KIMI_KEY_N`，`config.json` 加 `{ "id": "kimi-N", "key_env": "KIMI_KEY_N" }`。

## 怎么挑账号

合格 = 健康 + 不在冷却 + 并发未满 + `5h 已用 + 在飞预留 + 本次预估 ≤ cap_5h` + `周已用 ≤ 配速线`。配速线 = 本周已过时间比例 × 100 + `weekly_slack`，封顶 `cap_7d`——周初就把一周烧完的账号会被拦住。策略 `headroom`（缺省，挑余量最大的）/ `failover`（按 `order`）/ `round_robin`，引擎层和 Key 层各一个，可按 `task_class` 覆盖。每条策略还能用 `limits` 覆盖全局红线与配速（`cap_5h` / `cap_7d` / `weekly_slack` / `pacing`）：出图策略 `image` 配的是 `{ pacing: false, cap_5h: 90, cap_7d: 90 }`——Codex 一直用到 5h 或本周 90% 才换 Seedream；写书等文字任务仍走全局的周配速。「本次预估」先用 `estimates`，跑过几次后用学到的值（状态页最下面一张表）。

跑到一半撞墙（配额 / 凭据 / 模型被拒 / 内容拒答，判别在 `src/legs.ts`），该账号进冷却，换下一个账号重跑，prompt 追加续跑提示。

## 会话三档

| 档 | 什么时候 | 怎么接 |
|---|---|---|
| ① | 原账号还合格 | 原生 resume |
| ② | 换到同家族的另一个账号（claude ↔ claude ↔ kimi，都是 Claude Code CLI） | resume 同一个会话文件（`portable.claude_family`，10/25 实测双向可用） |
| ③ | 跨家族（Claude 系 ↔ Codex） | 把之前各轮问答压成交接记录放在新会话开头 |

`continuity: "strict"` 只接受 ①②，不行就排队；`loose`（缺省）允许 ③；`none` 每次新会话。

## 运维

- 部署：`./deploy.sh`（本地 test+build → rsync 代码和 config.json → lockfile 变了才 npm ci → 重启）；只改配置用 `./deploy.sh config`。重启不杀正在跑的任务（`KillMode=process`，runner 是 detached 子进程，新 server 从 `state/runs/` 接手）。
- 首次开服：`deploy/provision.sh` + `deploy/Caddyfile.snippet`。
- 日志：`journalctl -u engine-router -f`；单个 run 的引擎输出在 `/opt/engine-router/state/runs/<run_id>.log`，事件流在 `<run_id>.jsonl`。
- 状态：`state/pool.json`（用量 / 冷却 / 学到的消耗 / 游标）、`state/runs/`（14 天后自动清）、`state/threads/`、`state/cwd/<thread>`（Claude 系的会话落脚目录）。
- 账号不健康会推送到管理员手机（同一账号 2 小时一次）。
- 测试：`npm test`。
