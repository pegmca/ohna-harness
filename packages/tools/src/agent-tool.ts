/**
 * defineAgentTool：把「zod schema + 业务执行函数」包装成 AgentTool 的工厂。
 * 每个工具适配器的 execute 内套同一 withTimeoutAndRetry helper（超时/重试/deadline 语义），
 * loop 层对这些横切逻辑无感知。
 */
import { z } from "zod";
import { withTimeoutAndRetry } from "./executor.js";
import type { AgentTool, AgentToolResult, ToolExecutionOptions, ToolExecutionMode } from "./types.js";

/** defineAgentTool 的配置项。 */
export interface DefineAgentToolConfig<TSchema extends z.ZodType, TOutput> {
  name: string;
  description: string;
  /** 面向 UI 的可读名称；缺省用 name。 */
  label?: string;
  /** zod 参数 schema。 */
  parameters: TSchema;
  /** 可选 zod 输出 schema；提供时对执行结果再校验一次，防止坏数据进 LLM 上下文。 */
  outputSchema?: z.ZodType<TOutput>;
  executionMode?: ToolExecutionMode;
  /** 原始参数兼容 shim（对齐 pi prepareArguments），zod 校验前调用。 */
  prepareArguments?: (args: unknown) => unknown;
  /** 超时/重试/deadline 包装选项（per-tool 默认值；run 级 deadline 由调用方覆盖）。 */
  execution?: Pick<ToolExecutionOptions, "timeoutMs" | "retry" | "hasSideEffects" | "idempotent" | "idempotencyKey" | "now" | "sleep">;
  /** 把结构化输出序列化为回喂模型的文本；默认 pretty JSON。 */
  formatResult?: (output: TOutput) => string;
  /** 数据来源标记：real 或 mock；v1.2 起统一 real。 */
  source?: "real" | "mock";
  /**
   * 业务执行体；入参已通过 zod 校验。失败直接抛异常（可带 code/retryable 标记），
   * 包装层负责转结构化错误。
   */
  execute: (params: z.infer<TSchema>, signal?: AbortSignal) => Promise<TOutput> | TOutput;
}

/**
 * 创建 AgentTool：execute 内完成 zod 入参校验 → withTimeoutAndRetry 包装 → 可选出参校验 →
 * 组装 AgentToolResult（content 回喂模型、details 供 trace/UI）。
 *
 * @param config 工具配置。
 * @returns 可直接注入 AgentContext.tools 的 AgentTool。
 * @template TSchema zod 参数 schema 类型。
 * @template TOutput 结构化输出类型（同时是 details 类型）。
 */
export function defineAgentTool<TSchema extends z.ZodType, TOutput = unknown>(
  config: DefineAgentToolConfig<TSchema, TOutput>,
): AgentTool<TSchema, TOutput> {
  const formatResult = config.formatResult ?? ((output: TOutput) => JSON.stringify(output, null, 2));

  return {
    name: config.name,
    description: config.description,
    label: config.label ?? config.name,
    parameters: config.parameters,
    ...(config.prepareArguments
      ? { prepareArguments: config.prepareArguments as (args: unknown) => z.infer<TSchema> }
      : {}),
    ...(config.executionMode ? { executionMode: config.executionMode } : {}),
    ...(config.source ? { source: config.source } : {}),
    /**
     * AgentTool.execute 实现；抛出的带 code Error 由 loop 转成 isError ToolResultMessage。
     *
     * @param _toolCallId 工具调用 id（本层不消费，保留给具体工具打点）。
     * @param params 调用方参数（loop 已校验过；这里再 safeParse 一次保护直接调用方）。
     * @param signal run 级 AbortSignal。
     * @returns 结构化工具结果。
     */
    async execute(_toolCallId, params, signal) {
      const parsed = config.parameters.safeParse(params);
      if (!parsed.success) {
        throw Object.assign(new Error(`Invalid arguments for tool: ${config.name}`), {
          code: "validation_error",
          details: { issues: parsed.error.issues },
        });
      }

      const output = await withTimeoutAndRetry((innerSignal) => config.execute(parsed.data, innerSignal), {
        ...config.execution,
        signal,
      });

      if (config.outputSchema) {
        const parsedOutput = config.outputSchema.safeParse(output);
        if (!parsedOutput.success) {
          throw Object.assign(new Error(`Invalid output from tool: ${config.name}`), {
            code: "output_validation_error",
            details: { issues: parsedOutput.error.issues },
          });
        }
      }

      const result: AgentToolResult<TOutput> = {
        content: [{ type: "text", text: formatResult(output) }],
        details: output,
      };
      return result;
    },
  };
}
