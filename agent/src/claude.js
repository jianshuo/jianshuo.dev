// The ONE place raw Anthropic Messages calls happen.
//
// Six call sites used to hand-roll their own fetch("https://api.anthropic.com/…")
// with drifting error handling / logging / usage accounting (the two DO classes,
// the /agent/style/extract route, generateArticles, moderateArticles and
// makeTaskClaude). They now compose the primitives here:
//   callClaudeRaw   — one HTTP call; never throws; {ok, status, json, errorText}
//   textOf          — join a response's text blocks
//   makeLoggedCall  — agent-loop caller: one llmlogs/ entry per HTTP call
//                     (grouped by turnId), best-effort 算力 debit, throws on
//                     failure (runAgentLoop's contract)
//   makeTextClaude  — plain text-completion caller for task handlers: optional
//                     llmlog, optional usage accumulator for one later debit

import { writeLlmLog } from "./llmlog.js";
import { claudeCostUY } from "./usage.js";
import { debit } from "./usage_store.js";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

// One Anthropic Messages call. Returns {ok, status, json, errorText} (never
// throws on HTTP/network errors) so callers can both log the exchange and
// decide how to proceed.
export async function callClaudeRaw(apiKey, reqBody) {
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, json: null, errorText: (await resp.text()).slice(0, 2000) };
    }
    return { ok: true, status: resp.status, json: await resp.json(), errorText: "" };
  } catch (e) {
    return { ok: false, status: 0, json: null, errorText: String((e && e.message) || e) };
  }
}

export function textOf(json) {
  return ((json && json.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

// Accumulate one response's usage counters onto `acc` (shape: the four
// *_tokens fields, all pre-initialised to 0 by the caller).
export function addUsage(acc, u) {
  if (!acc || !u) return;
  acc.input_tokens += u.input_tokens || 0;
  acc.output_tokens += u.output_tokens || 0;
  acc.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
}

// A logging callClaude for runAgentLoop: builds the request body, calls the
// API, records one llmlogs/ entry per HTTP call (grouped by turnId), debits the
// call's cost (best-effort — never breaks the edit), then returns the response
// JSON or throws (the loop's contract).
export function makeLoggedCall(env, { turnId, scope, stem, instruction, model }) {
  let step = 0;
  return async ({ system, messages, tools }) => {
    const reqBody = { model, max_tokens: 8000, system, messages, tools };
    // tool_choice:auto is only valid WITH tools. merge_articles calls callClaude
    // with no tools (pure text synthesis) — including it there → Anthropic 400.
    if (tools && tools.length) reqBody.tool_choice = { type: "auto" };
    const myStep = step++;
    const ts = Date.now();
    const r = await callClaudeRaw(env.CLAUDE_API_KEY, reqBody);
    await writeLlmLog(env, {
      ts, source: "agent", user_scope: scope, model,
      latency_ms: Date.now() - ts, http_status: r.status, ok: r.ok,
      turn_id: turnId, step: myStep, request: reqBody,
      response: r.ok ? r.json : undefined,
      error: r.ok ? undefined : r.errorText,
      meta: { stem, instruction },
    });
    try {
      if (env.USAGE) {
        const u = (r.json && r.json.usage) || {};
        await debit(env.USAGE, scope, claudeCostUY(model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
          "edit", { model, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, stem, turn_id: turnId }, Date.now());
      }
    } catch {}
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${(r.errorText || "").slice(0, 160)}`);
    return r.json;
  };
}

// Minimal text-completion caller (`claude({system,messages}) -> string`) for
// task handlers like distillStyle. `usage` (optional) accumulates token counts
// across calls so the caller can debit once at the end; `logMeta` (optional,
// {scope, meta}) writes one llmlogs/ entry per call.
export function makeTextClaude(env, { model, maxTokens = 1500, usage = null, logMeta = null }) {
  return async ({ system, messages }) => {
    const reqBody = { model, max_tokens: maxTokens, system, messages };
    const t0 = Date.now();
    const r = await callClaudeRaw(env.CLAUDE_API_KEY, reqBody);
    if (logMeta) {
      await writeLlmLog(env, {
        ts: t0, source: "agent", user_scope: logMeta.scope, model,
        latency_ms: Date.now() - t0, http_status: r.status, ok: r.ok,
        step: 0, request: reqBody, response: r.ok ? r.json : undefined,
        error: r.ok ? undefined : r.errorText,
        meta: logMeta.meta,
      });
    }
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}`);
    addUsage(usage, r.json.usage);
    return textOf(r.json);
  };
}
