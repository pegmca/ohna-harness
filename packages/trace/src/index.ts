export interface TraceSummary {
  packageName: string;
  eventCount: number;
}

export type TraceEventType = "tool_call";

export interface TraceToolCallEvent {
  type: "tool_call";
  id: string;
  traceId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs: number;
  ok: boolean;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  createdAt: string;
}

export type TraceEvent = TraceToolCallEvent;

export interface TraceRecorder {
  readonly traceId: string;
  /**
   * 记录单个 trace event，调用方不需要知道 recorder 的存储细节。
   *
   * @param event 要追加到当前 trace 的事件。
   */
  record(event: TraceEvent): void;
  /**
   * 读取当前 trace 的事件快照，避免外部直接修改内部数组。
   *
   * @returns 当前 trace 下的事件列表。
   */
  getEvents(): TraceEvent[];
}

/**
 * 创建 trace 摘要，当前用于验证 trace package 边界已经可被其他 package 引用。
 *
 * @returns trace package 的最小摘要信息。
 */
export function createTraceSummary(): TraceSummary {
  return {
    packageName: "@aiagent/trace",
    eventCount: 0
  };
}

/**
 * 创建内存 trace recorder，供本地开发、mock 工具和后续前端 timeline 消费。
 *
 * @param traceId 一次请求或一次手动验证的稳定 trace 标识。
 * @returns 可记录并读取事件的内存 recorder。
 */
export function createInMemoryTraceRecorder(traceId = createTraceId()): TraceRecorder {
  const events: TraceEvent[] = [];

  /**
   * 追加单个 trace event，保持 recorder 实现对调用方透明。
   *
   * @param event 要记录的事件。
   */
  function record(event: TraceEvent): void {
    events.push(event);
  }

  /**
   * 返回事件快照，避免调用方修改 recorder 内部状态。
   *
   * @returns 当前 trace 的事件列表。
   */
  function getEvents(): TraceEvent[] {
    return [...events];
  }

  return {
    traceId,
    record,
    getEvents
  };
}

/**
 * 生成轻量 trace id，避免引入运行时依赖并保持浏览器/Node 都可用。
 *
 * @returns 带 trace_ 前缀的请求链路标识。
 */
export function createTraceId(): string {
  return `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
