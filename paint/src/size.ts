// src/size.ts — 尺寸规整，服务端单一真源（2026-10-02 起；此前 VoiceDrop agent 的
// paint-size.js 自己吸附一遍，claude-agent 的 SKILL 又让模型自己别乱填——两处各管一半）。
//
// 调用方随便给一个合理的「宽x高」，这里确定性地规整成 gpt-image-2 CLI 能收的形状；
// Seedream 降级时再以这个规整后的尺寸为目标（seedream.ts seedreamSize 放大到方舟下限，
// 出图后裁回），所以不论哪个引擎出图，交回去的图尺寸一样。
//
// gpt-image-2-skill 0.7.1 的约束（references/sizes-and-formats.md）：
//   两边都是 16 的倍数、单边 ≤3840、总像素 ≤8,294,400、长短边比 ≤3:1；
//   另外实测总像素 < 655,360（= 640×1024）会被拒（2026-07-18「竖版照片改不了风格」事故）。
// 关键字（auto / 2K / 4K）原样透传，CLI 自己解析。

const STEP = 16;
const MIN_EDGE = 256;
const MAX_EDGE = 3840;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_RATIO = 3;

const KEYWORD = /^(auto|2k|4k)$/i; // CLI 0.7.1 只认这三个别名
const WXH = /^(\d{1,5})\s*[xX×*]\s*(\d{1,5})$/;

const up = (n: number) => Math.ceil(n / STEP) * STEP;
const down = (n: number) => Math.floor(n / STEP) * STEP;
const near = (n: number) => Math.round(n / STEP) * STEP;
const clamp = (n: number) => Math.max(MIN_EDGE, Math.min(MAX_EDGE, n));

/**
 * 规整尺寸。返回 null = 不是合理尺寸（调用方回 400）。
 * WxH：四舍五入到 16 倍数 → 长短边比压到 ≤3（抬短边）→ 总像素不足等比放大 → 超上限等比缩小。
 */
export function normalizeSize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (KEYWORD.test(s)) return s.toUpperCase() === "AUTO" ? "auto" : s.toUpperCase();
  const m = WXH.exec(s);
  if (!m) return null;
  let w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0)) return null;
  // 比例先压住（极端横幅 9999x100 之类），再谈面积
  if (w / h > MAX_RATIO) h = w / MAX_RATIO;
  else if (h / w > MAX_RATIO) w = h / MAX_RATIO;
  // 单边超上限：等比缩（别各自夹紧，那会把比例夹歪）
  const longest = Math.max(w, h);
  if (longest > MAX_EDGE) { w = (w * MAX_EDGE) / longest; h = (h * MAX_EDGE) / longest; }
  let W = clamp(near(w)), H = clamp(near(h));
  if (W * H < MIN_PIXELS) {
    const k = Math.sqrt(MIN_PIXELS / (W * H));
    W = clamp(up(W * k)); H = clamp(up(H * k));
    while (W * H < MIN_PIXELS && (W < MAX_EDGE || H < MAX_EDGE)) {
      if (W <= H && W < MAX_EDGE) W += STEP; else H += STEP;
    }
  } else if (W * H > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (W * H));
    W = clamp(down(W * k)); H = clamp(down(H * k));
  }
  // clamp 之后比例可能又超了一点（两边都被夹时），最后兜一次：缩长边
  if (W / H > MAX_RATIO) W = down(H * MAX_RATIO);
  else if (H / W > MAX_RATIO) H = down(W * MAX_RATIO);
  return `${W}x${H}`;
}
