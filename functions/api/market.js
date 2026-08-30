// /api/market —— 组合 2σ 看板（/a/portfolio-2sigma/）的行情代理。
// 服务端拉 Yahoo Finance v8 chart 日线（浏览器直连有 CORS），边缘缓存 10 分钟。
// 只放行组合内的六个标的，防止被当成公共代理。

const ALLOWED = new Set(["VTI", "VXUS", "BND", "QQQ", "FLSA", "HOOD"]);

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const symbols = (url.searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const rangeParam = url.searchParams.get("range") || "2y";
  const range = /^([1-9][0-9]?)(y|mo|d)$/.test(rangeParam) ? rangeParam : "2y";

  if (!symbols.length || symbols.some((s) => !ALLOWED.has(s))) {
    return json({ error: "symbols 只接受组合内标的: " + [...ALLOWED].join(",") }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `https://jianshuo.dev/api/market?symbols=${symbols.join(",")}&range=${range}`
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const quotes = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
            sym
          )}?range=${range}&interval=1d`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
              Accept: "application/json",
            },
          }
        );
        const data = await r.json();
        const res = data?.chart?.result?.[0];
        const ts = res?.timestamp || [];
        const closes = res?.indicators?.quote?.[0]?.close || [];
        if (!ts.length || !closes.length) {
          quotes[sym] = { error: "no data" };
          return;
        }
        const t = [];
        const c = [];
        for (let i = 0; i < ts.length; i++) {
          if (closes[i] != null) {
            t.push(ts[i]);
            c.push(Math.round(closes[i] * 10000) / 10000);
          }
        }
        // Yahoo 怪癖：收盘后/周末最后一根 bar 的 close 常是 null，真实价在 meta.regularMarketPrice
        const lastTs = ts[ts.length - 1];
        const mkt = res.meta?.regularMarketPrice;
        if (
          closes[ts.length - 1] == null &&
          mkt != null &&
          (!t.length || lastTs > t[t.length - 1])
        ) {
          t.push(lastTs);
          c.push(Math.round(mkt * 10000) / 10000);
        }
        quotes[sym] = {
          t,
          c,
          // 常规交易时段结束时间戳：前端用它判断最后一根是不是盘中未收盘
          regularEnd: res.meta?.currentTradingPeriod?.regular?.end ?? null,
          marketTime: res.meta?.regularMarketTime ?? null,
        };
      } catch (e) {
        quotes[sym] = { error: String(e) };
      }
    })
  );

  const resp = json({ fetched: Math.floor(Date.now() / 1000), quotes });
  resp.headers.set("Cache-Control", "public, max-age=600");
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
