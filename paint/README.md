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
**唯一真源：[USAGE.md](USAGE.md)**——接口参数、engine/group 语义、自动降级条件、错误码与对策、时间预算、费用、
`bin/paint` / `paint-batch` 用法都在那里。agent 版精简说明：`claude-agent/skills/paint/SKILL.md`。

一句话：只有一个接口 `POST /api/jobs`（+ `GET /api/jobs/:id` / 回调），引擎选择、自动降级、冷却、限流重试、
尺寸规整、group 画风粘性、整单期限全在服务端 `src/worker.ts`，调用方不碰。
