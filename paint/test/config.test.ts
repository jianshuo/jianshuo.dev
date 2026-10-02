import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loadConfig reads values and derives dirs", () => {
  const cfg = loadConfig({
    API_TOKEN: "tok", CALLBACK_SIGNING_SECRET: "sec", DATA_DIR: "/tmp/paint-x",
  } as any);
  assert.equal(cfg.apiToken, "tok");
  assert.equal(cfg.callbackSigningSecret, "sec");
  assert.equal(cfg.jobsDir, "/tmp/paint-x/jobs");
  assert.equal(cfg.resultsDir, "/tmp/paint-x/results");
  assert.equal(cfg.inputsDir, "/tmp/paint-x/inputs");
  assert.equal(cfg.port, 8788);
  assert.equal(cfg.maxConcurrency, 3);
});

test("loadConfig throws when secrets missing", () => {
  assert.throws(() => loadConfig({} as any), /API_TOKEN/);
});

test("codexModels：缺省钉死候选序列，CODEX_MODELS 可覆盖", () => {
  const base = { API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s" };
  // 缺省第一个必须是实测能用的那个（2026-09-07 复测：mini 与 gpt-5.4 均可用，5.5/5.6 全拒）
  assert.equal(loadConfig(base as any).codexModels[0], "gpt-5.4-mini");
  assert.ok(loadConfig(base as any).codexModels.length >= 2);
  assert.deepEqual(
    loadConfig({ ...base, CODEX_MODELS: " a , b ,, c " } as any).codexModels,
    ["a", "b", "c"],
  );
  // 空串别把候选清成 0 个（那样一单都跑不了）
  assert.equal(loadConfig({ ...base, CODEX_MODELS: "  " } as any).codexModels[0], "gpt-5.4-mini");
});

test("seedream：缺省开、无 key 不可用；SEEDREAM_MODELS/SEEDREAM_FALLBACK 可覆盖", () => {
  const base = { API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s" };
  const d = loadConfig(base as any).seedream;
  assert.equal(d.enabled, true);
  assert.equal(d.apiKey, undefined);
  assert.equal(d.models[0], "doubao-seedream-5-0-pro-260628");
  assert.equal(d.minPixels, 921600);
  const c = loadConfig({ ...base, ARK_API_KEY: "k", SEEDREAM_MODELS: "x, y", SEEDREAM_FALLBACK: "off" } as any).seedream;
  assert.equal(c.apiKey, "k");
  assert.deepEqual(c.models, ["x", "y"]);
  assert.equal(c.enabled, false);
});
