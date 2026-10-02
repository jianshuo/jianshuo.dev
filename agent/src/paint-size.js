// src/paint-size.js — 按原图比例给 edit_photo 定输出尺寸。
//
// 2026-10-02 起尺寸「规整」（16 倍数、总像素上下限、单边/比例上限）收归 paint 服务端
// （paint/src/size.ts），这里不再吸附——原来的 snapSize 已删。这里只剩两件 paint 做不了的事：
// 读 R2 原图的 JPEG 头拿宽高，以及按原图比例算出想要的输出尺寸。

// JPEG SOF 头解析：顺着段结构找 SOFn 取宽高，不解码像素。给 edit_photo 用——
// 相册导入的图不再是方的（App b07ad15 起），输出写死 1024x1024 会把横竖图
// 重画成方形；按原图比例出尺寸才对。非 JPEG / 结构异常返回 null，调用方回退方图。
export function jpegDims(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }                              // padding
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; } // 无长度段
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

// 按原图宽高比出目标尺寸：长边缩到 longSide，另一边等比取整。
// 16 倍数吸附、总像素下限（竖图 9:16 → 576x1024 不够 655360，服务端会放大到 608x1088）
// 都由 paint 服务端做。
export function fitSize(w, h, longSide = 1024) {
  if (!(w > 0 && h > 0)) return null;
  const k = longSide / Math.max(w, h);
  return `${Math.max(1, Math.round(w * k))}x${Math.max(1, Math.round(h * k))}`;
}
