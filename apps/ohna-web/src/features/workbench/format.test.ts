/**
 * format.ts 纯函数单测：重点是 `applyFailure` 承载的「错误落点唯一化」不变量（BUG-001）。
 */
import { describe, expect, it } from "vitest";
import { applyFailure, formatApiError } from "./format";
import type { UiContentBlock } from "./types";

/** 带诊断字段的失败错误（status / cause 参与格式化）。 */
const ERROR = {
  code: "agent_failed" as const,
  message: "LLM request timed out.",
  requestId: "request_failed",
  details: { status: 502, cause: "proxy_unreachable" }
};

/** 含残留文本的内容块。 */
const RESIDUAL_BLOCKS: UiContentBlock[] = [{ type: "text", text: "半截回答" }];

describe("applyFailure", () => {
  it("有残留文本时正文保留残留，error 保留供 error-block 渲染", () => {
    const patch = applyFailure(ERROR, RESIDUAL_BLOCKS, false);

    expect(patch.content).toBe("半截回答");
    expect(patch.blocks).toBe(RESIDUAL_BLOCKS);
    expect(patch.error).toBe(ERROR);
    expect(patch.status).toBe("failed");
    expect(patch.runStatus).toBe("failed");
    expect(patch.ok).toBe(false);
    expect(patch.liveEvents).toBeUndefined();
    // 正文不得混入格式化错误，否则结构化错误会在正文与 error-block 各出现一次。
    expect(patch.content).not.toContain("agent_failed");
  });

  it("无残留文本时正文承载格式化错误且清空 error，避免重复展示", () => {
    const patch = applyFailure(ERROR, [], false);

    expect(patch.content).toBe(formatApiError(ERROR));
    expect(patch.content).toBe("agent_failed: LLM request timed out. (status=502, cause=proxy_unreachable)");
    expect(patch.error).toBeUndefined();
    expect(patch.status).toBe("failed");
  });

  it("只有空白残留文本时按无残留处理", () => {
    const patch = applyFailure(ERROR, [{ type: "text", text: "  \n  " }], false);

    expect(patch.content).toBe(formatApiError(ERROR));
    expect(patch.error).toBeUndefined();
  });

  it("仅含 thinking / toolCall 块时正文仍承载格式化错误", () => {
    const patch = applyFailure(ERROR, [{
      type: "toolCall",
      id: "tool-1",
      name: "bash",
      arguments: { command: "ls" }
    }], false);

    expect(patch.content).toBe(formatApiError(ERROR));
    expect(patch.blocks).toHaveLength(1);
    expect(patch.error).toBeUndefined();
  });

  it("用户取消时状态为 cancelled 但同样遵循错误落点规则", () => {
    const cancelled = { code: "request_cancelled" as const, message: "Run 已被取消。", requestId: "request_cancelled" };

    const withResidual = applyFailure(cancelled, RESIDUAL_BLOCKS, true);
    expect(withResidual.status).toBe("cancelled");
    expect(withResidual.runStatus).toBe("cancelled");
    expect(withResidual.content).toBe("半截回答");
    expect(withResidual.error).toBe(cancelled);

    const withoutResidual = applyFailure(cancelled, [], true);
    expect(withoutResidual.status).toBe("cancelled");
    expect(withoutResidual.content).toBe("request_cancelled: Run 已被取消。");
    expect(withoutResidual.error).toBeUndefined();
  });
});
