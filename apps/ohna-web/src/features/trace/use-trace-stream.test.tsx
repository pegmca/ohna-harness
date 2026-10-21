/**
 * TC-L2-01 · `useTraceStream` 数据编排回归。
 *
 * 原 `TracePage.test.tsx` 的 5 个用例在此以 hook 形态全量迁移（03 风险表：「TracePage 原测试
 * 不删只改挂载点」）：run 加载、replay 恢复、follow 续传、terminalFallback、重复序号去重，
 * 另补 conversationId 切换的竞态丢弃（切换后迟到的旧会话响应不得写回新视图）。
 *
 * 测试手法：用一个极小的探针组件把 hook 的返回值写到 DOM，断言仍基于用户可见文本/属性。
 */
import type { RunStreamEventDtoV2 } from "@aiagent/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  liveRun,
  managedRun,
  realOrderEvents,
  runEvent,
  terminalRun
} from "./trace-fixtures";
import { useTraceStream } from "./use-trace-stream";

const listConversationRuns = vi.fn();
const getRunSnapshot = vi.fn();
const replayRunEvents = vi.fn();
const followRunEvents = vi.fn();

vi.mock("../../shared/api/conversation-client", () => ({
  getRunSnapshot: (...args: unknown[]) => getRunSnapshot(...args)
}));
vi.mock("../../shared/api/run-stream-client", () => ({
  replayRunEvents: (...args: unknown[]) => replayRunEvents(...args),
  followRunEvents: (...args: unknown[]) => followRunEvents(...args)
}));
vi.mock("./trace-client", () => ({
  listConversationRuns: (...args: unknown[]) => listConversationRuns(...args)
}));

/**
 * Hook 探针：把关键状态渲染成可断言的 DOM。
 *
 * @param props.conversationId 当前会话。
 * @param props.enabled 是否启用（抽屉展开态）。
 * @returns 状态摘要。
 */
function Probe(props: { conversationId: string | undefined; enabled?: boolean }) {
  const trace = useTraceStream(props.conversationId, props.enabled ?? true);
  return (
    <div>
      <p data-testid="runs">{trace.runs.map((run) => run.runId).join(",")}</p>
      <p data-testid="active">{trace.activeRunId}</p>
      <p data-testid="kinds">{trace.rows.map((row) => row.kind).join(",")}</p>
      <p data-testid="loading">{String(trace.isLoading)}</p>
      <p data-testid="error">{trace.error ?? ""}</p>
      {trace.runs.map((run) => (
        <button key={run.runId} onClick={() => trace.selectRun(run.runId)} type="button">
          select {run.runId}
        </button>
      ))}
    </div>
  );
}

/**
 * 读取探针状态。
 *
 * @param testId 探针字段名。
 * @returns 文本内容（缺失时为空串）。
 */
