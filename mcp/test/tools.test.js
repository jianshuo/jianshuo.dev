import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/tools.js";
import { VoiceDropError } from "../src/vd-client.js";

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// 假客户端：记下每次调用，按需给回值。
function fakeClient(responses = {}) {
  const calls = [];
  const make = (source) => async (method, path, opts) => {
    const key = `${source} ${method} ${Array.isArray(path) ? path.join("/") : path}`;
    calls.push({ source, method, path: Array.isArray(path) ? path.join("/") : path, ...opts });
    const r = responses[key];
    if (typeof r === "function") return r();
    if (r instanceof Error) throw r;
    return r ?? { ok: true };
  };
  return {
    calls,
    client: {
      files: make("files"), agent: make("agent"), reco: make("reco"),
      lab: make("lab"), books: make("books"),
    },
  };
}

const run = (name, args, responses) => {
  const { calls, client } = fakeClient(responses);
  return byName[name].handler(args, { client }).then((out) => ({ out, calls }), (e) => ({ err: e, calls }));
};

describe("工具表本身", () => {
  it("每个工具都有 name / description / inputSchema / handler", () => {
    for (const t of TOOLS) {
      expect(t.name, `${t.name} 缺字段`).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length, `${t.name} 描述太短`).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.handler).toBe("function");
    }
  });

  it("没有重名", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it("覆盖到了六大块能力", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of [
      "list_articles", "read_article", "write_article",      // 文章
      "read_style", "extract_style",                          // 文风
      "list_prompts", "share_prompt", "import_prompt",        // 提示词
      "trigger_mining", "restyle_article",                    // 挖矿
      "community_feed", "share_to_community", "feed_coin",    // 社区
      "credit_balance",                                       // 算力
      "publish_wechat", "share_link", "xhs_pack",             // 发布
      "list_books", "read_book_chapter", "write_book",        // 书
    ]) {
      expect(names, `少了 ${n}`).toContain(n);
    }
  });
});

describe("文章", () => {
  it("list_articles → GET files articles", async () => {
    const { calls } = await run("list_articles", {});
    expect(calls[0]).toMatchObject({ source: "files", method: "GET", path: "articles" });
  });

  it("read_article → GET files articles/<stem>，stem 单独成段（好被 URL 编码）", async () => {
    const { calls } = await run("read_article", { stem: "VoiceDrop-2026-07-13" });
    expect(calls[0].source).toBe("files");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("articles/VoiceDrop-2026-07-13");
  });

  it("write_article → PUT，body 带 articles 数组", async () => {
    const { calls } = await run("write_article", {
      stem: "s1",
      articles: [{ title: "标题", body: "正文" }],
    });
    expect(calls[0]).toMatchObject({ source: "files", method: "PUT", path: "articles/s1" });
    expect(calls[0].body).toEqual({ articles: [{ title: "标题", body: "正文" }] });
  });

  it("article_history → GET .../history", async () => {
    const { calls } = await run("article_history", { stem: "s1" });
    expect(calls[0].path).toBe("articles/s1/history");
  });

  it("set_article_version → PATCH .../head，只移指针不新增版本", async () => {
    const { calls } = await run("set_article_version", { stem: "s1", head: 2 });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "articles/s1/head" });
    expect(calls[0].body).toEqual({ head: 2 });
  });

  it("delete_article → DELETE", async () => {
    const { calls } = await run("delete_article", { stem: "s1" });
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "articles/s1" });
  });
});

describe("文风（新的 /style API，不再是 CLAUDE.md 文件）", () => {
  it("read_style → GET files style", async () => {
    const { calls } = await run("read_style", {});
    expect(calls[0]).toMatchObject({ source: "files", method: "GET", path: "style" });
  });

  it("write_style → PUT files style", async () => {
    const { calls } = await run("write_style", { style: "短句。单句成段。" });
    expect(calls[0]).toMatchObject({ source: "files", method: "PUT", path: "style" });
    expect(calls[0].body).toEqual({ style: "短句。单句成段。" });
  });

  it("write_style 可以同时改名字", async () => {
    const { calls } = await run("write_style", { style: "x", name: "王建硕" });
    expect(calls[0].body).toEqual({ style: "x", name: "王建硕" });
  });

  it("set_style_version → PATCH style/head", async () => {
    const { calls } = await run("set_style_version", { head: 3 });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: "style/head" });
  });

  it("collect_style_sample → POST style/collect", async () => {
    const { calls } = await run("collect_style_sample", { text: "样本正文" });
    expect(calls[0]).toMatchObject({ source: "files", method: "POST", path: "style/collect" });
    expect(calls[0].body).toMatchObject({ text: "样本正文" });
  });

  it("list_style_dataset → GET style/dataset", async () => {
    const { calls } = await run("list_style_dataset", {});
    expect(calls[0].path).toBe("style/dataset");
  });

  it("extract_style → POST agent style/extract（服务端蒸馏，不是本地手搓）", async () => {
    const { calls } = await run("extract_style", {});
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "style/extract" });
  });
});

