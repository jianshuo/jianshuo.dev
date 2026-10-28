# paint.jianshuo.dev

Codex 订阅版 gpt-image-2 图片服务：网页手动用 + HTTP API（异步 + webhook 回调）给 skill 调。
设计 spec: `docs/superpowers/specs/2026-07-01-paint-jianshuo-dev-image-service-design.md`

## 本地开发
- `npm install && npm test`
- 跑起来（打桩 CLI，不花额度）：见 spec / plan Task 9 Step 3。

## 部署（Tokyo VPS 66.42.45.128）
- 首次：`deploy/provision.sh`（VPS 上 root），然后按提示放 `.env` / `auth.json` / Caddy 密码。
- 更新：本地 `./deploy.sh`。
- 排查：`ssh root@66.42.45.128 'journalctl -u paint -n 50 --no-pager'`

## API / 使用说明书
**唯一真源：[USAGE.md](USAGE.md)**——批次 / 单张接口、engine/group 语义、错误码与对策、时间预算、费用、
`bin/paint` 用法都在那里。agent 版精简说明：`claude-agent/skills/paint/SKILL.md`。

一句话（2026-10-28 起）：一批图 `POST /api/batches`（单张 `POST /api/jobs` = 1 张的批次）交给 engine-router 调度——
一批一个引擎、同一 group 同一个引擎、按账号并发排队、撞墙暂停不换引擎；paint 只执行（`src/worker.ts`：向 router 领活、
按给定引擎画、回报），Codex 模型候选、限流原地重试、尺寸规整、Seedream 后处理、XMP 都在这里，调用方不碰。
