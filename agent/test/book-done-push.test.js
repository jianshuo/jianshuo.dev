// test/book-done-push.test.js — POST /agent/push/book-done（书写好了给主人发 APNs）
// lab 写书收尾时转发用户 bearer 调这里：谁的 token 就推给谁，link 用 voicedrop.cn
// 直链（绘本缺省 hidden 不上书架，跳书架会找不到书）。
import { vi, describe, it, expect, beforeEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
vi.mock("../src/push.js", () => ({ sendPush: vi.fn(async () => true) }));
import { sendPush } from "../src/push.js";
import { handleUsageRoute } from "../src/index.js";

const PATH = "/agent/push/book-done";
function call(env, { token, body } = {}) {
  const req = new Request("https://jianshuo.dev" + PATH, {
    method: "POST",
    headers: token ? { Authorization: "Bearer " + token } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleUsageRoute(new URL("https://jianshuo.dev" + PATH), req, env);
}

describe("push/book-done", () => {
  beforeEach(() => sendPush.mockClear());

  it("无 token → 401，不推", async () => {
    const r = await call({ SESSION_SECRET: "" }, { body: { slug: "a-book" } });
    expect(r.status).toBe(401);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("slug 不合法 → 400，不推", async () => {
    const r = await call({ SESSION_SECRET: "" },
      { token: "anon_owner_token_abcdefghijklmnop", body: { slug: "../etc", title: "x" } });
    expect(r.status).toBe(400);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it("合法请求 → 200 并按 scope 推送，link 是 voicedrop.cn 直链", async () => {
    const r = await call({ SESSION_SECRET: "" },
      { token: "anon_owner_token_abcdefghijklmnop", body: { slug: "my-book", title: "小书" } });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect(sendPush).toHaveBeenCalledTimes(1);
    const [, scope, msg] = sendPush.mock.calls[0];
    expect(scope).toBeTruthy();
    expect(msg.title).toBe("书写好了");
    expect(msg.body).toContain("《小书》");
    expect(msg.link).toBe("https://voicedrop.cn/books/my-book/");
  });

  it("没给书名也能推（兜底文案）", async () => {
    const r = await call({ SESSION_SECRET: "" },
      { token: "anon_owner_token_abcdefghijklmnop", body: { slug: "my-book" } });
    expect(r.status).toBe(200);
    expect(sendPush.mock.calls[0][2].body).toContain("你的书已经出炉");
  });
});