describe("提示词分享", () => {
  it("list_prompts → GET agent prompts（解析后的树，拿 id 用）", async () => {
    const { calls } = await run("list_prompts", {});
    expect(calls[0]).toMatchObject({ source: "agent", method: "GET", path: "prompts" });
  });

  it("share_prompt → POST agent prompt-share，body 带 {id}", async () => {
    const { calls } = await run("share_prompt", { id: "sys_polish" });
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "prompt-share" });
    expect(calls[0].body).toEqual({ id: "sys_polish" });
  });

  it("unshare_prompt → DELETE agent prompt-share/<id>，id 单独成段（好被 URL 编码）", async () => {
    const { calls } = await run("unshare_prompt", { id: "p_ab12cd34" });
    expect(calls[0]).toMatchObject({ source: "agent", method: "DELETE" });
    expect(calls[0].path).toBe("prompt-share/p_ab12cd34");
  });

  it("prompt_share_status → GET agent prompt-shares", async () => {
    const { calls } = await run("prompt_share_status", {});
    expect(calls[0]).toMatchObject({ source: "agent", method: "GET", path: "prompt-shares" });
  });

  it("preview_prompt_share → GET agent prompt-share/<code>（公开预览）", async () => {
    const { calls } = await run("preview_prompt_share", { code: "4563566" });
    expect(calls[0]).toMatchObject({ source: "agent", method: "GET" });
    expect(calls[0].path).toBe("prompt-share/4563566");
  });

  it("import_prompt → POST agent prompts/import，body 带 {code}", async () => {
    const { calls } = await run("import_prompt", { code: "4563566" });
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "prompts/import" });
    expect(calls[0].body).toEqual({ code: "4563566" });
  });
});

describe("挖矿", () => {
  it("trigger_mining → POST agent mine/trigger", async () => {
    const { calls } = await run("trigger_mining", {});
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "mine/trigger" });
  });

  it("restyle_article → POST agent restyle，可指定风格版本", async () => {
    const { calls } = await run("restyle_article", { stem: "s1", styleV: 2 });
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "restyle" });
    expect(calls[0].body).toEqual({ stem: "s1", styleV: 2 });
  });

  it("restyle_article 不给 styleV 时用当前风格 head", async () => {
    const { calls } = await run("restyle_article", { stem: "s1" });
    expect(calls[0].body).toEqual({ stem: "s1" });
  });
});

describe("社区", () => {
  it("community_feed → GET reco feed（新的合一端点）", async () => {
    const { calls, out } = await run("community_feed", {}, {
      "reco GET feed": { posts: [{ shareId: "abc", title: "t" }], order: ["abc"] },
    });
    expect(calls[0]).toMatchObject({ source: "reco", method: "GET", path: "feed" });
    expect(out.posts).toHaveLength(1);
  });

  it("reco 401 时回退到 files community/list —— reco 没配 SESSION_SECRET，只认 anon token，Apple JWT 会被拒", async () => {
    const { calls, out } = await run("community_feed", {}, {
      "reco GET feed": new VoiceDropError("unauthorized", 401, {}),
      "files GET community/list": { posts: [{ shareId: "x", title: "回退来的" }] },
    });

    expect(calls.map((c) => c.source)).toEqual(["reco", "files"]);
    expect(out.posts[0].title).toBe("回退来的");
    expect(out.fallback).toBe(true);
  });

  it("reco 503（D1 挂了）也回退", async () => {
    const { calls } = await run("community_feed", {}, {
      "reco GET feed": new VoiceDropError("no d1", 503, {}),
      "files GET community/list": { posts: [] },
    });
    expect(calls.map((c) => c.source)).toEqual(["reco", "files"]);
  });

  it("reco 500 不回退——那是真故障，应该报出来而不是悄悄降级", async () => {
    const { err } = await run("community_feed", {}, {
      "reco GET feed": new VoiceDropError("boom", 500, {}),
    });
    expect(err.status).toBe(500);
  });

  it("read_community_post → GET files community/get/<shareId>", async () => {
    const { calls } = await run("read_community_post", { shareId: "Ab3xK9_p2Qzz" });
    expect(calls[0].path).toBe("community/get/Ab3xK9_p2Qzz");
  });

  it("community_replies → GET files community/replies/<shareId>", async () => {
    const { calls } = await run("community_replies", { shareId: "abc" });
    expect(calls[0].path).toBe("community/replies/abc");
  });

  it("share_to_community → POST community/share/articles/<stem>.json", async () => {
    const { calls } = await run("share_to_community", { stem: "s1" });
    expect(calls[0]).toMatchObject({ source: "files", method: "POST" });
    expect(calls[0].path).toBe("community/share/articles/s1.json");
  });

  it("share_to_community 带 replyTo 就是发回复（社区是一层扁平线程）", async () => {
    const { calls } = await run("share_to_community", { stem: "s1", replyTo: "parent123456" });
    expect(calls[0].body).toEqual({ replyTo: "parent123456" });
  });

  it("unshare_from_community → POST community/unshare/<shareId>", async () => {
    const { calls } = await run("unshare_from_community", { shareId: "abc" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "community/unshare/abc" });
  });

  it("feed_coin → POST agent feed（投币，作者和投币人都拿算力）", async () => {
    const { calls } = await run("feed_coin", { shareId: "abc" });
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "feed" });
    expect(calls[0].body).toEqual({ share_id: "abc" });
  });
});

