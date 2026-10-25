// src/status-page.ts — 状态页（lab.jianshuo.dev/router/，Caddy basic_auth 后面）。
// 服务端直接渲染，30 秒自动刷新，没有前端脚本。
import { acctKey, ENGINE_KIND, ENGINE_NAMES, limitsFor, policyFor, type EngineName } from "./config.js";
import type { Pool } from "./pool.js";
import { quotaKey, weeklyLine } from "./selector.js";
import type { RunRecord } from "./runs.js";

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

function bar(used: number | null, cap: number, line?: number): string {
  if (used == null) return `<span class="muted">unknown</span>`;
  const cls = used >= cap ? "bad" : line != null && used > line ? "warn" : "ok";
  const mark = line != null ? `<i style="left:${Math.min(100, line)}%" title="pace line ${line.toFixed(0)}%"></i>` : "";
  return `<div class="bar ${cls}"><b style="width:${Math.min(100, used)}%"></b>${mark}</div><span class="num">${used.toFixed(0)}%</span>`;
}

export function renderStatus(pool: Pool, runs: RunRecord[], now = Date.now()): string {
  const cfg = pool.cfg;
  const st = pool.selectState();
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
      rows.push(
        `<tr><td><b>${esc(e)}</b><span class="sub">${esc(a.id)}${qk !== k ? ` · quota of ${esc(qk)}` : ""}</span></td><td>${health}</td><td>${five}</td><td>${week}</td><td class="c">${inf || ""}</td><td class="sub">${ago(u?.probedAt, now)}</td><td class="err">${esc(u?.error ?? "")}</td></tr>`,
      );
    }
  }
  const recent = runs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
  const runRows = recent.map((r) => {
    const accts = r.attempts.map((a) => `${a.key}${a.ok === false ? " ✗" : a.ok ? " ✓" : ""}`).join(" → ");
    const dur = r.finishedAt ? `${Math.round((r.finishedAt - r.createdAt) / 60000)}m` : `${Math.round((now - r.createdAt) / 60000)}m…`;
    return `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.caller)}</td><td>${esc(r.req.task_class)}</td><td><span class="pill ${r.status === "done" ? "ok" : r.status === "failed" ? "bad" : r.status === "running" ? "run" : "muted"}">${r.status}</span></td><td class="mono sub">${esc(accts)}</td><td>${dur}</td><td class="err">${esc(r.queuedReason ?? r.error ?? "")}</td></tr>`;
  });
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
.num{margin-left:8px;font-variant-numeric:tabular-nums}.muted{color:var(--mute)}code{font-size:12px;background:#f1f0eb;padding:1px 5px;border-radius:4px}
</style></head><body><main>
<h1>Engine Router</h1>
<div class="meta">红线：5h ${cfg.limits.cap_5h}% · 周 ${cfg.limits.cap_7d}%（配速宽限 ${cfg.limits.weekly_slack} 点，竖线 = 当前配速线） · 并发 文字 ${cfg.concurrency.global_text} / 出图 ${cfg.concurrency.global_image} · 策略 ${policies} · ${new Date(now).toISOString().slice(0, 19).replace("T", " ")} UTC</div>
<h2>账号</h2><div class="card"><table><tr><th>账号</th><th>状态</th><th>5 小时</th><th>本周</th><th>在跑</th><th>探测</th><th>最近错误</th></tr>${rows.join("") || `<tr><td colspan="7" class="muted">config.json 里还没有账号</td></tr>`}</table></div>
<h2>最近任务</h2><div class="card"><table><tr><th>run</th><th>调用方</th><th>类型</th><th>状态</th><th>账号</th><th>用时</th><th>说明</th></tr>${runRows.join("") || `<tr><td colspan="7" class="muted">还没有任务</td></tr>`}</table></div>
<h2>学到的单次消耗（百分点）</h2><div class="card"><table><tr><th>任务类|引擎</th><th>5h</th><th>周</th></tr>${learned || `<tr><td colspan="3" class="muted">还没有样本（用配置里的预估）</td></tr>`}</table></div>
</main></body></html>`;
}
