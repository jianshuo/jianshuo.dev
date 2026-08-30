// src/claim.js — 一生一次领 320 算力（正好是写一本书的一口价 BOOK_SUANLI）。
//
// 设计定稿 2026-08-30（voicedrop repo docs/superpowers/specs/2026-08-30-book320-claim-design.md）：
//   • 零新表：领取事件就是 mint 表一行 kind='claim'，唯一索引
//     (kind,subject_key,actor_sub) 即「一人一生一次」的执行层——原子，
//     连点/并发/重放全挡住。写入顺序照抄 mint/referral 的铁律：先 INSERT OR
//     IGNORE 抢唯一键，changes===1 才付钱 ⇒ 绝无重复发放。
//   • mint 行的金额列必须全 0（正确性要求，不是偷懒）：币价分母 sumCoins7d 与
//     投币日熔断都是全表无 kind 过滤地 SUM 这几列，记真金额会把金币价格和熔断
//     一起打乱（320 算力≈13.9e6uy，31 个人领一次就烧掉 5×日池的闸线）。真实
//     发放额进 detail 做审计。
//   • 必须挂实名闸门：匿名身份是客户端自己生成随机串换来的，无闸门的白领 320
//     会拆掉「注册只送 200 < 一本书 320」这条既有防线（见 book-charge 注释），
//     脚本刷随机 token 就能无限白写书。绑过 Apple/微信之后，一次领取必须对应一个
//     真实身份；identities 表 first-write-wins、登录只读它找回既有 scope ⇒
//     同一个 Apple ID/微信号一辈子一个 scope ⇒「换手机再领一次」不成立。
//   • 钱走 grantBucket('campaign:book320')：账单页现成地归成「活动赠送」，App 零改动。

import { hasVerifiedBinding } from "../../functions/lib/auth.js";
import { grantBucket, balanceUY, ensureAccount } from "./usage_store.js";
import {
  BOOK_SUANLI, suanliToUY, uyToSuanli, CAMPAIGN_EXPIRE_DAYS, expiryAfterDays,
} from "./usage.js";

export const CLAIM_CAMPAIGN = "book320";        // mint.subject_key / ledger reason 后缀
export const CLAIM_SUANLI = BOOK_SUANLI;        // 领多少 = 一本书的成本，永远跟着涨价走

const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const r1 = (n) => Math.round(n * 10) / 10;

// 与投币/社区写门槛同一约定：安卓引导微信登录，其余引导 Apple 登录。
function signinRequiredError(request) {
  return request.headers.get("X-VD-Platform") === "android" ? "needs_wechat_signin" : "needs_apple_signin";
}

async function alreadyClaimed(db, scope) {
  const row = await db.prepare(
    "SELECT 1 AS ok FROM mint WHERE kind='claim' AND subject_key=? AND actor_sub=?"
  ).bind(CLAIM_CAMPAIGN, scope).first();
  return !!row;
}

// scope 由调用方（handleUsageRoute）解析好传进来——鉴权口径与 book-charge 一致。
export async function handleClaimRoute(url, request, env, scope) {
  if (!scope) return J({ error: "unauthorized" }, 401);
  if (!env.USAGE) return J({ error: "degraded" }, 503);
  const now = Date.now();

  // ── GET：按钮状态（不需要实名，没绑定就把理由告诉前端去弹登录）──────────
  if (request.method === "GET") {
    const claimed = await alreadyClaimed(env.USAGE, scope);
    const bound = await hasVerifiedBinding(env, scope);
    const bal = await ensureAccount(env.USAGE, scope, now);
    return J({
      campaign: CLAIM_CAMPAIGN,
      suanli: CLAIM_SUANLI,
      claimed,
      eligible: !claimed && bound,
      ...(claimed ? {} : bound ? {} : { reason: signinRequiredError(request) }),
      suanli_balance: r1(uyToSuanli(bal)),
    });
  }

  if (request.method !== "POST") return J({ error: "not-found" }, 404);

  if (!(await hasVerifiedBinding(env, scope))) return J({ error: signinRequiredError(request) }, 403);

  // 先抢唯一键，成功才付钱。抢不到 = 这辈子已经领过了。
  const ins = await env.USAGE.prepare(
    "INSERT OR IGNORE INTO mint (kind,subject_key,share_id,actor_sub,beneficiary_sub," +
    "coins_uc,price_uy,actor_uy,beneficiary_uy,detail,ts) VALUES ('claim',?,NULL,?,?,0,0,0,0,?,?)"
  ).bind(CLAIM_CAMPAIGN, scope, scope, JSON.stringify({ suanli: CLAIM_SUANLI }), now).run();

  if (!ins.meta || ins.meta.changes !== 1) {
    const bal = await ensureAccount(env.USAGE, scope, now);
    return J({ ok: true, already: true, granted_suanli: 0, suanli: r1(uyToSuanli(bal)) });
  }

  const expiresAt = expiryAfterDays(now, CAMPAIGN_EXPIRE_DAYS);
  await grantBucket(env.USAGE, scope, suanliToUY(CLAIM_SUANLI), "campaign:" + CLAIM_CAMPAIGN,
    expiresAt, now, { campaign: CLAIM_CAMPAIGN });
  const after = await balanceUY(env.USAGE, scope, now);
  return J({ ok: true, granted_suanli: CLAIM_SUANLI, suanli: r1(uyToSuanli(after)), expires_at: expiresAt });
}
