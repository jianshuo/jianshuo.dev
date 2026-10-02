import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSize } from "../src/size.ts";

// 尺寸规整收归服务端（2026-10-02）：此前 VoiceDrop agent 的 paint-size.js snapSize
// 自己吸附一遍。下面前几条是从那份单测原样搬来的期望——行为对老调用方不变。
test("normalizeSize：16 倍数吸附 + 总像素下限（与原 agent snapSize 一致）", () => {
  assert.equal(normalizeSize("1365x1024"), "1360x1024");
  assert.equal(normalizeSize("1568x640"), "1568x640");
  assert.equal(normalizeSize("1024x1536"), "1024x1536");
  assert.equal(normalizeSize("1024x1024"), "1024x1024");
  assert.equal(normalizeSize("640x360"), "1072x624");
  assert.equal(normalizeSize("576x1024"), "608x1088");
});

test("normalizeSize：超 CLI 上限（单边 3840 / 总像素 8.29M / 比例 3:1）等比压回", () => {
  for (const s of ["9999x100", "100x9999", "4096x4096", "3840x3840", "5000x2000", "50x50"]) {
    const out = normalizeSize(s)!;
    const [w, h] = out.split("x").map(Number);
    assert.equal(w % 16, 0, s);
    assert.equal(h % 16, 0, s);
    assert.ok(Math.max(w, h) <= 3840, `${s} → ${out}`);
    assert.ok(w * h <= 8_294_400 && w * h >= 655_360, `${s} → ${out}`);
    assert.ok(Math.max(w, h) / Math.min(w, h) <= 3, `${s} → ${out}`);
  }
  assert.equal(normalizeSize("9999x100"), "3840x1280"); // 比例压到 3:1，不是被两头夹歪
});

test("normalizeSize：关键字透传，非法返回 null", () => {
  assert.equal(normalizeSize("2K"), "2K");
  assert.equal(normalizeSize("4k"), "4K");
  assert.equal(normalizeSize("auto"), "auto");
  assert.equal(normalizeSize("1024 x 768"), "1024x768");
  for (const bad of ["garbage", "1024", "", "0x100", undefined, 1024]) assert.equal(normalizeSize(bad as any), null);
});