describe("算力", () => {
  it("credit_balance → GET agent usage/balance", async () => {
    const { calls } = await run("credit_balance", {});
    expect(calls[0]).toMatchObject({ source: "agent", method: "GET", path: "usage/balance" });
  });

  it("credit_ledger → GET agent usage/ledger，limit 走 query", async () => {
    const { calls } = await run("credit_ledger", { limit: 20 });
    expect(calls[0].path).toBe("usage/ledger");
    expect(calls[0].query).toEqual({ limit: 20, before: undefined });
  });

  it("credit_summary → GET agent usage/summary", async () => {
    const { calls } = await run("credit_summary", {});
    expect(calls[0].path).toBe("usage/summary");
  });
});

describe("发布", () => {
  it("share_link → GET files share/articles/<stem>.json", async () => {
    const { calls } = await run("share_link", { stem: "s1" });
    expect(calls[0].path).toBe("share/articles/s1.json");
  });

  it("publish_wechat → POST files wechat/articles/<stem>.json", async () => {
    const { calls } = await run("publish_wechat", { stem: "s1" });
    expect(calls[0]).toMatchObject({ source: "files", method: "POST" });
    expect(calls[0].path).toBe("wechat/articles/s1.json");
  });

  it("xhs_pack → POST agent xhs-pack", async () => {
    const { calls } = await run("xhs_pack", { stem: "s1" });
    expect(calls[0]).toMatchObject({ source: "agent", method: "POST", path: "xhs-pack" });
    expect(calls[0].body).toEqual({ stem: "s1" });
  });
});

