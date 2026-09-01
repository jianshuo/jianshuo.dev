// test/prices.test.js — GET /agent/usage/prices（公开价目表，各端一天拉一次）
import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { handleUsageRoute } from "../src/index.js";
import { BOOK_SUANLI, BOOK_REVISE_SUANLI, IMAGE_SUANLI, RATE } from "../src/usage.js";

const PATH = "/agent/usage/prices";
const call = (env = {}) =>
  handleUsageRoute(new URL("https://jianshuo.dev" + PATH), new Request("https://jianshuo.dev" + PATH), env);

describe("usage/prices", () => {
  it("免鉴权可取，返回和服务端常量一致的价目", async () => {
    const r = await call();                       // 无 token、无 USAGE 绑定也能答
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.book).toBe(BOOK_SUANLI);
    expect(body.book_revise).toBe(BOOK_REVISE_SUANLI);
    expect(body.image).toBe(IMAGE_SUANLI);
    expect(body.rate).toBe(RATE);
    expect(body.signup_grant).toBe(200);
    expect(typeof body.updated_at).toBe("number");
  });

  it("带一天的 max-age——客户端和边缘都只需一天拉一次", async () => {
    const r = await call();
    expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("写书价就是 160（前端兜底常量的对照）", async () => {
    expect((await (await call()).json()).book).toBe(160);
  });
});
