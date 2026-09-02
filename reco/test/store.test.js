import { describe, it, expect, beforeEach } from "vitest";
import { recordEngagement, countsFor, likedBy, rebuildCounts, __resetStoreCaches } from "../src/store.js";
import { fakeD1 } from "./fakes.js";

beforeEach(() => __resetStoreCaches());   // 进程内缓存别把上个用例的数据带过来

describe("recordEngagement", () => {
  it("view 重复只计一次(幂等)", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "view", undefined, 100);
    await recordEngagement(env, "s1", "u1", "view", undefined, 200);
    const c = await countsFor(env, ["s1"]);
    expect(c.s1.view).toBe(1);
  });

  it("不同用户的 view 各计一次", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "view", undefined, 100);
    await recordEngagement(env, "s1", "u2", "view", undefined, 100);
    const c = await countsFor(env, ["s1"]);
    expect(c.s1.view).toBe(2);
  });

  it("like on=true 计入,on=false 删除", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    expect((await countsFor(env, ["s1"])).s1.like).toBe(1);
    await recordEngagement(env, "s1", "u1", "like", false, 100);
    expect((await countsFor(env, ["s1"])).s1?.like || 0).toBe(0);
  });

  it("report 记录且按用户去重(重复举报只计一次)", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "report", undefined, 100);
    await recordEngagement(env, "s1", "u1", "report", undefined, 200);
    expect((await countsFor(env, ["s1"])).s1.report).toBe(1);
  });

  it("不同用户的 report 各计一次", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "report", undefined, 100);
    await recordEngagement(env, "s1", "u2", "report", undefined, 100);
    expect((await countsFor(env, ["s1"])).s1.report).toBe(2);
  });
});

describe("likedBy", () => {
  it("只返回该用户赞过的 shareId", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    await recordEngagement(env, "s2", "u2", "like", true, 100);
    const liked = await likedBy(env, "u1", ["s1", "s2"]);
    expect([...liked]).toEqual(["s1"]);
  });
});

// ── engagement_counts 计数表（2026-09-02 读放大根治）─────────────────────────
// 这里守的是唯一一条真不变量：计数表与 engagement 必须对得上,对不上要能自愈。
function countsRows(env) {
  return env.DB._db.prepare("SELECT share_id, action, c FROM engagement_counts ORDER BY share_id, action").all();
}
function trueCounts(env) {
  return env.DB._db.prepare(
    "SELECT share_id, action, COUNT(*) AS c FROM engagement GROUP BY share_id, action ORDER BY share_id, action",
  ).all();
}

describe("engagement_counts", () => {
  it("增删之后计数表与 engagement 全量聚合逐行一致", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "view", undefined, 100);
    await recordEngagement(env, "s1", "u1", "view", undefined, 200);   // 幂等,不重复计
    await recordEngagement(env, "s1", "u2", "view", undefined, 100);
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    await recordEngagement(env, "s2", "u1", "like", true, 100);
    await recordEngagement(env, "s2", "u1", "like", false, 100);       // 取消赞
    await recordEngagement(env, "s3", "u1", "report", undefined, 100);
    expect(countsRows(env).filter((r) => r.c > 0)).toEqual(trueCounts(env));
  });

  it("重复取消赞不会把计数减成负数", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    await recordEngagement(env, "s1", "u1", "like", false, 100);
    await recordEngagement(env, "s1", "u1", "like", false, 200);
    const like = countsRows(env).find((r) => r.share_id === "s1" && r.action === "like");
    expect(like.c).toBe(0);
    expect((await countsFor(env, ["s1"])).s1?.like || 0).toBe(0);
  });

  it("countsFor 读计数表而非全表聚合——绕过写路径灌进去的行不会被看见", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    // 直接写 engagement（模拟跨 isolate 竞态 / 部署缝隙造成的漂移）
    env.DB._db.prepare("INSERT INTO engagement VALUES ('s1','u9','like',100)").run();
    __resetStoreCaches();
    expect((await countsFor(env, ["s1"])).s1.like).toBe(1);   // 仍是计数表里的旧值
  });

  it("rebuildCounts 把漂掉的账抹平（每日 cron 的兜底）", async () => {
    const env = fakeD1();
    await recordEngagement(env, "s1", "u1", "like", true, 100);
    env.DB._db.prepare("INSERT INTO engagement VALUES ('s1','u9','like',100)").run();
    env.DB._db.prepare("UPDATE engagement_counts SET c=99 WHERE share_id='s1'").run();
    await rebuildCounts(env);
    expect(countsRows(env)).toEqual(trueCounts(env));
    expect((await countsFor(env, ["s1"])).s1.like).toBe(2);
  });

  it("存量回填：迁移把已有 engagement 行算进计数表（老库升级路径）", async () => {
    const env = fakeD1([
      { share_id: "old", user_sub: "u1", action: "like", created_at: 1 },
      { share_id: "old", user_sub: "u2", action: "like", created_at: 1 },
      { share_id: "old", user_sub: "u1", action: "view", created_at: 1 },
    ]);
    expect((await countsFor(env, ["old"])).old).toEqual({ like: 2, view: 1 });
  });
});
