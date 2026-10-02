// src/paint-client.js — VoiceDrop 调 paint.jianshuo.dev 的唯一入口（2026-10-02 统一）。
// edit_photo / new_photo（tools.js）与题图调优页（prompt-lab.js）都走这里，别再各自手搓 fetch。
//
// 只管把请求送到 paint：引擎选择（codex 优先、额度满自动降级 Seedream）、限流重试、冷却、
// 尺寸规整（任意合理 WxH → CLI 能收的 16 倍数形状）全在 paint 服务端，说明书 paint/USAGE.md。
// 回调 payload / GET 结果里有 engine / model / fallback_reason，可据此知道是谁画的。

export const paintBase = (env) => (env.PAINT_BASE || "https://paint.jianshuo.dev").replace(/\/$/, "");

// 尺寸只做语法关：不像「宽x高」或 auto/2K/4K 的（模型乱填的 "huge; DROP" 之类）换成缺省，
// 免得整单被 paint 400 拒掉；合法的原样交给服务端规整。
const SIZE_OK = /^(\d{2,5}\s*x\s*\d{2,5}|auto|[24]k)$/i;
export function sizeOr(size, fallback) {
  return typeof size === "string" && SIZE_OK.test(size.trim()) ? size.trim() : fallback;
}

/**
 * 提交一单。body 即 paint POST /api/jobs 的请求体（prompt/size/format/…/callback_*）。
 * opts.defaultSize：body.size 不合语法时用它。返回 fetch Response；网络失败返回 null（调用方看 status）。
 */
export async function paintSubmit(env, body, { defaultSize = "1024x1024" } = {}) {
  const payload = { ...body, size: sizeOr(body.size, defaultSize) };
  try {
    return await globalThis.fetch(`${paintBase(env)}/api/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return null;
  }
}

/** 查一单状态（GET /api/jobs/:id）。返回 fetch Response；网络失败返回 null。 */
export async function paintGetJob(env, jobId) {
  try {
    return await globalThis.fetch(`${paintBase(env)}/api/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}` },
    });
  } catch {
    return null;
  }
}
