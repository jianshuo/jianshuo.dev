// 有声书逐段合成：某一段被火山拒了（并发超限）要重试；实在不行必须让响应报错中断、不缓存，
// 绝不能正常收尾——否则客户端拿到一条 200、内容只有开头几秒的 mp3，分不出是残的。
// （2026-11-27：App「下载到本地」的《阴谋论是怎么长出来的》9 章都只有 4 秒。）
import { describe, it, expect, vi, afterEach } from "vitest";
import { fakeEnv } from "./fakes.js";
import { _synthesizeAll } from "../../functions/voicedrop/books/audiobook/[[path]].js";

const b64 = (s) => Buffer.from(s).toString("base64");
const okStream = (...parts) => new Response(parts.map((p) => JSON.stringify({ code: 0, data: b64(p) })).join("\n"));
const rejected = () => new Response(JSON.stringify({ code: 45000292, message: "quota exceeded for types: concurrency" }));
const segs = (n) => Array.from({ length: n }, (_, i) => ({ voice: "v", text: `第 ${i + 1} 段` }));

// 跑一遍合成：返回客户端读到的内容（或读的时候抛的错）和缓存里有没有。
async function run(responses, n = 3) {
  const fetchMock = vi.fn(async () => { const r = responses.shift(); return typeof r === "function" ? r() : r; });
  vi.stubGlobal("fetch", fetchMock);
  const env = { ...fakeEnv({}), VOLC_TTS_APPID: "a", VOLC_TTS_ACCESS_TOKEN: "t" };
  const { readable, writable } = new TransformStream();
  const done = _synthesizeAll(env, segs(n), writable.getWriter(), "audiobook/b/01.mp3", [0, 0, 0, 0]);
  let body = "", error = null;
  try { body = await new Response(readable).text(); } catch (e) { error = e; }
  await done;
  return { body, error, cached: env.FILES._store.get("audiobook/b/01.mp3"), calls: fetchMock.mock.calls.length };
}

afterEach(() => vi.unstubAllGlobals());

describe("有声书逐段合成", () => {
  it("全部顺利：客户端拿到完整音频，写进缓存", async () => {
    const r = await run([okStream("AA"), okStream("BB"), okStream("CC")]);
    expect(r.error).toBeNull();
    expect(r.body).toBe("AABBCC");
    expect(r.cached).toBeTruthy();
    expect(r.calls).toBe(3);
  });

  it("中间一段被并发上限拒了两次：重试后接上，音频完整、不重复、照常缓存", async () => {
    const r = await run([okStream("AA"), rejected(), rejected(), okStream("BB"), okStream("CC")]);
    expect(r.error).toBeNull();
    expect(r.body).toBe("AABBCC");
    expect(r.cached).toBeTruthy();
    expect(r.calls).toBe(5);
  });

  it("火山回 HTTP 错误也重试", async () => {
    const r = await run([() => new Response("busy", { status: 429 }), okStream("AA"), okStream("BB"), okStream("CC")]);
    expect(r.error).toBeNull();
    expect(r.body).toBe("AABBCC");
  });

  it("一直被拒：响应报错中断（不是正常结束的短文件），不缓存", async () => {
    const r = await run([okStream("AA"), rejected(), rejected(), rejected(), rejected(), rejected()]);
    expect(r.error).not.toBeNull();          // 流被中止（经 CDN 后客户端未必看得到，所以另靠「事后 HEAD 有成品」判完整）
    expect(r.cached).toBeUndefined();
    expect(r.calls).toBe(6);                 // 第 1 段 1 次 + 第 2 段 5 次
  });

  it("第一段就一直被拒：同样报错中断，而不是一个空的 200", async () => {
    const r = await run([rejected(), rejected(), rejected(), rejected(), rejected()]);
    expect(r.error).not.toBeNull();
    expect(r.cached).toBeUndefined();
  });

  it("一段出了一半才失败：不重试（重来就把半段念两遍），直接报错中断、不缓存", async () => {
    const half = () => new Response(JSON.stringify({ code: 0, data: b64("B") }) + "\n" + JSON.stringify({ code: 55000000, message: "server error" }));
    const r = await run([okStream("AA"), half, okStream("BB"), okStream("CC")]);
    expect(r.error).not.toBeNull();
    expect(r.cached).toBeUndefined();
    expect(r.calls).toBe(2);
  });
});
