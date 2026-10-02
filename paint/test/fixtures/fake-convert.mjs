#!/usr/bin/env node
// 打桩版 ImageMagick convert：最后一个参数是输出（可带 "png:"/"jpg:"/"webp:" 前缀）。
// png → 写一张真实 1×1 PNG；其它 → 写 FFD8 开头的伪 JPEG（够 XMP 嵌入嗅探）。
// 实参记到 <out>.args.json，供单测断言（裁缩几何 / 质量）。
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const last = args[args.length - 1];
const m = /^(png|jpg|jpeg|webp):(.*)$/.exec(last);
const fmt = m ? m[1] : "jpg";
const out = m ? m[2] : last;
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
writeFileSync(out, fmt === "png" ? TINY_PNG : Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from("FAKEJPEG")]));
writeFileSync(out + ".args.json", JSON.stringify(args));
process.exit(0);
