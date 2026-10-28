// src/status-page.ts — 状态页（lab.jianshuo.dev/router/，Caddy basic_auth 后面）。
// 服务端直接渲染，30 秒自动刷新，没有前端脚本。
import { acctKey, ENGINE_KIND, ENGINE_NAMES, imageSlots, limitsFor, policyFor, type EngineName } from "./config.js";
import type { Pool } from "./pool.js";
import { quotaKey, weeklyLine } from "./selector.js";
import type { RunRecord } from "./runs.js";
import type { Lease, Leases } from "./leases.js";
import { bookForKey } from "./book-index.js";
import type { Batch, Batches } from "./batches.js";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function ago(ms: number | null | undefined, now: number): string {
  if (!ms) return "—";
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return "in " + until(ms, now);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
function until(ms: number | null | undefined, now: number): string {
  if (!ms) return "—";
  const m = Math.round((ms - now) / 60000);
  if (m <= 0) return "now";
  if (m < 90) return `${m}m`;
  if (m < 2880) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

/** 北京时间「10-26 18:50」 */
function bj(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms + 8 * 3600_000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}
function mins(from: number, to: number): string {
  const m = Math.max(0, Math.round((to - from) / 60000));
  return m < 90 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function leaseRow(l: Lease, now: number): string {
  const live = l.finishedAt == null;
  const pill = live ? `<span class="pill run">在跑</span>` : l.ok ? `<span class="pill ok">完成</span>` : `<span class="pill bad">失败</span>`;
  const step = l.progress ? `${esc(l.progress.step)}<span class="sub">${ago(l.progress.at, now)}</span>` : `<span class="muted">—</span>`;
  const tail = live ? `<span class="sub">到期 ${until(l.expiresAt, now)}</span>` : l.error ? `<span class="err">${esc(l.error)}</span>` : "";
  return `<tr><td class="nw">${bj(l.createdAt)}</td><td><b>${esc(l.label ?? l.taskClass)}</b><span class="sub">${esc(l.caller)} · ${esc(l.taskClass)}</span></td><td>${pill}</td><td class="mono sub">${esc(l.key)}</td><td>${step}</td><td class="nw">${live ? mins(l.createdAt, now) + "…" : mins(l.createdAt, l.finishedAt!)}</td><td>${tail}</td></tr>`;
}

function batchRow(b: Batch, now: number): string {
  const n = (s: string) => b.items.filter((i) => i.status === s).length;
  const cls = b.status === "done" ? "ok" : b.status === "failed" ? "bad" : b.status === "running" ? "run" : b.status === "paused" ? "warn" : "muted";
  const label = { queued: "排队", running: "在画", paused: "暂停", done: "完成", failed: "失败", cancelled: "取消" }[b.status];
  const prog = `${n("done")}/${b.items.length}${n("running") ? ` · 在画 ${n("running")}` : ""}${n("queued") ? ` · 排队 ${n("queued")}` : ""}${n("failed") ? ` · <span class="err">失败 ${n("failed")}</span>` : ""}`;
  const note =
    b.status === "paused"
      ? `暂停到 ${bj(b.pausedUntil)}：${esc(b.pauseReason ?? "")}`
      : (b.items.find((i) => i.status === "failed")?.error ?? "");
  const dur = b.finishedAt ? mins(b.createdAt, b.finishedAt) : `${mins(b.createdAt, now)}…`;
  return `<tr><td class="nw">${bj(b.createdAt)}</td><td><b>${esc(b.label ?? b.group ?? "—")}</b><span class="sub">${esc(b.caller)} · ${esc(b.id)}${b.group ? ` · ${esc(b.group)}` : ""}${b.priority === "interactive" ? " · 插队" : ""}</span></td><td><span class="pill ${cls}">${label}</span></td><td class="mono sub">${esc(b.engine && b.accountId ? `${b.engine}/${b.accountId}` : "未定")}<br>${esc(b.decidedReason ?? "")}</td><td class="nw">${prog}</td><td>${dur}</td><td class="err">${b.status === "paused" ? note : esc(note)}</td></tr>`;
}

function bar(used: number | null, cap: number, line?: number): string {
  if (used == null) return `<span class="muted">unknown</span>`;
  const cls = used >= cap ? "bad" : line != null && used > line ? "warn" : "ok";
  const mark = line != null ? `<i style="left:${Math.min(100, line)}%" title="pace line ${line.toFixed(0)}%"></i>` : "";
  return `<div class="bar ${cls}"><b style="width:${Math.min(100, used)}%"></b>${mark}</div><span class="num">${used.toFixed(0)}%</span>`;
}

export function renderStatus(pool: Pool, runs: RunRecord[], leases?: Leases, batches?: Batches, now = Date.now()): string {
  const cfg = pool.cfg;
  const st = pool.selectState();
  const imageLoad = batches?.load() ?? {};
  const rows: string[] = [];
  for (const e of ENGINE_NAMES as EngineName[]) {
    for (const a of cfg.engines[e]?.accounts ?? []) {
      const k = acctKey(e, a.id);
      const qk = quotaKey(cfg, e, a.id);
      const u = st.usage[qk];
      const inf = st.inflight[k]?.count ?? 0;
      const cool = st.cooldown[qk] ?? 0;
      let health = `<span class="pill ok">ok</span>`;
      if (a.disabled) health = `<span class="pill muted">disabled</span>`;
      else if (u && !u.healthy) health = `<span class="pill bad">unhealthy</span>`;
      else if (cool > now) health = `<span class="pill warn">cooldown ${until(cool, now)}</span>`;
      else if (e !== "seedream" && !u) health = `<span class="pill muted">not probed</span>`;
      let five = "",
        week = "";
      if (e === "seedream") {
        const n = st.dailyCount[k] ?? 0;
        five = `${n} / ${a.daily_cap ?? 200} today`;
      } else {
        // 按这类引擎缺省策略的红线/配速画（出图策略可能不配速、红线不同）
        const lim = limitsFor(cfg, policyFor(cfg, undefined, ENGINE_KIND[e]));
        five = `${bar(u?.used5h ?? null, lim.cap_5h)}<span class="sub">resets ${until(u?.reset5h, now)}</span>`;
        const line = weeklyLine(lim, u?.reset7d ?? null, now);
        week = `${bar(u?.used7d ?? null, lim.cap_7d, lim.pacing ? line : undefined)}<span class="sub">resets ${until(u?.reset7d, now)}${lim.pacing ? "" : " · 不配速"}</span>`;
      }
      const busy =
        ENGINE_KIND[e] === "image"
          ? `${imageLoad[k]?.running ?? 0}/${imageSlots(cfg, a)}${imageLoad[k]?.queued ? `<span class="sub">排队 ${imageLoad[k].queued}</span>` : ""}`
          : inf || "";
      rows.push(
        `<tr><td><b>${esc(e)}</b><span class="sub">${esc(a.id)}${qk !== k ? ` · quota of ${esc(qk)}` : ""}</span></td><td>${health}</td><td>${five}</td><td>${week}</td><td class="c">${busy}</td><td class="sub">${ago(u?.probedAt, now)}</td><td class="err">${esc(u?.error ?? "")}</td></tr>`,
      );
    }
  }
  const recent = runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  const runRows = recent.map((r) => {
    const accts = r.attempts.map((a) => `${a.key}${a.ok === false ? " ✗" : a.ok ? " ✓" : ""}`).join(" → ");
    const dur = r.finishedAt ? mins(r.createdAt, r.finishedAt) : `${mins(r.createdAt, now)}…`;
    const { book, what } = bookForKey(r.req.idempotency_key);
    const name = book ? `《${esc(book.title)}》` : esc(r.req.label ?? "—");
    const sub = [what ?? r.req.task_class, book?.slug].filter(Boolean).map(esc).join(" · ");
    return `<tr><td class="nw">${bj(r.createdAt)}</td><td><b>${name}</b><span class="sub">${sub}</span></td><td class="mono sub">${esc(r.id)}<br>${esc(r.caller)}</td><td><span class="pill ${r.status === "done" ? "ok" : r.status === "failed" ? "bad" : r.status === "running" ? "run" : "muted"}">${r.status}</span></td><td class="mono sub">${esc(accts)}</td><td>${dur}</td><td class="err">${esc(r.queuedReason ?? r.error ?? "")}</td></tr>`;
  });
  const live = (leases?.active() ?? []).sort((a, b) => b.createdAt - a.createdAt);
  const leaseRows = [...live, ...(leases?.recent() ?? []).slice(0, 15)].map((l) => leaseRow(l, now));
  const queueCards = (leases?.queueSnapshots() ?? []).map((q) => {
    const stale = now - q.updatedAt > 5 * 60_000;
    const items = q.items
      .map((x, i) => `<tr><td class="c">${i + 1}</td><td><b>${esc(x.label)}</b></td><td class="nw">${bj(x.at)}</td><td class="sub">${esc(x.note ?? "")}</td></tr>`)
      .join("");
    return `<h3>${esc(q.title)} <span class="pill ${q.items.length ? "warn" : "ok"}">${q.items.length} 本排队</span></h3>
<div class="meta">${esc(q.note)}${q.note ? " · " : ""}<span class="${stale ? "err" : ""}">更新于 ${ago(q.updatedAt, now)}${stale ? "（调用方好久没报了）" : ""}</span></div>
<div class="card"><table><tr><th>#</th><th>内容</th><th>下单</th><th>说明</th></tr>${items || `<tr><td colspan="4" class="muted">队里没有东西</td></tr>`}</table></div>`;
  });
  const allBatches = batches?.list() ?? [];
  const batchRows = [...allBatches.filter((b) => !b.finishedAt), ...allBatches.filter((b) => b.finishedAt).slice(0, 15)].map((b) => batchRow(b, now));
  const learned = Object.entries(pool.learnedTable())
    .map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${v.d5h.toFixed(1)}</td><td>${v.d7d.toFixed(1)}</td></tr>`)
    .join("");
  const policies = Object.entries(cfg.policies)
    .map(([k, p]) => {
      const lim = p.limits
        ? `, ${Object.entries(p.limits).map(([lk, lv]) => (lk === "pacing" ? (lv ? "配速" : "不配速") : `${lk}=${lv}`)).join(" ")}`
        : "";
      return `<code>${esc(k)}</code>: engines=${esc(p.engines)}${p.order ? ` (${esc(p.order.join(" → "))})` : ""}, keys=${esc(p.keys)}${esc(lim)}`;
    })
    .join(" · ");

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Engine Router</title><style>
:root{--bg:#fafaf8;--card:#fff;--ink:#1d1d1b;--mute:#8a8a85;--line:#e7e6e1;--ok:#2f9e5b;--warn:#d68a00;--bad:#d23c3c;--run:#2f6fd6}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.meta{color:var(--mute);font-size:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{font-size:12px;color:var(--mute);font-weight:500}tr:last-child td{border-bottom:0}.c{text-align:center}
.sub{display:block;color:var(--mute);font-size:12px}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.err{color:var(--bad);font-size:12px;max-width:320px;word-break:break-word}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:#eee;color:var(--mute)}
.pill.ok{background:#e6f4ec;color:var(--ok)}.pill.warn{background:#fdf1dc;color:var(--warn)}.pill.bad{background:#fbe5e5;color:var(--bad)}.pill.run{background:#e4edfb;color:var(--run)}
.bar{position:relative;display:inline-block;width:110px;height:8px;background:#efeee9;border-radius:4px;vertical-align:middle;overflow:visible}
.bar b{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:var(--ok)}.bar.warn b{background:var(--warn)}.bar.bad b{background:var(--bad)}
.bar i{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);opacity:.45}
.nw{white-space:nowrap;font-variant-numeric:tabular-nums}h3{font-size:14px;margin:14px 0 4px}
.num{margin-left:8px;font-variant-numeric:tabular-nums}.muted{color:var(--mute)}code{font-size:12px;background:#f1f0eb;padding:1px 5px;border-radius:4px}
</style></head><body><main>
<h1>Engine Router</h1>
<div class="meta">红线：5h ${cfg.limits.cap_5h}% · 周 ${cfg.limits.cap_7d}%（配速宽限 ${cfg.limits.weekly_slack} 点，竖线 = 当前配速线） · 并发 文字 ${cfg.concurrency.global_text} / 出图 每账号 ${cfg.concurrency.image_per_account}、全站 ${cfg.concurrency.image_total} · 策略 ${policies} · 北京时间 ${bj(now)}</div>
<h2>账号</h2><div class="card"><table><tr><th>账号</th><th>状态</th><th>5 小时</th><th>本周</th><th>在跑</th><th>探测</th><th>最近错误</th></tr>${rows.join("") || `<tr><td colspan="7" class="muted">config.json 里还没有账号</td></tr>`}</table></div>
${queueCards.length ? `<h2>排队</h2>${queueCards.join("")}` : ""}
<h2>出图批次（一批一个引擎，按账号并发排队）</h2><div class="card"><table><tr><th>提交</th><th>内容</th><th>状态</th><th>引擎</th><th>进度</th><th>用时</th><th>说明</th></tr>${batchRows.join("") || `<tr><td colspan="7" class="muted">还没有出图批次</td></tr>`}</table></div>
<h2>租约（调用方自己执行：视频书）</h2><div class="card"><table><tr><th>开始</th><th>内容</th><th>状态</th><th>账号</th><th>当前步骤</th><th>用时</th><th></th></tr>${leaseRows.join("") || `<tr><td colspan="7" class="muted">现在没有租约</td></tr>`}</table></div>
<h2>最近任务</h2><div class="card"><table><tr><th>开始</th><th>内容</th><th>run · 调用方</th><th>状态</th><th>账号</th><th>用时</th><th>说明</th></tr>${runRows.join("") || `<tr><td colspan="7" class="muted">还没有任务</td></tr>`}</table></div>
<h2>学到的单次消耗（百分点）</h2><div class="card"><table><tr><th>任务类|引擎</th><th>5h</th><th>周</th></tr>${learned || `<tr><td colspan="3" class="muted">还没有样本（用配置里的预估）</td></tr>`}</table></div>
</main></body></html>`;
}