function stateText(testId: string): string {
  return screen.getByTestId(testId).textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useTraceStream", () => {
  it("加载 run 列表并默认选中第一个 run", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [liveRun, terminalRun] });
    followRunEvents.mockResolvedValue(undefined);

    render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(stateText("runs")).toBe("run-live-2,run-terminal-1"));
    expect(stateText("active")).toBe("run-live-2");
    expect(listConversationRuns).toHaveBeenCalledWith("conv-1", expect.anything());
  });

  it("终态 run 走 replay，事件按真实顺序投影（llm_call 先于助手 message_end）", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun] });
    replayRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      for (const event of realOrderEvents()) options.onEvent(event);
    });

    render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(replayRunEvents).toHaveBeenCalledWith("run-terminal-1", expect.anything()));
    await waitFor(() => expect(stateText("kinds")).toBe("message,llm,message,terminal"));
    expect(followRunEvents).not.toHaveBeenCalled();
    expect(stateText("loading")).toBe("false");
  });

  it("运行中的 run 走 follow 续传，终态后列表刷新", async () => {
    listConversationRuns
      .mockResolvedValueOnce({ ok: true, requestId: "r", data: [liveRun] })
      .mockResolvedValue({ ok: true, requestId: "r", data: [{ ...liveRun, status: "completed" }] });
    followRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      options.onEvent(runEvent(1, "run_status", { status: "completed" }, "run-live-2"));
    });

    render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(followRunEvents).toHaveBeenCalledWith("run-live-2", expect.anything()));
    await waitFor(() => expect(stateText("kinds")).toBe("terminal"));
    expect(replayRunEvents).not.toHaveBeenCalled();
    // 终态后重新拉列表，run 选择器的状态与事件流一致。
    await waitFor(() => expect(listConversationRuns.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("同一 sequence 重复投递只投影一行", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun] });
    replayRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      const event = runEvent(2, "message_end", { message: { role: "user", content: "dup" } });
      options.onEvent(event);
      options.onEvent(event);
    });

    render(<Probe conversationId="conv-1" />);
    // 只应有 1 条 message 行；follow 收尾后的终态兜底条（completed → terminal）是预期内的额外行。
    await waitFor(() => expect(stateText("kinds").startsWith("message")).toBe(true));
    expect(stateText("kinds").split(",").filter((kind) => kind === "message")).toHaveLength(1);
  });

  it("S2: follow 未收到 run_status 时用快照合成终态条", async () => {
    listConversationRuns
      .mockResolvedValueOnce({ ok: true, requestId: "r", data: [liveRun] })
      .mockResolvedValue({ ok: true, requestId: "r", data: [{ ...liveRun, status: "failed" }] });
    followRunEvents.mockImplementation(async (_runId: string, options: { onEvent: (event: RunStreamEventDtoV2) => void }) => {
      // follow 以 agent_end 结束，run_status 被丢弃（真实行为）。
      options.onEvent(runEvent(1, "agent_end", { messages: [] }, "run-live-2"));
    });
    getRunSnapshot.mockResolvedValue({
      ok: true,
      requestId: "r",
      data: {
        runId: "run-live-2",
        requestId: "sess-1:2",
        conversationId: "conv-1",
        userMessageId: "",
        modelId: "stub-model",
        mode: "observe",
        source: "cli",
        status: "failed",
        lastEventSequence: 3,
        error: { code: "agent_failed", message: "loop 抛出异常", requestId: "sess-1:2" },
        createdAt: "2026-10-20T00:00:02.000Z",
        updatedAt: "2026-10-20T00:00:03.000Z"
      }
    });

    render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(stateText("kinds")).toBe("terminal"));
    expect(getRunSnapshot).toHaveBeenCalledWith("run-live-2", expect.anything());
  });

  it("run 列表请求失败（ok:false 与 reject）展示可读错误态", async () => {
    listConversationRuns.mockResolvedValueOnce({
      ok: false,
      requestId: "r",
      error: { code: "internal_error", message: "run 列表加载失败", requestId: "r" }
    });
    const first = render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(stateText("error")).toBe("run 列表加载失败"));
    first.unmount();

    listConversationRuns.mockRejectedValueOnce(new Error("network down"));
    render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(stateText("error")).toContain("加载 run 列表失败"));
  });

  it("收敛：conversationId 切换后旧会话的迟到响应被丢弃（竞态）", async () => {
    const pending = deferred<unknown>();
    listConversationRuns.mockImplementation(async (conversationId: string) => {
      if (conversationId === "conv-1") return pending.promise;
      return { ok: true, requestId: "r", data: [managedRun] };
    });
    followRunEvents.mockResolvedValue(undefined);

    const { rerender } = render(<Probe conversationId="conv-1" />);
    rerender(<Probe conversationId="conv-2" />);
    await waitFor(() => expect(stateText("runs")).toBe("run-managed-3"));

    pending.resolve({ ok: true, requestId: "r", data: [terminalRun] });
    // 迟到的 conv-1 响应不得覆盖 conv-2 的视图。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stateText("runs")).toBe("run-managed-3");
  });

  it("切换 run 时中止上一条事件流并按新 run 重新加载", async () => {
    listConversationRuns.mockResolvedValue({ ok: true, requestId: "r", data: [terminalRun, liveRun] });
    replayRunEvents.mockImplementation(async (_runId: string, options: { signal?: AbortSignal }) => {
      // 阻塞到被中止：模拟「用户切换 run 时旧流仍在传输」。
      await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
    });
    followRunEvents.mockResolvedValue(undefined);

    render(<Probe conversationId="conv-1" />);
    await waitFor(() => expect(stateText("active")).toBe("run-terminal-1"));
    fireEvent.click(screen.getByRole("button", { name: "select run-live-2" }));
    await waitFor(() => expect(stateText("active")).toBe("run-live-2"));
    await waitFor(() => expect(followRunEvents).toHaveBeenCalledWith("run-live-2", expect.anything()));
  });

  it("抽屉收起（enabled=false）时不发任何请求", async () => {
    render(<Probe conversationId="conv-1" enabled={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listConversationRuns).not.toHaveBeenCalled();
    expect(replayRunEvents).not.toHaveBeenCalled();
    expect(followRunEvents).not.toHaveBeenCalled();
  });
});

/**
 * 可外部 resolve 的 Promise。
 *
 * @template T 结果类型。
 * @returns Promise 与其 resolver。
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
