// 风格数据集（语料）的 R2 侧操作 — the env-touching half of style extraction.
// style-extract.js stays pure (distill prompt + intro-article builder); this
// module owns reading / clearing the corpus and the one-shot 算力 debit, shared
// by the sync route (POST /agent/style/extract in index.js) and the miner task
// flow (mineStyleExtract in miner.js) so the two paths cannot drift.

import { listAll, deleteAll } from "./r2.js";
import { claudeCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";

// Load every usable sample under users/<sub>/style/ (skips empty/corrupt ones).
export async function loadStyleSamples(env, scope) {
  const samples = [];
  for (const o of await listAll(env.FILES, `${scope}style/`)) {
    const obj = await env.FILES.get(o.key);
    const s = obj && await obj.json().catch(() => null);
    if (s && (s.text || "").trim()) samples.push(s);
  }
  return samples;
}

// Drop the consumed corpus: the collected samples AND the raw shared files.
// Best-effort — a cleanup failure must never fail the extraction.
export async function clearStyleCorpus(env, scope) {
  try {
    await deleteAll(env.FILES, [`${scope}style/`, `${scope}VoiceDrop-style-`]);
  } catch (_) {}
}

// One debit for the whole extraction (usage accumulated across distillStyle's
// Claude calls). Best-effort: billing never blocks or fails the caller.
export async function debitStyleExtract(env, scope, model, usage, sampleCount) {
  try {
    if (env.USAGE) {
      await ensureAccount(env.USAGE, scope, Date.now());
      const cost = claudeCostUY(model, usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
      await debit(env.USAGE, scope, cost, "style-extract", { samples: sampleCount }, Date.now());
    }
  } catch (_) {}
}

export const emptyUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
