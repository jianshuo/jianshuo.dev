// src/spec.ts — server 与 runner 之间的文件协议。
//
// 一个 run = 若干次 attempt（换账号就是新的 attempt）。server 每次起 runner 前写一份
// runs/<id>.attempt-<n>.json（不含密钥，只有密钥的环境变量名），runner 跑完写
// runs/<id>.result-<n>.json 后退出；事件流统一追加到 runs/<id>.jsonl。
import type { EngineName } from "./config.js";

export type Capabilities = { shell?: boolean; network?: boolean; write?: boolean };

export type AttemptSpec = {
  runId: string;
  attempt: number;
  engine: EngineName;
  accountId: string;
  model: string;
  prompt: string; // 已拼好的最终 prompt（含交接摘要 / resume_hint）
  instructions?: string;
  resumeSession?: string; // 原生会话号：Claude session_id / Codex thread id
  firstTurn: boolean; // 本引擎会话的第一轮（codex 的 instructions 只在第一轮前置）
  workdir: string;
  contextDirs: string[]; // 参考资料目录（skill 等），只读
  cwd: string; // Claude 系的落脚目录（每个 thread 固定一个）
  env: Record<string, string>;
  capabilities: Capabilities;
  outputSchema?: unknown;
  maxTurns: number;
  timeoutMs: number;
};

export type AttemptResult = {
  ok: boolean;
  reply: string;
  error: string;
  sessionId: string;
  result?: unknown; // output_schema 的结构化结果
};

export type RunEvent =
  | { type: "queued"; reason?: string; eta?: number }
  | { type: "started"; attempt: number; account: string }
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary?: string }
  | { type: "switched"; from: string; reason: string }
  | { type: "done"; ok: boolean; reply?: string; result?: unknown; error?: string };
