import type { LlmChatResponse, LlmResult } from "@aiagent/types";
import type { NormalizedLlmClientConfig } from "./config.js";
import { elapsedMs, isRecord } from "./utils.js";

/**
 * 包装 LLM client 的公开调用，记录模型调用耗时、用量和结构化错误。
 *
 * @template TResult LLM 调用成功时的数据类型。
 * @param config 已归一化的 LLM client 配置。
 * @param purpose 调用目的，供 trace timeline 区分 chat/json/tool/stream。
 * @param action 实际模型调用逻辑。
 * @returns 原始 LLM 调用结果。
 */
export async function traceModelCall<TResult>(
  config: NormalizedLlmClientConfig,
  purpose: string,
  action: () => Promise<LlmResult<TResult>>
): Promise<LlmResult<TResult>> {
  const startedAt = performance.now();
  const result = await action();
  const traceRecorder = config.traceRecorder;

  if (!traceRecorder) {
    return result;
  }

  try {
    traceRecorder.record({
      type: "model_call",
      id: createTraceEventId(traceRecorder.traceId, `llm_${purpose}`),
      traceId: traceRecorder.traceId,
      requestId: traceRecorder.requestId,
      model: getTraceModel(result, config.model),
      purpose,
      durationMs: elapsedMs(startedAt),
      ok: result.ok,
      usage: result.ok ? getTraceUsage(result.data) : undefined,
      error: result.ok ? undefined : result.error,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，不能改变 LLM client 的主结果。
  }

  return result;
}

/**
 * 从 LLM 结果中提取模型名，失败时回退到配置模型，避免记录 unknown 影响排障。
 *
 * @param result LLM 调用结果。
 * @param fallbackModel 配置中的模型名。
 * @returns trace 中展示的模型名。
 */
function getTraceModel<TResult>(result: LlmResult<TResult>, fallbackModel: string): string {
  if (result.ok && isRecord(result.data) && typeof result.data.model === "string") {
    return result.data.model;
  }

  return fallbackModel;
}

/**
 * 从成功结果中提取 token usage，stream 建连等无 usage 的路径返回 undefined。
 *
 * @param data LLM 成功结果。
 * @returns token usage 或 undefined。
 */
function getTraceUsage(data: unknown): LlmChatResponse["usage"] {
  if (isRecord(data) && isRecord(data.usage)) {
    return data.usage as LlmChatResponse["usage"];
  }

  return undefined;
}

/**
 * 生成 LLM client trace event id，避免为可观测能力新增 UUID 依赖。
 *
 * @param traceId 当前 trace id。
 * @param label 事件标签。
 * @returns trace event id。
 */
function createTraceEventId(traceId: string, label: string): string {
  return `${traceId}_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
