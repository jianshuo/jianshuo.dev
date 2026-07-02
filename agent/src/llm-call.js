// ── The ONE place an LLM HTTP call happens and gets logged ────────────────────
// Every production LLM call (editor agent, mining/restyle, style-extract ×2,
// moderation) goes through callLlm: it does the fetch (Anthropic or
// openai-compat), times it, captures the error body, redacts image payloads, and
// writes ONE canonical llmlogs/ record. Centralized because per-call-site copies
// failed twice: makeTaskClaude shipped with no logging at all (提取风格 failures
// were undiagnosable), and mineVariant's copy logged `status`/`meta.user_scope`
// where admin/llm.html reads `http_status`/`user_scope` (mine rows showed
// HTTP undefined and no user).
//
// Canonical record shape (what admin/llm.html renders):
//   { ts, source, user_scope, model, latency_ms, http_status, ok,
//     turn_id?, step?, request (images redacted), response? (ok only),
//     error? (!ok, first 2000 chars), meta? }
//
// Deliberately NOT in here:
//   - throwing: returns {ok:false,...} on HTTP/network/parse failure so each
//     caller keeps its own error semantics (throw / fail-open / retry).
//   - billing: per-call debit (edit/mine) vs accumulate-then-debit-on-success
//     (style-extract, so a failed extraction costs the user nothing) is a policy
//     decision per feature — callers debit from the returned `usage`.
//   - retry policy (mine's force pass) and response parsing — domain logic.

import { writeLlmLog } from "./llmlog.js";

// A log-friendly copy of the request body: image base64 can be megabytes, so swap
// it for a tiny placeholder (the llmlog R2 object must stay small). Everything else
// is kept verbatim so admin/llm.html can replay model / system / messages / tools.
export function redactReqForLog(payload) {
  const tag = (s) => `[base64 image · ~${Math.round((String(s).length * 3) / 4 / 1024)}KB elided]`;
  const req = { ...payload };
  if (Array.isArray(req.messages)) {
    req.messages = req.messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      return { ...m, content: m.content.map((b) => {
        if (b?.type === "image" && b.source?.data) return { ...b, source: { ...b.source, data: tag(b.source.data) } };
        if (b?.type === "image_url" && b.image_url?.url) return { ...b, image_url: { ...b.image_url, url: tag(b.image_url.url) } };
        return b;
      }) };
    });
  }
  return req;
}

// opts:
//   payload   — full request body (model, max_tokens, system, messages, tools…)
//   provider  — "anthropic" (default) | "openai-compat"
//   baseUrl   — openai-compat endpoint base (…/chat/completions is appended)
//   apiKey    — defaults to env.CLAUDE_API_KEY for anthropic
//   source    — "agent" | "mine" (who is calling, shown in admin)
//   scope     — users/<sub>/ → user_scope on the record
//   turnId/step — group multi-call turns in admin (editor agent, force retry)
//   meta      — extra context on the record (e.g. {stem}, {kind:"style-extract"})
// Returns { ok, status, json, text, usage, errorText, latencyMs }. `text` is the
// concatenated text output for either provider; `usage` is the provider's raw
// usage object (null when the call failed).
export async function callLlm(env, {
  provider = "anthropic", baseUrl, apiKey,
  payload, source, scope, turnId, step, meta,
}) {
  const compat = provider === "openai-compat";
  const url = compat ? `${baseUrl}/chat/completions` : "https://api.anthropic.com/v1/messages";
  const headers = compat
    ? { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }
    : { "x-api-key": apiKey ?? env.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const t0 = Date.now();
  let status = 0, ok = false, json = null, errorText = "";
  try {
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    status = resp.status;
    if (resp.ok) { json = await resp.json(); ok = true; }   // ok only after body parses
    else errorText = (await resp.text().catch(() => "")).slice(0, 2000);
  } catch (e) {
    errorText = String((e && e.message) || e);   // network throw or 200-with-bad-json
  }
  const latencyMs = Date.now() - t0;
  const rec = {
    ts: t0, source, user_scope: scope, model: payload.model,
    latency_ms: latencyMs, http_status: status, ok,
    request: redactReqForLog(payload),
    response: ok ? json : undefined,
    error: ok ? undefined : errorText,
  };
  if (turnId != null) rec.turn_id = turnId;
  if (step != null) rec.step = step;
  if (meta != null) rec.meta = meta;
  await writeLlmLog(env, rec);   // best-effort, swallows its own errors
  const text = !json ? "" : compat
    ? (json.choices?.[0]?.message?.content || "")
    : (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { ok, status, json, text, usage: json?.usage || null, errorText, latencyMs };
}
