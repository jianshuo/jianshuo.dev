// test/transfer.test.js — 算力转账：一个人把自己的算力转给另一个人。
//
// 与 mint（投币）的根本区别：投币是**铸币**，双方都凭空多出算力；转账是**搬运**，
// 总量不变，转出方少多少收款方就多多少。所以这里的铁律是「一分钱都不能凭空生灭」，
// 每个用例都同时断言两边。
import { describe, it, expect, beforeEach } from "vitest";
import { fakeD1, usageSql } from "./fakes.js";
import { ensureAccount, balanceUY, getLedger, transferCredits } from "../src/usage_store.js";
import { SIGNUP_GRANT_UY } from "../src/usage.js";

const SQL = usageSql();
const A = "users/anon-alice1/";
const B = "users/anon-bob222/";

let db;
beforeEach(async () => {
  db = fakeD1(SQL);
  await ensureAccount(db, A, 1);
  await ensureAccount(db, B, 1);
});

describe("transferCredits", () => {
  it("转出方扣多少，收款方就到账多少（总量不变）", async () => {
    await transferCredits(db, { id: "t1", fromSub: A, toSub: B, amountUY: 1000, expiresAt: 999999, now: 2 });
    expect(await balanceUY(db, A, 2)).toBe(SIGNUP_GRANT_UY - 1000);
    expect(await balanceUY(db, B, 2)).toBe(SIGNUP_GRANT_UY + 1000);
  });

  it("余额不够就整笔不动——绝不能扣得比有的少、却给收款方发满额", async () => {
    await expect(
      transferCredits(db, { id: "t2", fromSub: A, toSub: B, amountUY: SIGNUP_GRANT_UY + 1, expiresAt: 999999, now: 2 })
    ).rejects.toThrow(/insufficient/i);
    expect(await balanceUY(db, A, 2)).toBe(SIGNUP_GRANT_UY);
    expect(await balanceUY(db, B, 2)).toBe(SIGNUP_GRANT_UY);
  });

  it("两边各记一条流水：转出方 spend/transfer_out，收款方 grant/transfer_in，都带对方和备注", async () => {
    await transferCredits(db, { id: "t3", fromSub: A, toSub: B, amountUY: 1000, note: "谢谢", expiresAt: 999999, now: 2 });

    const out = (await getLedger(db, A, 10))[0];
    expect(out.kind).toBe("spend");
    expect(out.reason).toBe("transfer_out");
    expect(out.amount_uy).toBe(1000);
    expect(out.balance_uy).toBe(SIGNUP_GRANT_UY - 1000);
    expect(JSON.parse(out.detail)).toMatchObject({ to: B, transfer_id: "t3", note: "谢谢" });

    const inn = (await getLedger(db, B, 10))[0];
    expect(inn.kind).toBe("grant");
    expect(inn.reason).toBe("transfer_in");
    expect(inn.amount_uy).toBe(1000);
    expect(inn.balance_uy).toBe(SIGNUP_GRANT_UY + 1000);
    expect(JSON.parse(inn.detail)).toMatchObject({ from: A, transfer_id: "t3", note: "谢谢" });
  });

  it("account 的累计统计也跟着走：转出方 spent 增加，收款方 granted 增加", async () => {
    await transferCredits(db, { id: "t4", fromSub: A, toSub: B, amountUY: 1000, expiresAt: 999999, now: 2 });
    const a = db.prepare("SELECT spent_uy,balance_uy FROM account WHERE user_sub=?").bind(A).first();
    const b = db.prepare("SELECT granted_uy,balance_uy FROM account WHERE user_sub=?").bind(B).first();
    expect(a.spent_uy).toBe(1000);
    expect(a.balance_uy).toBe(SIGNUP_GRANT_UY - 1000);
    expect(b.granted_uy).toBe(SIGNUP_GRANT_UY + 1000);
    expect(b.balance_uy).toBe(SIGNUP_GRANT_UY + 1000);
  });

  it("同一个幂等键重复提交只动一次钱，第二次原样返回已有那笔", async () => {
    await transferCredits(db, { id: "same", fromSub: A, toSub: B, amountUY: 1000, expiresAt: 999999, now: 2 });
    const again = await transferCredits(db, { id: "same", fromSub: A, toSub: B, amountUY: 1000, expiresAt: 999999, now: 3 });

    expect(again.duplicate).toBe(true);
    expect(await balanceUY(db, A, 3)).toBe(SIGNUP_GRANT_UY - 1000);
    expect(await balanceUY(db, B, 3)).toBe(SIGNUP_GRANT_UY + 1000);
    expect((await getLedger(db, A, 10)).filter((r) => r.reason === "transfer_out").length).toBe(1);
  });
});
