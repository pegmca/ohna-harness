/**
 * format.ts 纯函数单测：重点是 `applyFailure` 承载的「错误落点唯一化」不变量（BUG-001），
 * 以及 `toUiMessages` 的「一条用户消息 → 一条助手消息」归并不变量（BUG-006）。
 */
import { describe, expect, it } from "vitest";
import { applyFailure, formatApiError, toUiMessages } from "./format";
import type { LinearMessageDto } from "@aiagent/types";
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

describe("toUiMessages（BUG-006：单条用户消息对应单条助手消息）", () => {
  /** 构造一条线性消息行（按服务端 LinearMessageDto 形状裁剪）。 */
  function line(partial: Partial<LinearMessageDto> & Pick<LinearMessageDto, "messageId" | "role">): LinearMessageDto {
    return {
      conversationId: "c1",
      createdAt: "2026-10-24T00:00:00Z",
      messageType: "normal",
      content: "",
      ...partial
    } as LinearMessageDto;
  }

  it("同一 runId 的多段 assistant 消息合并为一条（不出现多个头像）", () => {
    const items: LinearMessageDto[] = [
      line({ messageId: "u1", role: "user", content: "帮我查一下", runId: "r1" }),
      line({ messageId: "a1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], runId: "r1" }),
      line({ messageId: "a2", role: "assistant", content: [{ type: "text", text: "查到了结果。" }], runId: "r1" })
    ];
    const messages = toUiMessages(items);
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    // 合并后块顺序保留：先工具调用、后总结文本。
    expect(messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(assistants[0].blocks.map((b: UiContentBlock) => b.type)).toEqual(["toolCall", "text"]);
    expect(assistants[0].content).toBe("查到了结果。");
    expect(firstAssistantRunId(messages)).toBe("r1");
  });

  it("不同 runId 的助手消息各自独立成条（多轮对话不被错误归并）", () => {
    const items: LinearMessageDto[] = [
      line({ messageId: "u1", role: "user", content: "第一轮", runId: "r1" }),
      line({ messageId: "a1", role: "assistant", content: [{ type: "text", text: "答1" }], runId: "r1" }),
      line({ messageId: "u2", role: "user", content: "第二轮", runId: "r2" }),
      line({ messageId: "a2", role: "assistant", content: [{ type: "text", text: "答2" }], runId: "r2" })
    ];
    const messages = toUiMessages(items);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("任一段 assistant 失败时整条 ok=false，但保留已累积内容", () => {
    const items: LinearMessageDto[] = [
      line({ messageId: "u1", role: "user", content: "执行", runId: "r1" }),
      line({ messageId: "a1", role: "assistant", content: [{ type: "text", text: "半截" }], runId: "r1" }),
      line({ messageId: "a2", role: "assistant", content: [{ type: "text", text: "崩溃" }], runId: "r1", stopReason: "error" })
    ];
    const assistants = toUiMessages(items).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].ok).toBe(false);
  });

  it("刷新恢复的失败 assistant 保留 failed 状态与错误正文", () => {
    const items: LinearMessageDto[] = [
      line({ messageId: "u1", role: "user", content: "provider unavailable", runId: "r1" }),
      line({
        messageId: "a1",
        role: "assistant",
        content: [{ type: "text", text: "internal_error: fetch failed" }],
        runId: "r1",
        stopReason: "error"
      })
    ];

    const assistants = toUiMessages(items).filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].status).toBe("failed");
    expect(assistants[0].ok).toBe(false);
    expect(assistants[0].content).toBe("internal_error: fetch failed");
  });
});

/** 取合并后助手消息的 runId（测试辅助，避免重复解构）。 */
function firstAssistantRunId(messages: ReturnType<typeof toUiMessages>): string | undefined {
  return messages.find((m) => m.role === "assistant")?.runId;
}
