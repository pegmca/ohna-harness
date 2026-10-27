import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { describe, expect, it } from "vitest";
import { deriveConfirmationCards, keyParamOfArgs } from "./confirmations";

/** @param sequence 序号。 @param type 事件类型。 @param payload 事件本体。 @returns canonical envelope。 */
function event(sequence: number, type: RunStreamEventDtoV2["type"], payload: unknown): RunStreamEventDtoV2 {
  return {
    eventId: `event-${sequence}`,
    runId: "run-1",
    requestId: "request-1",
    conversationId: "c1",
    sequence,
    type,
    payload,
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

describe("deriveConfirmationCards", () => {
  it("keeps a card pending while confirmation_requested has no matching tool_execution_end", () => {
    const cards = deriveConfirmationCards([
      event(1, "tool_execution_start", { toolCallId: "call-1", toolName: "write" }),
      event(2, "confirmation_requested", {
        toolCallId: "call-1",
        toolName: "write",
        args: { path: "notes.md" },
        summary: "写文件 notes.md"
      })
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "write",
      status: "pending"
    });
  });

  it("resolves a card to allowed after tool_execution_end without error", () => {
    const cards = deriveConfirmationCards([
      event(1, "confirmation_requested", { toolCallId: "call-1", toolName: "write", args: {}, summary: "写文件 a.md" }),
      event(2, "tool_execution_end", { toolCallId: "call-1", toolName: "write", isError: false })
    ]);
    expect(cards[0].status).toBe("allowed");
  });

  it("resolves a card to denied after a deny / timeout tool_execution_end with isError", () => {
    const cards = deriveConfirmationCards([
      event(1, "confirmation_requested", { toolCallId: "call-1", toolName: "bash", args: {}, summary: "执行命令 rm" }),
      event(2, "tool_execution_end", { toolCallId: "call-1", toolName: "bash", isError: true })
    ]);
    expect(cards[0].status).toBe("denied");
  });

  it("keeps parallel toolCallIds as independent cards", () => {
    const cards = deriveConfirmationCards([
      event(1, "confirmation_requested", { toolCallId: "call-1", toolName: "write", args: {}, summary: "写 1" }),
      event(2, "confirmation_requested", { toolCallId: "call-2", toolName: "edit", args: {}, summary: "改 2" }),
      event(3, "tool_execution_end", { toolCallId: "call-2", toolName: "edit", isError: false })
    ]);
    expect(cards.map((card) => [card.toolCallId, card.status])).toEqual([
      ["call-1", "pending"],
      ["call-2", "allowed"]
    ]);
  });

  it("deduplicates replayed frames by sequence and ignores ends without a prior request", () => {
    const cards = deriveConfirmationCards([
      event(1, "confirmation_requested", { toolCallId: "call-1", toolName: "write", args: {}, summary: "写 1" }),
      // replay 重投同一帧（sequence 相同）应被忽略，不产生第二张卡。
      event(1, "confirmation_requested", { toolCallId: "call-1", toolName: "write", args: {}, summary: "写 1" }),
      // 无请求的 end 不应影响任何卡片。
      event(2, "tool_execution_end", { toolCallId: "call-9", toolName: "bash", isError: true })
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe("pending");
  });

  it("does not downgrade an already resolved card on a later end frame", () => {
    const cards = deriveConfirmationCards([
      event(1, "confirmation_requested", { toolCallId: "call-1", toolName: "write", args: {}, summary: "写 1" }),
      event(2, "tool_execution_end", { toolCallId: "call-1", toolName: "write", isError: false }),
      event(3, "tool_execution_end", { toolCallId: "call-1", toolName: "write", isError: true })
    ]);
    expect(cards[0].status).toBe("allowed");
  });
});

describe("keyParamOfArgs", () => {
  it("prefers bash command over paths", () => {
    expect(keyParamOfArgs({ command: "pnpm test", path: "x" })).toBe("pnpm test");
  });
  it("falls back to path-like fields", () => {
    expect(keyParamOfArgs({ path: "notes.md" })).toBe("notes.md");
    expect(keyParamOfArgs({ file_path: "a/b.ts" })).toBe("a/b.ts");
  });
  it("returns undefined for unknown args", () => {
    expect(keyParamOfArgs({})).toBeUndefined();
  });
});
