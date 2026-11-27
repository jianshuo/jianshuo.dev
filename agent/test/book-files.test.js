// test/book-files.test.js — GET /books/<slug>/?format=files：一本书由哪些文件组成。
// App「下载到本地」照这份清单原样镜像（动画版在 video/ 子目录里，一并带上）。
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { onRequest } from "../../functions/voicedrop/books/[[path]].js";
import { PUBLISHER } from "../../functions/lib/books-shelf.js";

function env() {
  const k = (p) => `${PUBLISHER}entropy/${p}`;
  return fakeEnv({
    [k("index.html")]: "<html>目录</html>",
    [k("intro.html")]: "<html>导读</html>",
    [k("01.html")]: "<html>一</html>",
    [k("02.html")]: "<html>二</html>",
    [k("cover.jpg")]: "JPEGDATA",
    [k("p01.jpg")]: "JPEG",
    [k("video/index.html")]: "<html>动画版</html>",
    [k("video/bundle.js")]: "js",
    [k("video/fonts/PuHui-Bold.woff2")]: "font",
    [k("_src/book.json")]: "{}",
    [k("_src/01.html")]: "源稿",
    [k("_src/bookmeta.json")]: "{}",
    [`${PUBLISHER}entropy-2/index.html`]: "别的书",
    [`${PUBLISHER}empty/_src/book.json`]: "{}",
  });
}
const get = (e, slug, q = "?format=files") =>
  onRequest({ request: new Request(`https://voicedrop.cn/books/${slug}/${q}`), env: e, params: { path: [slug] } });

describe("书的文件清单 ?format=files", () => {
  it("列出整本书的文件夹（含动画版子目录），源稿镜像只留 book.json，不串到前缀相同的别的书", async () => {
    const r = await get(env(), "entropy");
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.slug).toBe("entropy");
    expect(d.files.map((f) => f.path).sort()).toEqual([
      "01.html", "02.html", "_src/book.json", "cover.jpg", "index.html", "intro.html", "p01.jpg",
      "video/bundle.js", "video/fonts/PuHui-Bold.woff2", "video/index.html",
    ]);
    expect(d.files.find((f) => f.path === "cover.jpg").size).toBe(8);
    expect(d.bytes).toBe(d.files.reduce((n, f) => n + f.size, 0));
  });

  it("audio = 有「听本章」的章号：顶层、非目录、非导读的网页（动画版的 index.html 不算）", async () => {
    const d = await (await get(env(), "entropy")).json();
    expect(d.audio).toEqual(["01", "02"]);
  });

  it("没有目录页的不算一本书 → 404；不带 format 照旧是目录页", async () => {
    expect((await get(env(), "empty")).status).toBe(404);
    expect((await get(env(), "nope")).status).toBe(404);
    const html = await (await get(env(), "entropy", "")).text();
    expect(html).toContain("目录");
  });
});
