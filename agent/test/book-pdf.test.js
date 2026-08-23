// test/book-pdf.test.js — GET /agent/books/pdf/<slug>（整本书 PDF：缓存直出/现生成/修书失效）
import { vi, describe, it, expect } from "vitest";
vi.mock("@cloudflare/puppeteer", () => ({
  default: {
    launch: vi.fn(async () => ({
      newPage: async () => ({
        goto: async () => {},
        pdf: async () => new TextEncoder().encode("%PDF-fake"),
      }),
      close: async () => {},
    })),
  },
}));
import puppeteer from "@cloudflare/puppeteer";
import { handleBookPdf } from "../src/book-pdf.js";

const PUB = "users/anon-ae209ac53499d51d513425503bd134b0/books/";

function fakeR2(objects = {}) {
  const store = new Map(Object.entries(objects));
  return {
    store,
    async head(key) {
      const o = store.get(key);
      return o ? { size: o.body.length, uploaded: o.uploaded } : null;
    },
    async get(key) {
      const o = store.get(key);
      return o
        ? { body: o.body, size: o.body.length, uploaded: o.uploaded, text: async () => new TextDecoder().decode(o.body) }
        : null;
    },
    async put(key, body) {
      store.set(key, { body: typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body), uploaded: new Date() });
    },
  };
}

const call = (env, slug, method = "GET") =>
  handleBookPdf(new URL(`https://jianshuo.dev/agent/books/pdf/${slug}`), new Request("https://x/", { method }), env);

const enc = (s) => ({ body: new TextEncoder().encode(s), uploaded: new Date("2026-08-01") });

describe("book-pdf", () => {
  it("路径不匹配 → null（让别的路由接）", async () => {
    const r = await handleBookPdf(new URL("https://jianshuo.dev/agent/other"), new Request("https://x/"), { FILES: fakeR2() });
    expect(r).toBeNull();
  });

  it("书不存在 → 404", async () => {
    const r = await call({ FILES: fakeR2() }, "nope");
    expect(r.status).toBe(404);
  });

  it("有新鲜缓存 → 直接回，不启动浏览器", async () => {
    puppeteer.launch.mockClear();
    const env = {
      FILES: fakeR2({
        [`${PUB}b1/index.html`]: enc("<title>书</title>"),
        ["books-pdf/b1.pdf"]: { body: new TextEncoder().encode("%PDF-cached"), uploaded: new Date("2026-08-10") },
        [`${PUB}b1/_src/book.json`]: enc(JSON.stringify({ title: "我的书" })),
      }),
    };
    const r = await call(env, "b1");
    expect(r.status).toBe(200);
    expect(puppeteer.launch).not.toHaveBeenCalled();
    expect(r.headers.get("Content-Disposition")).toContain(encodeURIComponent("我的书"));
  });

  it("书比缓存新（修书过）→ 重新渲染并覆盖缓存", async () => {
    puppeteer.launch.mockClear();
    const env = {
      BROWSER: {},
      FILES: fakeR2({
        [`${PUB}b2/index.html`]: { body: new TextEncoder().encode("x"), uploaded: new Date("2026-08-20") },
        ["books-pdf/b2.pdf"]: { body: new TextEncoder().encode("%PDF-old"), uploaded: new Date("2026-08-10") },
      }),
    };
    const r = await call(env, "b2");
    expect(r.status).toBe(200);
    expect(puppeteer.launch).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(env.FILES.store.get("books-pdf/b2.pdf").body)).toBe("%PDF-fake");
  });

  it("无缓存无 BROWSER 绑定 → 503 降级", async () => {
    const env = { FILES: fakeR2({ [`${PUB}b3/index.html`]: enc("x") }) };
    const r = await call(env, "b3");
    expect(r.status).toBe(503);
  });
});
