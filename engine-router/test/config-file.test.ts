// 仓库里的 config.json 就是线上配置的真源（deploy.sh 原样同步过去）。写错了在这里拦住，
// 别等部署后 reload 失败才发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, limitsFor, policyFor, ENGINE_KIND } from "../src/config.ts";

const cfg = loadConfig(new URL("../config.json", import.meta.url).pathname);

test("config.json 能通过校验", () => {
  assert.ok(Object.keys(cfg.engines).length > 0);
});

test("引用都对得上：quota_from 指向存在的账号、策略 order 里的引擎都配了、每类引擎都有模型", () => {
  for (const [name, e] of Object.entries(cfg.engines)) {
    if (e!.quota_from) {
      const src = cfg.engines[e!.quota_from];
      assert.ok(src, `${name}.quota_from=${e!.quota_from} 没配`);
      for (const a of e!.accounts) assert.ok(src!.accounts.some((x) => x.id === a.id), `${name}/${a.id} 在 ${e!.quota_from} 里找不到同名账号`);
    }
    if ((name === "claude" || name === "codex" || name === "kimi") && e!.accounts.length) assert.ok(cfg.models[name], `${name} 没配 models`);
  }
  for (const [cls, p] of Object.entries(cfg.policies))
    for (const o of p.order ?? []) assert.ok(cfg.engines[o], `policies.${cls}.order 里的 ${o} 没配`);
});

test("密钥不进仓库：只能是环境变量名", () => {
  const text = JSON.stringify(cfg);
  assert.doesNotMatch(text, /sk-ant-|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}/);
  for (const e of Object.values(cfg.engines))
    for (const a of e!.accounts) {
      for (const k of ["token_env", "key_env"] as const) if (a[k]) assert.match(a[k]!, /^[A-Z][A-Z0-9_]*$/, `${a.id}.${k} 应是变量名`);
    }
});

test("出图优先 Codex、不配速；文字任务走周配速（2026-10-25 用户要求）", () => {
  const img = limitsFor(cfg, policyFor(cfg, "image", "image"));
  assert.equal(img.pacing, false);
  assert.deepEqual(policyFor(cfg, "image", "image").order, ["gpt-image", "seedream"]);
  assert.equal(limitsFor(cfg, policyFor(cfg, "book", "text")).pacing, true);
  assert.equal(ENGINE_KIND["gpt-image"], "image");
});
