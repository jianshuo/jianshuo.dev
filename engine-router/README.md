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
POST /v1/leases                    租约：只挑账号不执行 → { lease_id, engine, account } 或 { lease_id:null, reasons, eta }
POST /v1/leases/:id/complete       回报 { ok, engine_used, error } → 释放预留；error 是额度类就冷却该账号
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

| 调用方 | 方式 | 开关 / 回退 |
|---|---|---|
| **写书 / 修书**（claude-agent `book-runner`） | 整本书交给 router 执行（`POST /v1/runs`，task_class `book` / `revise`，workdir = `/opt/claude-agent/workspace`，`context_dirs` = 写书 skill，`env` 传 `PAINT_API_TOKEN`，幂等键 `jobId:main` / `jobId:contN` / `revise:slug#ts`） | lab `/opt/claude-agent/.env` 的 `BOOK_ENGINE_ROUTER=1`；改 0 下一单就回到三腿链（不用重启）。router 提交失败时自动退回三腿链 |
| **paint 出图** | 租约：每张图开画前 `POST /v1/leases`（kind image），router 决定 gpt-image 还是 seedream；paint 用自己的 Codex 链和方舟执行，画完 `complete` 回报 | `/opt/paint/.env` 的 `ROUTER_URL` / `ROUTER_TOKEN`；删掉 + restart paint 即回退。router 连不上（5 秒超时）自动走 paint 本地老逻辑 |

两者都经 `https://lab.jianshuo.dev/router` 访问（不必把服务用户加进 engines 组）。

**写书环境**：engine CLI 以 engine-router 用户跑写书 skill，为此——书库 `/opt/claude-agent/workspace` 有 ACL（`u:engine-router:rwX` + 默认 ACL 让新文件两个用户都能读写）、unit 的 `ReadWritePaths` 含书库；`/opt/engine-router/.claude/skills` 软链到 lab 的 skill 目录（skill 里到处是 `~/.claude/skills/…`）；`/opt/engine-router/.config/voicedrop/credentials` 是发布账号凭据的副本（`build.mjs` 读它）。Kimi 账号在 config 里带 `env`（1M 上下文、effort high），模型 `k3[1m]`，与原写书 Kimi 腿一致。

**为什么 paint 用租约而不是交给 router 执行**：paint 的执行层（8 分钟整单期限、模型候选、瞬时限流原地重试、安全拦截重试、ImageMagick 后处理、XMP 溯源）很成熟，整个搬进 router 等于重写；而且 gpt-image-2-skill 写 auth.json 的格式（epoch）和 codex CLI（RFC3339）不兼容，不能与 router 的链共用。租约让 router 仍是额度的唯一裁决者：Codex 出图和写书的消耗记在同一个账号上，互相看得见。出图策略 `image` = failover（gpt-image → seedream）+ 不配速、红线 90%：优先 Codex，快用完才给 Seedream（按张收费，每日上限 200，历史峰值 98/天）。显式 `engine:"codex"`/`"seedream"`、透明图、或没有可降级的 seedream 时用 force（配速只用来把活挪给替代引擎）。

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
