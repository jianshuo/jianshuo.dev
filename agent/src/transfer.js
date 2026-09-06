// src/transfer.js — 用户之间的算力转账：POST /agent/usage/transfer
//
// 花自己的钱可以匿名（挖矿、写书都不问你是谁），把钱转给别人不行——转出方必须是
// 可追责身份。闸门口径与投币（mint.js）**逐字一致**：实名 session（Apple 或 WeChat），
// 或绑过实名的匿名 scope（hasVerifiedBinding，MCP 配对 token 由此放行）。同一条规则
// 出现两处，行为必须完全一样，否则「哪些操作需要实名」会变成一笔糊涂账。
//
// 收款方不需要实名：只有花钱的一方要可追责。
import { verifySession, anonScopeFromToken, bearerToken, hasVerifiedBinding } from "../../functions/lib/auth.js";
import { transferCredits, balanceUY } from "./usage_store.js";
import { sendPush } from "./push.js";
import {
  suanliToUY, uyToSuanli, DAY_MS,
  TRANSFER_MIN_SUANLI, TRANSFER_MAX_SUANLI, TRANSFER_DAILY_SUANLI, TRANSFER_EXPIRE_DAYS,
} from "./usage.js";

const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const r1 = (n) => Math.round(n * 10) / 10;

function signinRequiredError(request) {
  return request.headers.get("X-VD-Platform") === "android" ? "needs_wechat_signin" : "needs_apple_signin";
}

// 收款人 id 归一化：用户手上拿到的是 anon-xxxx（whoami 那种短形），存储层认的是
// users/anon-xxxx/。两种写法都收，统一补成 scope。
export function normalizeScope(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const core = s.replace(/^users\//, "").replace(/\/$/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(core)) return null;
  return `users/${core}/`;
}

export async function handleTransferRoute(url, request, env) {
  if (url.pathname !== "/agent/usage/transfer" || request.method !== "POST") return null;
  if (!env.USAGE) return J({ error: "degraded" }, 503);

  const tok = bearerToken(request);
  const sess = env.SESSION_SECRET ? await verifySession(tok, env.SESSION_SECRET) : null;
  let from;
  if (sess && sess.scope) {
    if (!sess.apple && !sess.wechat) return J({ error: signinRequiredError(request) }, 403);
    from = sess.scope;
  } else {
    const anon = await anonScopeFromToken(tok);
    if (!anon) return J({ error: "unauthorized" }, 401);
    if (!(await hasVerifiedBinding(env, anon))) return J({ error: signinRequiredError(request) }, 403);
    from = anon;
  }

  const body = await request.json().catch(() => ({}));
  const to = normalizeScope(body.to);
  if (!to) return J({ error: "bad_to" }, 400);

  const suanli = body.suanli;
  if (!Number.isInteger(suanli) || suanli < TRANSFER_MIN_SUANLI || suanli > TRANSFER_MAX_SUANLI)
    return J({ error: "bad_amount", min_suanli: TRANSFER_MIN_SUANLI, max_suanli: TRANSFER_MAX_SUANLI }, 400);

  if (to === from) return J({ error: "self_transfer" }, 400);

  // 收款人必须**已经存在**——查而不建。ensureAccount 会给新号发注册礼包，
  // 在这里用它等于「收款人写错一个字就凭空造出 200 算力」。
  const exists = await env.USAGE.prepare("SELECT 1 AS ok FROM account WHERE user_sub=?").bind(to).first();
  if (!exists) return J({ error: "no_such_user" }, 404);

  const now = Date.now();
  const amountUY = suanliToUY(suanli);

  // 单日累计上限：限的不是「能印多少钱」（转账是搬运，总量不变），是「一次手滑或
  // 一个被盗的号能搬走多少」。按 transfer 表近 24 小时滚动统计。
  const spent = await env.USAGE.prepare(
    "SELECT COALESCE(SUM(amount_uy),0) AS s FROM transfer WHERE from_sub=? AND ts > ?"
  ).bind(from, now - DAY_MS).first();
  if ((spent?.s ?? 0) + amountUY > suanliToUY(TRANSFER_DAILY_SUANLI))
    return J({ error: "daily_limit", daily_limit_suanli: TRANSFER_DAILY_SUANLI,
               used_suanli: r1(uyToSuanli(spent?.s ?? 0)) }, 429);

  const before = await balanceUY(env.USAGE, from, now);
  if (before < amountUY)
    return J({ error: "insufficient", need_suanli: suanli, suanli: r1(uyToSuanli(before)) }, 402);

  const note = body.note ? String(body.note).slice(0, 40) : null;
  const id = body.idempotency_key ? String(body.idempotency_key).slice(0, 80) : crypto.randomUUID();

  let res;
  try {
    res = await transferCredits(env.USAGE, {
      id, fromSub: from, toSub: to, amountUY, note,
      expiresAt: now + TRANSFER_EXPIRE_DAYS * DAY_MS, now,
    });
  } catch (e) {
    // 上面已经验过余额；真走到这里说明两笔并发抢同一份余额，仍然按 402 回，
    // 而不是 500——存储层是最后一道闸，它拒了就是拒了。
    if (String(e?.message) === "insufficient")
      return J({ error: "insufficient", need_suanli: suanli, suanli: r1(uyToSuanli(await balanceUY(env.USAGE, from, now))) }, 402);
    throw e;
  }

  if (!res.duplicate) {
    // 推送失败不连累转账（钱已经落账了）。
    try {
      await sendPush(env, to, {
        title: "收到算力",
        body: `有人转给你 ${suanli} 算力${note ? "：" + note : ""}`,
        threadId: "transfer",
      });
    } catch (e) { console.log("[transfer] push failed", String(e?.message || e)); }
  }

  const after = await balanceUY(env.USAGE, from, now);
  return J({
    ok: true, transfer_id: id, to,
    transferred_suanli: suanli, suanli: r1(uyToSuanli(after)),
    duplicate: res.duplicate === true,
  });
}
