/**
 * run_events → 打分证据的投影（新持久化读取路径的 eval 形态）。
 *
 * 生产侧对应 run_events 表 + 读模型投影（见 docs/worktree/05、06）：
 * eval 在内存中按同样口径把 loop 事件与能力事件（retrieval / workflow_node /
 * pdf_export）投影为与 fixture 同形状的证据，供 automation.ts 的确定性打分复用。
 */
import type { AgentMessage } from "@aiagent/agent";
import type { AssistantMessage } from "@aiagent/ai";
import type { UnifiedEvalCase, UnifiedEvalFixture } from "./automation.js";

/**
 * run_events 记录：eval 内的有序事件存储，模拟新持久化读取路径。
 */
export interface LoopEvalRunEvent {
  /** run 内单调递增序号，对齐 run_events 有序重放语义。 */
  seq: number;
  /** 事件名：loop 事件（agent_start 等）或能力事件（retrieval / workflow_node / pdf_export）。 */
  type: string;
  /** 事件本体：loop 事件为 AgentEvent 的相关字段，能力事件为 sink payload。 */
  payload: Record<string, unknown>;
}

/**
 * 从 run_events 投影打分证据：
 * - answer：最后一条 stop 收尾的 assistant 消息文本（message_end 事件）；
 * - retrievedChunks / citations：retrieval 事件 payload + generate_report 工具结果 details；
 * - workflow：workflow_node 事件按 seq 顺序的节点名；
 * - sections / exportStatus：generate_report details 与 pdf_export 事件；
 * - ok：agent_end 正常收尾（无 error、未超预算、存在 stop 收尾的 assistant 消息）。
 *
 * @param item 数据集用例。
 * @param events 本次 run 的 run_events。
 * @param flags 预算截停标记与实测延迟。
 * @returns 与 fixture 同形状的证据，供 scoreCaseWithEvidence 打分。
 */
export function projectRunEvents(
  item: UnifiedEvalCase,
  events: LoopEvalRunEvent[],
  flags: { budgetExceeded: boolean; latencyMs: number },
): UnifiedEvalFixture {
  const finalAssistant = findFinalStopAssistant(events);
  const retrievalPayload = findRetrievalPayload(events);
  const reportDetails = findReportToolDetails(events);
  const pdfPayload = events.filter((event) => event.type === "pdf_export").at(-1)?.payload as
    | { status?: UnifiedEvalFixture["exportStatus"] }
    | undefined;

  const agentEnd = events.filter((event) => event.type === "agent_end").at(-1);
  const agentEndError = (agentEnd?.payload as { error?: unknown } | undefined)?.error;
  const ok = Boolean(agentEnd) && !agentEndError && !flags.budgetExceeded && Boolean(finalAssistant);

  return {
    answer: extractAssistantText(finalAssistant),
    citations: dedupeCitations([...(retrievalPayload?.citations ?? []), ...(reportDetails?.citations ?? [])]),
    retrievedChunks: retrievalPayload?.chunks ?? [],
    workflow: events
      .filter((event) => event.type === "workflow_node")
      .map((event) => String((event.payload as { node: unknown }).node)),
    sections: reportDetails?.sections ?? [],
    exportStatus: pdfPayload?.status ?? reportDetails?.exportStatus,
    ok,
    latencyMs: flags.latencyMs,
    traceId: `run-${item.id}`,
    requestId: `req-${item.id}`,
  };
}

/**
 * 取最后一条 stop 收尾的 assistant 消息（message_end 事件投影）。
 *
 * @param events 本次 run 的 run_events。
 * @returns 最终 assistant 消息；不存在（error/aborted 收尾）时返回 undefined。
 */
function findFinalStopAssistant(events: LoopEvalRunEvent[]): AssistantMessage | undefined {
  return events
    .filter((event) => event.type === "message_end")
    .map((event) => (event.payload as { message: AgentMessage }).message)
    .filter((message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "stop")
    .at(-1);
}

/**
 * 拼接 assistant 消息的纯文本内容。
 *
 * @param message assistant 消息（可能为空）。
 * @returns 文本；无消息时为空串。
 */
function extractAssistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** retrieval 事件 payload 的投影视图。 */
interface RetrievalEventView {
  chunks?: Array<{ id: string; source: string; text: string }>;
  citations?: Array<{ source: string; quote: string }>;
}

/**
 * 取最后一条 retrieval 事件的 payload（grounding hook 写入的检索证据快照）。
 *
 * @param events 本次 run 的 run_events。
 * @returns retrieval payload；无检索时返回 undefined。
 */
function findRetrievalPayload(events: LoopEvalRunEvent[]): RetrievalEventView | undefined {
  return events.filter((event) => event.type === "retrieval").at(-1)?.payload as RetrievalEventView | undefined;
}

/** generate_report 工具结果 details 的投影视图。 */
interface ReportToolDetailsView {
  sections?: string[];
  citations?: Array<{ source: string; quote: string }>;
  exportStatus?: UnifiedEvalFixture["exportStatus"];
}

/**
 * 取最后一次成功的 generate_report 工具执行结果 details。
 *
 * @param events 本次 run 的 run_events。
 * @returns 工具结果 details；未调用或失败时返回 undefined。
 */
function findReportToolDetails(events: LoopEvalRunEvent[]): ReportToolDetailsView | undefined {
  const toolEnd = events
    .filter((event) => event.type === "tool_execution_end")
    .map((event) => event.payload as { toolName: string; result: { details?: Record<string, unknown> }; isError: boolean })
    .filter((payload) => payload.toolName === "generate_report" && !payload.isError)
    .at(-1);
  return toolEnd?.result.details as ReportToolDetailsView | undefined;
}

/**
 * 按 source+quote 去重 citation，保持先出现者优先（retrieval 先于 report）。
 *
 * @param citations 合并前的 citation 列表。
 * @returns 去重后的 citation 列表。
 */
function dedupeCitations(citations: Array<{ source: string; quote: string }>): Array<{ source: string; quote: string }> {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.source} ${citation.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
