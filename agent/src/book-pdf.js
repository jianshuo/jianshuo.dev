// src/book-pdf.js — GET /agent/books/pdf/<slug>：整本书下载 PDF（2026-08-23）。
//
// 与有声书同款「一次生成、永久缓存」：R2 有 books-pdf/<slug>.pdf 且不老于书本身
// （对比书 index.html 的 uploaded 时间，修书后自动失效重生成）→ 直接回；没有 →
// Browser Rendering（env.BROWSER）渲染书页路由的 /print 视图 → 写 R2 → 回。
// /print 视图见 functions/voicedrop/books/[[path]].js；渲染 URL 用 pages.dev 域名
// —— Browser Rendering 抓自己 zone（jianshuo.dev）会撞 CF error 1042。
// 公开端点无鉴权（书本来就是公开的；hidden 书同直链逻辑）。
import puppeteer from "@cloudflare/puppeteer";

const PUB = "users/anon-ae209ac53499d51d513425503bd134b0/books/";
const PDF_PREFIX = "books-pdf/";

export async function handleBookPdf(url, request, env) {
  const m = /^\/agent\/books\/pdf\/([a-z0-9][a-z0-9-]{0,62})$/.exec(url.pathname);
  if (!m) return null;
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
  if (request.method !== "GET" && request.method !== "HEAD") return J({ error: "method" }, 405);
  const slug = m[1];
  if (!env.FILES) return J({ error: "degraded" }, 503);

  const idx = await env.FILES.head(`${PUB}${slug}/index.html`);
  if (!idx) return J({ error: "no-book" }, 404);

  const key = `${PDF_PREFIX}${slug}.pdf`;
  let head = await env.FILES.head(key);
  if (head && idx.uploaded && head.uploaded && idx.uploaded.getTime() > head.uploaded.getTime()) head = null; // 书比 PDF 新

  if (!head) {
    if (request.method === "HEAD") return new Response(null, { status: 404 });
    if (!env.BROWSER) return J({ error: "pdf-degraded" }, 503);
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.goto(`https://jianshuo-dev.pages.dev/voicedrop/books/${slug}/print`, {
        waitUntil: "networkidle0",
        timeout: 120000,
      });
      const pdf = await page.pdf({ format: "a4", printBackground: true, timeout: 120000 });
      await env.FILES.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
    } catch (e) {
      console.log("[book-pdf] render failed", slug, e && e.message);
      return J({ error: "render-failed" }, 502);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const obj = await env.FILES.get(key);
  if (!obj) return J({ error: "gone" }, 404);
  // 文件名用书名（中文 filename*），拿不到就用 slug
  let name = slug;
  try {
    const b = await env.FILES.get(`${PUB}${slug}/_src/book.json`);
    if (b) name = String(JSON.parse(await b.text())?.title || slug);
  } catch {}
  return new Response(request.method === "HEAD" ? null : obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.pdf`,
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
