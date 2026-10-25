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
POST /v1/admin/reload              重读 config.json + .env（admin）
POST /v1/admin/probe               立刻探一轮额度（admin）
```

请求字段（除 `prompt` 都可选）：`task_class`、`thread_id`、`continuity`（strict / loose / none）、`instructions`、`workdir`（须在 `WORKDIR_ROOTS` 下）、`context_dirs`、`capabilities` `{shell, network, write}`、`env`、`quality`（best / fast）、`engine_hints` `{avoid, require}`、`output_schema`、`budget` `{max_turns, timeout_ms, size}`、`priority`（user / normal / background）、`resume_hint`、`idempotency_key`、`callback_url`、`on_exhausted`（queue / fail）、`force`。

事件：`queued` / `started` / `session` / `text` / `tool` / `switched` / `done`。

## 账号

`/opt/engine-router/config.json`（不含密钥，样板见 `config.example.json`）+ `/opt/engine-router/.env`（密钥，600）。改完 `systemctl reload engine-router`，不用重启。

现有账号：claude-1、claude-2、codex-1、kimi-1。各账号的登录身份与订阅档位记在私有记忆库，不放在这个公开仓库里。

- **加 Claude 账号**：在登录了那个订阅的电脑上跑 `claude setup-token`，把 token 写进 `.env` 的 `CLAUDE_TOKEN_N`，`config.json` 加 `{ "id": "claude-N", "token_env": "CLAUDE_TOKEN_N" }`。
- **加 Codex 账号**：每个账号一条**新的** device-auth 链，绝不拷 auth.json（轮换式 refresh token，拷贝即互踢）：
  ```bash
  ssh -t root@66.42.45.128 'install -d -o engine-router -g engines -m 700 /opt/engine-router/accounts/codex-N &&
    sudo -u engine-router HOME=/opt/engine-router CODEX_HOME=/opt/engine-router/accounts/codex-N codex login --device-auth'
  ```
  然后 `config.json` 加 `{ "id": "codex-N", "codex_home": "/opt/engine-router/accounts/codex-N" }`。router 是这条链唯一的写者（探针刷新 token 加文件锁；有任务在跑时探针不刷新）。
- **加 Kimi Key**：`.env` 加 `KIMI_KEY_N`，`config.json` 加 `{ "id": "kimi-N", "key_env": "KIMI_KEY_N" }`。

## 怎么挑账号

合格 = 健康 + 不在冷却 + 并发未满 + `5h 已用 + 在飞预留 + 本次预估 ≤ cap_5h` + `周已用 ≤ 配速线`。配速线 = 本周已过时间比例 × 100 + `weekly_slack`，封顶 `cap_7d`——周初就把一周烧完的账号会被拦住。策略 `headroom`（缺省，挑余量最大的）/ `failover`（按 `order`）/ `round_robin`，引擎层和 Key 层各一个，可按 `task_class` 覆盖。「本次预估」先用 `estimates`，跑过几次后用学到的值（状态页最下面一张表）。

跑到一半撞墙（配额 / 凭据 / 模型被拒 / 内容拒答，判别在 `src/legs.ts`），该账号进冷却，换下一个账号重跑，prompt 追加续跑提示。

## 会话三档

| 档 | 什么时候 | 怎么接 |
|---|---|---|
| ① | 原账号还合格 | 原生 resume |
| ② | 换到同家族的另一个账号（claude ↔ claude ↔ kimi，都是 Claude Code CLI） | resume 同一个会话文件（`portable.claude_family`，10/25 实测双向可用） |
| ③ | 跨家族（Claude 系 ↔ Codex） | 把之前各轮问答压成交接记录放在新会话开头 |

`continuity: "strict"` 只接受 ①②，不行就排队；`loose`（缺省）允许 ③；`none` 每次新会话。

## 运维

- 部署：`./deploy.sh`（本地 test+build → rsync → lockfile 变了才 npm ci → 重启）。重启不杀正在跑的任务（`KillMode=process`，runner 是 detached 子进程，新 server 从 `state/runs/` 接手）。
- 首次开服：`deploy/provision.sh` + `deploy/Caddyfile.snippet`。
- 日志：`journalctl -u engine-router -f`；单个 run 的引擎输出在 `/opt/engine-router/state/runs/<run_id>.log`，事件流在 `<run_id>.jsonl`。
- 状态：`state/pool.json`（用量 / 冷却 / 学到的消耗 / 游标）、`state/runs/`（14 天后自动清）、`state/threads/`、`state/cwd/<thread>`（Claude 系的会话落脚目录）。
- 账号不健康会推送到管理员手机（同一账号 2 小时一次）。
- 测试：`npm test`。
