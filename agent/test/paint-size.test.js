import { describe, it, expect } from "vitest";
// 尺寸规整（16 倍数 / 总像素上下限 / 单边与比例上限）2026-10-02 起收归 paint 服务端
// （paint/src/size.ts，原 snapSize 的期望已原样搬到 paint/test/size.test.ts）。
// 这里只测 VoiceDrop 端剩下的两件事：读 JPEG 宽高、按原图比例算想要的尺寸；
// 以及 paint-client 的语法关（不像尺寸的换缺省）。
import { jpegDims, fitSize } from "../src/paint-size.js";
import { sizeOr } from "../src/paint-client.js";

function fakeJpeg(w, h, { exif = false } = {}) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0,0,0, 0,0,0, 0,0,0];
  const app1 = exif ? [0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66] : []; // 假 EXIF 段，必须被跳过
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

describe("jpegDims", () => {
  it("reads width/height from SOF0", () => {
    expect(jpegDims(fakeJpeg(4000, 3000))).toEqual({ w: 4000, h: 3000 });
  });
  it("skips APP1 (EXIF) segments before SOF", () => {
    expect(jpegDims(fakeJpeg(1080, 1440, { exif: true }))).toEqual({ w: 1080, h: 1440 });
  });
  it("returns null for non-JPEG bytes", () => {
    expect(jpegDims(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG magic
    expect(jpegDims(new Uint8Array([]))).toBeNull();
  });
});

describe("fitSize（只按比例算，规整交给 paint 服务端）", () => {
  it("4:3 横图 → 1024x768", () => expect(fitSize(4000, 3000)).toBe("1024x768"));
  it("3:4 竖图 → 768x1024", () => expect(fitSize(3000, 4000)).toBe("768x1024"));
  it("方图 → 1024x1024", () => expect(fitSize(3024, 3024)).toBe("1024x1024"));
  it("9:16 手机竖拍 → 576x1024（paint 服务端再放大到 608x1088 达标）", () => {
    expect(fitSize(1080, 1920)).toBe("576x1024");
  });
  it("非法输入 → null", () => expect(fitSize(0, 100)).toBeNull());
});

describe("sizeOr（paint-client 的语法关）", () => {
  it("像尺寸的原样交给服务端", () => {
    expect(sizeOr("1365x1024", "1024x1024")).toBe("1365x1024");
    expect(sizeOr("1568x640", "1024x1024")).toBe("1568x640");
    expect(sizeOr("2K", "1024x1024")).toBe("2K");
  });
  it("不像尺寸的换缺省（免得整单被 paint 400）", () => {
    expect(sizeOr(undefined, "1536x1024")).toBe("1536x1024");
    expect(sizeOr("garbage", "1536x1024")).toBe("1536x1024");
    expect(sizeOr("1024", "1024x1024")).toBe("1024x1024");
    expect(sizeOr("huge; DROP", "1024x1024")).toBe("1024x1024");
  });
});
