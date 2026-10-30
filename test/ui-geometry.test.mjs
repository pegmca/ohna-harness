import assert from "node:assert/strict";
import test from "node:test";
import {
  explainGeometryFailure,
  hasNoHorizontalOverflow,
  isRectWithinViewport,
  isVerticalScrollOwner
} from "./lib/ui-geometry.mjs";

const viewport = { width: 960, height: 640 };

test("isRectWithinViewport 拒绝四边任意方向越界", () => {
  assert.equal(isRectWithinViewport({ top: 0, left: 0, right: 960, bottom: 640 }, viewport), true);
  assert.equal(isRectWithinViewport({ top: -2, left: 0, right: 960, bottom: 640 }, viewport), false);
  assert.equal(isRectWithinViewport({ top: 0, left: 0, right: 962, bottom: 640 }, viewport), false);
  assert.equal(isRectWithinViewport({ top: 0, left: 0, right: 960, bottom: 642 }, viewport), false);
});

test("hasNoHorizontalOverflow 接受亚像素误差但拒绝真实横向溢出", () => {
  assert.equal(hasNoHorizontalOverflow(960, viewport.width), true);
  assert.equal(hasNoHorizontalOverflow(960.8, viewport.width), true);
  assert.equal(hasNoHorizontalOverflow(961.1, viewport.width), false);
});

test("isVerticalScrollOwner 只认 auto/scroll 且内容高度超出", () => {
  assert.equal(isVerticalScrollOwner({ overflowY: "auto", scrollHeight: 826, clientHeight: 420 }), true);
  assert.equal(isVerticalScrollOwner({ overflowY: "scroll", scrollHeight: 421, clientHeight: 420 }), true);
  assert.equal(isVerticalScrollOwner({ overflowY: "visible", scrollHeight: 826, clientHeight: 420 }), false);
  assert.equal(isVerticalScrollOwner({ overflowY: "auto", scrollHeight: 420, clientHeight: 420 }), false);
  assert.equal(isVerticalScrollOwner(null), false);
});

test("explainGeometryFailure 将越界与滚动归属错误转成明确原因", () => {
  assert.equal(explainGeometryFailure("ok", {
    rect: { top: 1, left: 1, right: 959, bottom: 639 },
    viewport,
    scrollWidth: 960,
    scrollContainer: { overflowY: "auto", scrollHeight: 800, clientHeight: 400 }
  }), undefined);
  assert.match(explainGeometryFailure("outside", {
    rect: { top: -10, left: 1, right: 959, bottom: 639 },
    viewport
  }), /outside viewport/);
  assert.match(explainGeometryFailure("scroll", {
    rect: { top: 1, left: 1, right: 959, bottom: 639 },
    viewport,
    scrollContainer: { overflowY: "visible", scrollHeight: 800, clientHeight: 400 }
  }), /expected vertical scroll owner/);
});
