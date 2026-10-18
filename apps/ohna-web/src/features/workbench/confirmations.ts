/**
 * 待确认卡片推导与提交（W-4 / W-9）。
 *
 * 推导规则（已定案，docs/v1.3/03 §6.3 /  §6）：
 * pending = 「收到 `confirmation_requested` 且**无后续同 `toolCallId` 的 `tool_execution_end`」。
 * 内核在确认前就会发 `tool_execution_start`（prepare 先于确认钩子），不能用「无 start」推导；
 * allow 后 end.isError=false，deny / 确认超时后 end.isError=true（block 回喂）。
 *
 * 该事件照常落盘，页面刷新后经 SSE replay 重新投递，同一推导函数即可恢复未决卡片（W-9）。
 */
import type { ApiResult, RunStreamEventDtoV2 } from "@aiagent/types";
import { parseApiResult } from "../../shared/api/http-client";

/** 卡片状态：pending（未决）/ allowed（已允许）/ denied（已拒绝，含 deny 与确认超时）。 */
export type ConfirmationCardStatus = "pending" | "allowed" | "denied";

/** 待确认 / 已决卡片：按 toolCallId 唯一，多个并行确认互不影响。 */
export interface ConfirmationCard {
  runId: string;
  toolCallId: string;
  toolName: string;
  /** 工具参数（write/edit 的 path、bash 的 command 等），原样透传。 */
  args: Record<string, unknown>;
  /** 服务端生成的摘要（如「写文件 notes.md」）。 */
  summary: string;
  status: ConfirmationCardStatus;
}

/** confirmation_requested payload 的窄形状。 */
interface ConfirmationRequestedPayload {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  summary?: string;
}

/** tool_execution_end payload 的窄形状。 */
interface ToolExecutionEndPayload {
  toolCallId?: string;
  isError?: boolean;
}

/**
 * 从 run 事件流（实时或 replay，可含重复帧）推导确认卡片。
 *
 * @param events 按到达顺序的 canonical envelope 列表。
 * @returns 按「首次确认请求顺序」排列的卡片列表，每个 toolCallId 一张。
 */
export function deriveConfirmationCards(events: RunStreamEventDtoV2[]): ConfirmationCard[] {
  const cards = new Map<string, ConfirmationCard>();
  let lastSequence = 0;
  for (const event of events) {
    // replay + live 混流时允许重复 / 乱序到达：只处理 sequence 严格递增的新帧。
    if (event.sequence <= lastSequence) continue;
    lastSequence = event.sequence;

    if (event.type === "confirmation_requested") {
      const payload = (event.payload ?? {}) as ConfirmationRequestedPayload;
      if (!payload.toolCallId || cards.has(payload.toolCallId)) continue;
      cards.set(payload.toolCallId, {
        runId: event.runId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName ?? "unknown",
        args: payload.args ?? {},
        summary: payload.summary ?? `执行 ${payload.toolName ?? "工具"}`,
        status: "pending"
      });
      continue;
    }

    if (event.type === "tool_execution_end") {
      const payload = (event.payload ?? {}) as ToolExecutionEndPayload;
      const card = payload.toolCallId ? cards.get(payload.toolCallId) : undefined;
      if (!card) continue;
      // 只收敛未决卡片；重复 end（理论不存在）不回退已决态。
      if (card.status === "pending") {
        card.status = payload.isError === true ? "denied" : "allowed";
      }
    }
  }
  return [...cards.values()];
}

/** 待确认卡片的决策。 */
export type ConfirmationDecision = "allow" | "deny";

/**
 * 提交确认决定：`POST /api/runs/:runId/confirmations/:toolCallId`。
 * 409（已决 / 自动批准）与 404（未知 toolCallId）都以结构化错误返回，由 UI 展示在对应卡片上。
 *
 * @param runId Run 标识。
 * @param toolCallId 待确认工具调用 ID。
 * @param decision allow / deny。
 * @param signal 取消信号。
 * @returns 结构化提交结果。
 */
export async function submitConfirmation(
  runId: string,
  toolCallId: string,
  decision: ConfirmationDecision,
  signal?: AbortSignal
): Promise<ApiResult<{ toolCallId: string; decision: ConfirmationDecision }>> {
  return parseApiResult(await fetch(
    `/api/runs/${encodeURIComponent(runId)}/confirmations/${encodeURIComponent(toolCallId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
      signal
    }
  ));
}

/**
 * 从工具参数提取卡片上的关键参数行：bash 展示 command，写类工具展示路径。
 *
 * @param args 工具参数。
 * @returns 关键参数文本；无 recognizable 参数返回 undefined。
 */
export function keyParamOfArgs(args: Record<string, unknown>): string | undefined {
  const command = args.command;
  if (typeof command === "string") return command;
  const path = args.path ?? args.file_path ?? args.target;
  if (typeof path === "string") return path;
  return undefined;
}
