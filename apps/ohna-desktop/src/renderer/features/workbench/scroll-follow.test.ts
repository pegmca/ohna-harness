/**
 * UX-104 · 对话时间线滚动跟随的纯函数验收。
 *
 * 浏览器布局由真实视觉脚本负责；这里锁定“何时跟随”的状态机，避免回看历史时被流式输出拽到底部。
 */
import { describe, expect, it } from "vitest";
import { isPinnedToBottom, shouldFollowTail } from "./scroll-follow";

describe("conversation scroll following", () => {
  it("距底小于 80px 视为钉住，回看超过阈值则不跟随", () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 900, clientHeight: 100 })).toBe(false);
    expect(isPinnedToBottom({ scrollTop: 721, scrollHeight: 900, clientHeight: 100 })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: 720, scrollHeight: 900, clientHeight: 100 })).toBe(false);
    expect(isPinnedToBottom({ scrollTop: 100, scrollHeight: 900, clientHeight: 100 })).toBe(false);
  });

  it("只有钉住底部且末条消息增长时才跟随", () => {
    expect(shouldFollowTail(true, "a:#1#10", "a:#1#10")).toBe(false);
    expect(shouldFollowTail(false, "a:#1#10", "a:#2#20")).toBe(false);
    expect(shouldFollowTail(true, "a:#1#10", "a:#2#20")).toBe(true);
  });
});
