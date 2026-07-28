import type { ObservableTraceRecorder, TraceEvent } from "@aiagent/trace";

export interface PacedTraceRecorder extends ObservableTraceRecorder {
  flush(): Promise<void>;
}

/**
 * Mock 专用事件产生器装饰器；延迟发生在事件进入 canonical recorder 之前。
 *
 * @param target 实际 recorder。
 * @param delayMs 首次语义类别间隔。
 * @param signal Run 取消信号；取消时立即释放剩余演示等待。
 * @returns 可等待全部事件产生完成的 recorder。
 */
export function createPacedTraceRecorder(
  target: ObservableTraceRecorder,
  delayMs: number,
  signal?: AbortSignal
): PacedTraceRecorder {
  let queue = Promise.resolve();
  const seen = new Set<string>();
  return {
    traceId: target.traceId,
    requestId: target.requestId,
    record(event) {
      const category = categoryOf(event.type);
      const shouldDelay = !seen.has(category) && seen.size > 0 && delayMs > 0;
      seen.add(category);
      queue = queue.then(async () => {
        if (shouldDelay) await abortableDelay(Math.min(3_000, delayMs), signal);
        target.record(event);
      });
    },
    getEvents: () => target.getEvents(),
    getTrace: () => target.getTrace(),
    subscribe: (listener) => target.subscribe(listener),
    flush: () => queue
  };
}

/** @param durationMs 延迟。 @param signal 取消信号。 @returns 延迟或取消完成 Promise。 */
function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, durationMs);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** @param type Trace 类型。 @returns 稳定 UI 语义类别。 */
function categoryOf(type: TraceEvent["type"]): string {
  if (type === "request_received" || type === "intent_routed" || type === "security") return "routing";
  if (type === "model_call") return "model";
  if (type === "retrieval") return "retrieval";
  if (type === "tool_call" || type === "mcp_tool_call" || type === "mcp_tool_discovered") return "tools";
  if (
    type === "approval"
    || type === "report_skill_activation"
    || type === "report_plan"
    || type === "workflow_node"
    || type === "citation_verifier"
    || type === "pdf_export"
  ) return "workflow";
  return "finalizing";
}