describe("书", () => {
  it("list_books → GET books 索引（format=json），只留模型用得上的字段并补阅读 URL", async () => {
    const { calls, out } = await run("list_books", {}, {
      "books GET ": {
        books: [{
          slug: "s-book", title: "书名", main: "书名", sub: "", c: "#111", c2: "#222",
          author: "王建硕", category: "商业", cover: true, coverAt: 123, chapters: 8, createdAt: 456,
        }],
      },
    });
    expect(calls[0]).toMatchObject({ source: "books", method: "GET", path: "" });
    expect(calls[0].query).toEqual({ format: "json" });
    expect(out.count).toBe(1);
    expect(out.books[0]).toEqual({
      slug: "s-book", title: "书名", author: "王建硕", category: "商业",
      chapters: 8, cover: true, createdAt: 456, url: "https://voicedrop.cn/books/s-book/",
    });
  });

  it("read_book 优先读 _src/book.json（含每章 brief/status），章号补零成两位", async () => {
    const { calls, out } = await run("read_book", { slug: "s-book" }, {
      "books GET s-book/_src/book.json": {
        title: "书名", subtitle: "副题", tagline: "一句话", type: "novel",
        chapters: [{ no: 1, title: "第一章", brief: "梗概", status: "done" }],
      },
    });
    expect(calls[0].path).toBe("s-book/_src/book.json");
    expect(out.title).toBe("书名");
    expect(out.chapters).toEqual([{ chapter: "01", title: "第一章", brief: "梗概", status: "done" }]);
    expect(out.url).toBe("https://voicedrop.cn/books/s-book/");
  });

  it("read_book 老书没有 _src/book.json（404）→ 从 index.html 抠标题和章节链接", async () => {
    const { calls, out } = await run("read_book", { slug: "old-book" }, {
      "books GET old-book/_src/book.json": new VoiceDropError("不存在（404）", 404, {}),
      "books GET old-book/index.html":
        '<html><title>老书 · 副题</title><a href="intro.html">序</a>' +
        '<a href="01.html">一</a><a href="02.html">二</a><a href="01.html">重复</a></html>',
    });
    expect(calls.map((c) => c.path)).toEqual(["old-book/_src/book.json", "old-book/index.html"]);
    expect(out.title).toBe("老书 · 副题");
    expect(out.chapters).toEqual([{ chapter: "01" }, { chapter: "02" }]);
  });

  it("read_book 非 404 的错误不吞——那是真故障", async () => {
    const { err } = await run("read_book", { slug: "s" }, {
      "books GET s/_src/book.json": new VoiceDropError("boom", 500, {}),
    });
    expect(err.status).toBe(500);
  });

  it("read_book_chapter → GET <slug>/<NN>.html，HTML 剥成纯文本，注入的播放器一并摘掉", async () => {
    const { calls, out } = await run("read_book_chapter", { slug: "s-book", chapter: "01" }, {
      "books GET s-book/01.html":
        "<html><style>b{}</style><h1>第一章</h1><p>正文&amp;第一段。</p>" +
        '<div id="abw"><button>🎧 听本章</button></div><script>var x=1;</script></html>',
    });
    expect(calls[0]).toMatchObject({ source: "books", method: "GET", path: "s-book/01.html" });
    expect(out.text).toBe("第一章\n正文&第一段。");
    expect(out.url).toBe("https://voicedrop.cn/books/s-book/01.html");
  });

  it("read_book_chapter 容忍单位数章号：1 → 01；intro 原样", async () => {
    const a = await run("read_book_chapter", { slug: "s", chapter: "1" }, { "books GET s/01.html": "<p>x</p>" });
    expect(a.calls[0].path).toBe("s/01.html");
    const b = await run("read_book_chapter", { slug: "s", chapter: "intro" }, { "books GET s/intro.html": "<p>x</p>" });
    expect(b.calls[0].path).toBe("s/intro.html");
  });

  it("write_book → POST lab book，body 带 {seed}，回执附下一步指引", async () => {
    const { calls, out } = await run("write_book", { seed: "讲清楚复利" }, {
      "lab POST book": { ok: true, slug: "compound-interest" },
    });
    expect(calls[0]).toMatchObject({ source: "lab", method: "POST", path: "book" });
    expect(calls[0].body).toEqual({ seed: "讲清楚复利" });
    expect(out.slug).toBe("compound-interest");
    expect(out.next).toContain("book_history");
  });

  it("revise_book → POST lab book/revise，body 带 {slug, instruction}", async () => {
    const { calls } = await run("revise_book", { slug: "s-book", instruction: "第三章砍一半" });
    expect(calls[0]).toMatchObject({ source: "lab", method: "POST", path: "book/revise" });
    expect(calls[0].body).toEqual({ slug: "s-book", instruction: "第三章砍一半" });
  });

  it("book_history → GET lab book/history，slug 走 query", async () => {
    const { calls } = await run("book_history", { slug: "s-book" });
    expect(calls[0]).toMatchObject({ source: "lab", method: "GET", path: "book/history" });
    expect(calls[0].query).toEqual({ slug: "s-book" });
  });
});

describe("媒体与身份", () => {
  it("whoami → GET files whoami", async () => {
    const { calls } = await run("whoami", {});
    expect(calls[0].path).toBe("whoami");
  });

  it("list_files 默认列全部", async () => {
    const { calls } = await run("list_files", {}, { "files GET list": { files: [] } });
    expect(calls[0]).toMatchObject({ source: "files", method: "GET", path: "list" });
  });

  it("list_files kind=photos 只留照片", async () => {
    const { out } = await run("list_files", { kind: "photos" }, {
      "files GET list": {
        files: [
          { name: "photos/2026/1-a.jpg", size: 1 },
          { name: "VoiceDrop-x.m4a", size: 2 },
          { name: "CLAUDE.md", size: 3 },
        ],
      },
    });
    expect(out.files.map((f) => f.name)).toEqual(["photos/2026/1-a.jpg"]);
  });

  it("list_files kind=audio 只留录音", async () => {
    const { out } = await run("list_files", { kind: "audio" }, {
      "files GET list": {
        files: [{ name: "photos/a.jpg" }, { name: "VoiceDrop-x.m4a" }],
      },
    });
    expect(out.files.map((f) => f.name)).toEqual(["VoiceDrop-x.m4a"]);
  });

  it("photo_url 是纯计算，不打网络——拼出公开可访问的图片 URL", async () => {
    const { out, calls } = await run("photo_url", {
      owner: "users/anon-abc/",
      key: "photos/2026-07-13-120000/5-x9q.jpg",
    });

    expect(calls).toHaveLength(0);
    expect(out).toBe("https://jianshuo.dev/files/api/photo/users/anon-abc/photos/2026-07-13-120000/5-x9q.jpg");
  });

  it("photo_url 容忍 owner 末尾没有斜杠", async () => {
    const { out } = await run("photo_url", { owner: "users/anon-abc", key: "photos/a.jpg" });
    expect(out).toBe("https://jianshuo.dev/files/api/photo/users/anon-abc/photos/a.jpg");
  });
});
