// test/book-offline.test.js — 书页的 ?offline=1 版本（App「下载到本地」用）：
// 目录页不带 PDF / 动画版入口；章节页换成播同目录 mp3 的离线播放器，章节清单内联。
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { onRequest } from "../../functions/voicedrop/books/[[path]].js";
import { PUBLISHER } from "../../functions/lib/books-shelf.js";

const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
function env() {
  return fakeEnv({
    [`${PUBLISHER}entropy/index.html`]: page("<h1>熵</h1><a href=\"01.html\">一</a>"),
    [`${PUBLISHER}entropy/01.html`]: page("<article><p>第一章正文</p></article>"),
    [`${PUBLISHER}entropy/02.html`]: page("<article><p>第二章正文</p></article>"),
    [`${PUBLISHER}entropy/_src/book.json`]: JSON.stringify({ slug: "entropy", title: "熵", createdAt: 1, chapters: [
      { no: 1, title: "第一章 · </script>洗牌", status: "done" },
      { no: 2, title: "第二章 · 小妖", status: "done" },
      { no: 3, title: "第三章 · 没写完", status: "planned" },
    ] }),
    [`${PUBLISHER}old/01.html`]: page("<article><p>老书</p></article>"),
  });
}
const get = (e, path, q = "") =>
  onRequest({ request: new Request(`https://voicedrop.cn/books/${path}${q}`), env: e, params: { path: path.split("/") } });

describe("书页 ?offline=1", () => {
  it("章节页：离线播放器播同目录 mp3，不出现在线合成端点；章节清单内联且只含 done 的", async () => {
    const html = await (await get(env(), "entropy/01.html", "?offline=1")).text();
    expect(html).toContain("第一章正文");
    expect(html).toContain("a.src=stem+'.mp3'");
    expect(html).not.toContain("../audiobook/");
    expect(html).not.toContain("MediaSource");
    expect(html).toContain('"stem":"02"');
    expect(html).not.toContain("没写完");
    expect(html).toContain('var stem="01"');
  });

  it("章节标题里的 </script> 不会把内联脚本截断", async () => {
    const html = await (await get(env(), "entropy/01.html", "?offline=1")).text();
    const script = html.slice(html.lastIndexOf("<script>"));
    expect(script.match(/<\/script>/g).length).toBe(1);
    expect(script).toContain("\\u003c/script>洗牌");
  });

  it("老书没有 book.json：照样出离线播放器，章节清单为空（只播本章）", async () => {
    const html = await (await get(env(), "old/01.html", "?offline=1")).text();
    expect(html).toContain("chs=[]");
    expect(html).toContain("a.src=stem+'.mp3'");
  });

  it("目录页：离线版原样返回，不带 PDF / 动画版入口；在线版照旧带", async () => {
    const off = await (await get(env(), "entropy/index.html", "?offline=1")).text();
    expect(off).not.toContain("下载 PDF");
    expect(off).not.toContain("看动画版");
    expect(off).toContain('href="01.html"');
    const on = await (await get(env(), "entropy/index.html")).text();
    expect(on).toContain("下载 PDF");
  });

  it("不带 offline：章节页还是在线播放器", async () => {
    const html = await (await get(env(), "entropy/01.html")).text();
    expect(html).toContain("../audiobook/");
  });
});
