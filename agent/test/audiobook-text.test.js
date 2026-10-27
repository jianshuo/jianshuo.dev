// 有声书 <stem>.txt：返回合成时实际念的原文（脚本优先，否则章节 HTML 自动编排），不触发合成。
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { onRequest } from "../../functions/voicedrop/books/audiobook/[[path]].js";

const PUB = "users/anon-ae209ac53499d51d513425503bd134b0/books/";
const call = (env, path) => onRequest({
  request: new Request(`https://voicedrop.cn/books/audiobook/${path}`), env,
  params: { path: path.split("/") }, waitUntil: () => { throw new Error("不该触发合成"); },
});

describe("有声书原文", () => {
  it("无脚本：从章节 HTML 编排出的原文，一段一行", async () => {
    const env = fakeEnv({ [`${PUB}b/01.html`]: "<h1>第一章 · 洗牌</h1><p>股价是<b>人</b>推出来的。</p><div class=\"plain\">说白了就是抢。</div>" });
    const r = await call(env, "b/01.txt");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("第一章。洗牌。\n股价是人推出来的。\n说白了就是抢。\n");
  });

  it("有脚本：以脚本为准，表演指令和音色行剥掉", async () => {
    const env = fakeEnv({
      [`${PUB}b/01.html`]: "<p>HTML 里的旧稿</p>",
      "audiobook/b/01.script.txt": "@voice A zh_x\n# 注释\n【慢一点】先别写代码。\n@A\n[笑]想清楚模拟的是人。",
    });
    expect(await (await call(env, "b/01.txt")).text()).toBe("先别写代码。\n想清楚模拟的是人。\n");
  });

  it("章不存在 → 404", async () => {
    expect((await call(fakeEnv({}), "b/09.txt")).status).toBe(404);
  });
});
