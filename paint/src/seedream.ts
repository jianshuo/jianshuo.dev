import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import type { SeedreamConfig } from "./config.js";

// src/seedream.ts — Codex 额度打满时的降级引擎：火山方舟 Seedream（2026-10-02）。
// 零依赖：HTTP 用 fetch，裁缩/转格式交给 VPS 上现成的 ImageMagick `convert`。
//
// 方舟实测（2026-10-02）：
//   - 显式 WIDTHxHEIGHT 会被原样遵守（1001x1003、1568x640、1024x1536 都精确出）；
//     给 "2K" 这种关键字则比例不保证（带参考图时 5.0 pro 回 3:4、4.0 回 2:1）。
//   - 面积下限 921,600 像素（5.0 pro / 4.0 同一条），低于即 400 InvalidParameter。
//   - 5.0 pro 不收 sequential_image_generation（400），别传。
//   - 回的永远是 JPEG 的 URL（24h 有效），要自己下载再转成调用方要的格式。

export interface SeedreamSize {
  /** 发给方舟的 size 参数 */
  request: string;
  /** 出图后要裁/缩到的最终尺寸；关键字尺寸（2K 等）时为 undefined = 不动尺寸 */
  target?: { w: number; h: number };
}

/** 调用方要的 size → 方舟 size。WxH 保比例放大到面积下限（超上限则缩），出图后再缩回原尺寸。 */
export function seedreamSize(size: string, minPixels: number, maxPixels: number): SeedreamSize {
  const m = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!m) return { request: /^4k$/i.test(size.trim()) ? "4K" : "2K" };
  const w = Number(m[1]), h = Number(m[2]);
  let rw = w, rh = h;
  const area = w * h;
  if (area < minPixels) {
    const k = Math.sqrt(minPixels / area);
    rw = Math.ceil(w * k);
    rh = Math.ceil(h * k);
    while (rw * rh < minPixels) { rw++; rh = Math.ceil((rw * h) / w); }
  } else if (area > maxPixels) {
    const k = Math.sqrt(maxPixels / area);
    rw = Math.floor(w * k);
    rh = Math.floor(h * k);
  }
  return { request: `${rw}x${rh}`, target: { w, h } };
}

function sniffMime(b: Buffer): string | undefined {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

const ARK_MAX_REF_BYTES = 10 * 1024 * 1024;

/** 参考图 → data URI。方舟只收 png/jpeg/webp 且 ≤10MB；别的（heic 等）或过大先用 convert 转 JPEG。 */
export async function refImageDataUri(inputPath: string, convertBin: string): Promise<string> {
  let buf = await readFile(inputPath);
  let mime = sniffMime(buf);
  if (!mime || buf.length > ARK_MAX_REF_BYTES) {
    const tmp = `${inputPath}.ref.jpg`;
    await runConvert(convertBin, [inputPath + "[0]", "-auto-orient", "-resize", "4096x4096>", "-quality", "90", tmp]);
    buf = await readFile(tmp);
    await unlink(tmp).catch(() => {});
    mime = "image/jpeg";
  }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export class SeedreamError extends Error {
  constructor(message: string, public detail?: unknown) { super(message); }
}

/** 调一次方舟出图，返回图片字节（方舟回的 JPEG） */
export async function seedreamGenerate(
  cfg: SeedreamConfig,
  model: string,
  opts: { prompt: string; size: string; image?: string; /** 整单期限（ms epoch）：请求与下载的超时都不越过它 */ deadline?: number },
): Promise<Buffer> {
  const budget = (cap: number) => Math.max(1, Math.min(cap, (opts.deadline ?? Infinity) - Date.now()));
  const body: Record<string, unknown> = {
    model, prompt: opts.prompt, size: opts.size, response_format: "url", watermark: false,
  };
  if (opts.image) body.image = opts.image;
  const r = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(budget(cfg.timeoutMs)),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!r.ok || json?.error) {
    throw new SeedreamError(`HTTP ${r.status}${json?.error?.code ? " " + json.error.code : ""}`, json?.error ?? text.slice(0, 500));
  }
  const url = json?.data?.[0]?.url;
  if (typeof url !== "string") throw new SeedreamError("no image url in response", text.slice(0, 500));
  const img = await fetch(url, { signal: AbortSignal.timeout(budget(120000)) });
  if (!img.ok) throw new SeedreamError(`image download HTTP ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

export function runConvert(bin: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(bin, args);
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => rej(e));
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`convert exit ${code}: ${err.slice(0, 300)}`))));
  });
}

/**
 * 方舟回来的 JPEG → 调用方要的尺寸/格式。有 target 时等比铺满再居中裁（防方舟偶尔不守比例），
 * jpeg/webp 的质量取 compression（缺省 80，与 VoiceDrop/书架 q80 约定一致）。
 */
export async function finalizeImage(
  convertBin: string,
  src: Buffer,
  outPath: string,
  opts: { target?: { w: number; h: number }; format: string; compression?: number },
): Promise<void> {
  const tmp = `${outPath}.seedream-src.jpg`;
  await writeFile(tmp, src);
  try {
    const args = [tmp, "-auto-orient", "-strip"];
    if (opts.target) {
      const g = `${opts.target.w}x${opts.target.h}`;
      args.push("-resize", `${g}^`, "-gravity", "center", "-extent", g);
    }
    if (opts.format !== "png") args.push("-quality", String(opts.compression ?? 80));
    const prefix = opts.format === "jpeg" ? "jpg" : opts.format;
    args.push(`${prefix}:${outPath}`);
    await runConvert(convertBin, args);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
