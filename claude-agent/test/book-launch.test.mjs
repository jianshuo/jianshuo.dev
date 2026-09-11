// 起单参数的单测（2026-09-11）。跑法：npm test。
// 钉的是「systemd-run 那条命令长什么样」：单元名合法且稳定（续跑/巡检/取消都按名找）、
// 用户管理器、跑完回收、环境文件、runner 拿到的是 inflight 文件路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { unitName, buildSystemdRunArgs } from "../dist/book-launch.js";

const create = {
  kind: "create", jobId: "8c396ef2-fded-454a-a7ff-2eebe5794bc2", seed: "嘟嘟", scope: "users/anon-ae209/",
  author: "王建硕", startedAt: 1788857670898, attempts: 1,
};
const revise = {
  kind: "revise", slug: "dudu-lighthouse", scope: "users/anon-ae209/", author: "王建硕",
  instruction: "把封面换掉", entryTs: 1788860000000, startedAt: 1788860000000, attempts: 1,
};

test("单元名：写书 book-<jobId>，修书 revise-<slug>-<ts>，不含 # 等 systemd 不认的字符", () => {
  assert.equal(unitName(create), "book-8c396ef2-fded-454a-a7ff-2eebe5794bc2");
  assert.equal(unitName(revise), "revise-dudu-lighthouse-1788860000000");
  for (const u of [unitName(create), unitName(revise)]) assert.match(u, /^[a-z0-9][a-z0-9-]*$/);
});

test("systemd-run 参数：--user、--collect、env 文件、runner 路径、inflight 文件路径", () => {
  const args = buildSystemdRunArgs(create, {
    node: "/usr/bin/node", runner: "/opt/claude-agent/dist/book-runner.js", envFile: "/opt/claude-agent/.env",
    appRoot: "/opt/claude-agent", inflightDir: "/opt/claude-agent/inflight",
  });
  assert.equal(args[0], "--user");
  assert.ok(args.includes("--unit=book-8c396ef2-fded-454a-a7ff-2eebe5794bc2"));
  assert.ok(args.includes("--collect"));
  assert.ok(args.includes("--property=EnvironmentFile=/opt/claude-agent/.env"));
  assert.ok(args.includes("--property=WorkingDirectory=/opt/claude-agent"));
  assert.ok(args.includes("--setenv=HOME=/opt/claude-agent"));
  // 命令行尾巴：node runner inflight.json——顺序固定，systemd-run 把第一个非选项当命令
  assert.deepEqual(args.slice(-3), [
    "/usr/bin/node",
    "/opt/claude-agent/dist/book-runner.js",
    "/opt/claude-agent/inflight/8c396ef2-fded-454a-a7ff-2eebe5794bc2.json",
  ]);
  // 所有选项都在命令之前（systemd-run 在命令之后的参数全归命令）
  const cmdIdx = args.indexOf("/usr/bin/node");
  assert.ok(args.slice(0, cmdIdx).every((a) => a.startsWith("--")));
});

test("修书单：inflight 文件名把 # 换成 __，与 inflight.ts 一致", () => {
  const args = buildSystemdRunArgs(revise, { inflightDir: "/x" });
  assert.equal(args.at(-1), "/x/dudu-lighthouse__1788860000000.json");
  assert.ok(args.includes("--unit=revise-dudu-lighthouse-1788860000000"));
});
