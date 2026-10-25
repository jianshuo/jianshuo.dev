// src/env.ts — 路径与进程级配置。server 和 runner 两个入口共用，只放常量不放行为。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** dist/ 的上一级 = /opt/engine-router（本地开发时是仓库里的 engine-router/）。 */
export const APP_ROOT = process.env.APP_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");

// 不开 TCP 端口：只听一个 Unix socket，Caddy 把 lab.jianshuo.dev/router/* 反代进来，
// VPS 本机的调用方（book-runner、paint）也可以直接连这个 socket。
export const SOCKET_PATH = process.env.SOCKET_PATH ?? "/run/engine-router/router.sock";

export const CONFIG_PATH = process.env.CONFIG_PATH ?? join(APP_ROOT, "config.json");
// 密钥文件：systemd EnvironmentFile 也读它，但 reload 时由我们自己重新解析，
// 这样加一个 Key 不用重启服务。
export const SECRETS_PATH = process.env.SECRETS_PATH ?? join(APP_ROOT, ".env");

export const STATE_DIR = process.env.STATE_DIR ?? join(APP_ROOT, "state");
export const RUNS_DIR = join(STATE_DIR, "runs");
export const THREADS_DIR = join(STATE_DIR, "threads");
// 每个 thread 一个稳定的落脚目录：Claude Code 按 cwd 存会话，resume 必须同一 cwd；
// 也是 auto-memory 隔离区（每次开跑前清掉，见 adapters.ts）。
export const CWD_ROOT = join(STATE_DIR, "cwd");
// 每个 attempt 一个临时目录（TMPDIR / CLAUDE_CODE_TMPDIR）。不能用 /tmp：unit 开了 PrivateTmp，
// 重启时 systemd 会删掉旧的私有 /tmp，而 KillMode=process 留下来的引擎还在用它——
// 2026-10-25 r_oUYBcOsDaWON 写到第 12 章时 router 发版，之后每条 Bash 都报
// "task output swap refused (tasks dir moved or linked)"。
export const TMP_ROOT = join(STATE_DIR, "tmp");
// 调用方没给 workdir 时的默认工作目录根。
export const WORK_ROOT = process.env.WORK_ROOT ?? join(APP_ROOT, "work");

export const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
export const HOME = process.env.HOME ?? APP_ROOT;

export const ADMIN_PUSH_URL = process.env.ADMIN_PUSH_URL ?? "https://jianshuo.dev/agent/push/admin";
