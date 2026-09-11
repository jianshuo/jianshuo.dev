// src/env.ts — web 进程与写书 runner 共用的路径/凭据配置（2026-09-11）。
//
// 两个进程都从同一份 .env 起（systemd EnvironmentFile），这里只是把「同一个
// 环境变量在两个入口各读一遍」收成一处，不含任何行为。
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** dist/ 所在目录（编译后 env.js 在 dist/ 下，所以 APP_ROOT = 上一级）。 */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = process.env.HOME ?? homedir();

export const WORKSPACE = process.env.WORKSPACE ?? join(APP_ROOT, "workspace");
export const MODEL = process.env.MODEL ?? "claude-opus-4-8";

// 写书引擎（codex）的独立凭据链与会话目录——server 的会话侧栏也要读它。
export const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
export const CODEX_HOME = process.env.CODEX_HOME ?? join(HOME, ".codex");

// 在飞登记目录：web 收单时落档，runner 跑完销档。见 src/inflight.ts。
export const INFLIGHT_DIR = process.env.INFLIGHT_DIR ?? join(APP_ROOT, "inflight");
// 老条目回退 + _unmatched 落档。
export const BOOKMETA_DIR = process.env.BOOKMETA_DIR ?? join(APP_ROOT, "bookmeta");
