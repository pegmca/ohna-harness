/**
 * P5 · Reflexion（反思阶段）：复用 shouldStopAfterTurn / prepareNextTurn 两个钩子做
 * "自评估 → 重试"闭环。每轮结束后调一次 `streamSimple` 自评上一轮是否朝目标推进；
 * 不满意且预算未耗尽时不停止，并把 `[反思]` 自评写入下轮 context 引导模型修正。
 *
 * 钩子可组合在 P4 Goal 等已有 config 之上（通过 baseShouldStop / basePrepareNextTurn 委托，
 * 不覆盖其预算逻辑）。与 planner.ts 共享 shared.ts 的辅助函数。
 */
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  parseJsonWithRepair,
  streamSimple,
} from "@aiagent/ai";
import type {
  AgentLoopTurnUpdate,
  AgentMessage,
  PrepareNextTurnContext,
  ShouldStopAfterTurnContext,
  StreamFn,
} from "../types.js";
import { extractJsonBlock, extractText, generateText, defaultReflectionPrompt } from "./shared.js";

/**
 * Reflexion 钩子选项。
 * 钩子可组合：传入 baseShouldStop / basePrepareNextTurn 时，满意/预算耗尽后委托给它们，
 * 不覆盖下游（如 P4 Goal）原有的停止/续跑预算逻辑。
 */
export interface ReflexionHookOptions {
  /** 用于自评的模型。 */
  model: Model<Api>;
  /** 自评 LLM 流式函数，缺省 streamSimple。 */
  streamFn?: StreamFn;
  /** 最大反思/重试次数，缺省 3。 */
  maxReflections?: number;
  /** 自评 system 提示，缺省 defaultReflectionPrompt。 */
  reflectionPrompt?: string;
  /** 可组合的底层 shouldStopAfterTurn：满意或预算耗尽后委托。 */
  baseShouldStop?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  /** 可组合的底层 prepareNextTurn：在其结果之上追加反思注入。 */
  basePrepareNextTurn?: (context: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
}

/**
 * 单次反思自评结果。
 */
export interface ReflexionResult {
  /** 上一轮是否满意（朝目标推进）。 */
  satisfactory: boolean;
  /** 不满意时的改进建议；满意时为空串。 */
  critique: string;
}

/**
 * Reflexion 钩子切片：可直接并入 AgentLoopConfig（partial），与 P4 Goal 等配置叠加。
 */
export interface ReflexionHooks {
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
  prepareNextTurn?: (context: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
}

/**
 * 解析模型输出为反思自评结果；解析不到布尔或异常时按"满意/中性"处理，避免无限重试。
 *
 * @param raw 模型原始文本。
 * @returns 自评结果。
 */
function parseReflectionFromModel(raw: string): ReflexionResult {
  const jsonText = extractJsonBlock(raw);
  try {
    const parsed = parseJsonWithRepair<Record<string, unknown>>(jsonText);
    const satisfactory = parsed["satisfactory"];
    const critique = typeof parsed["critique"] === "string" ? (parsed["critique"] as string) : "";
    return { satisfactory: satisfactory === true, critique };
  } catch {
    return { satisfactory: true, critique: "" };
  }
}

/**
 * 把上一轮（assistant + 工具结果）浓缩为文本，供反思自评 prompt 使用。
 *
 * @param context 钩子上下文（shouldStop / prepareNextTurn 共用形状）。
 * @returns 多行文本摘要。
 */
function summarizeTurn(context: ShouldStopAfterTurnContext | PrepareNextTurnContext): string {
  const assistantText = extractText(context.message);
  const toolText = context.toolResults
    .map((r) => r.content.map((c) => ("text" in c ? c.text : "")).join(" "))
    .join("\n");
  return `助手回复：\n${assistantText}\n\n工具结果：\n${toolText || "(无)"}`;
}

/**
 * 构造反思自评上下文：system 用反思提示，单条 user 消息带上一轮摘要与自评格式约定。
 *
 * @param options 反思选项（取 reflectionPrompt）。
 * @param context 钩子上下文。
 * @returns LLM 上下文。
 */
function buildReflectionContext(
  options: ReflexionHookOptions,
  context: ShouldStopAfterTurnContext | PrepareNextTurnContext,
): Context {
  const userContent = [
    "请评估上一轮助手的工作是否朝着目标取得了有效进展。",
    summarizeTurn(context),
    '仅返回 JSON：{ "satisfactory": true|false, "critique": "若不满意，指出问题并建议如何改进" }',
  ].join("\n");
  return {
    systemPrompt: options.reflectionPrompt ?? defaultReflectionPrompt,
    messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
  };
}

/**
 * 构造一条 `[反思]` 用户消息（fenced），注入下轮 context 引导模型修正。
 * 创建新对象，不原地修改调用方数组。
 *
 * @param critique 自评建议。
 * @returns AgentMessage（user）。
 */
function buildCritiqueMessage(critique: string): AgentMessage {
  const body = critique?.trim() ? critique : "上一轮工作未达预期，请自我反思并改进。";
  return { role: "user", content: `[反思]\n${body}`, timestamp: Date.now() };
}

/**
 * 创建 Reflexion 钩子切片：复用 shouldStopAfterTurn / prepareNextTurn 实现自评估→重试闭环。
 *
 * 组合语义（不覆盖下游预算逻辑）：
 * - 满意 或 反思预算耗尽 → 委托 baseShouldStop（若提供），否则默认停止（true）。
 * - 不满意 且 预算未耗尽 → shouldStopAfterTurn 返回 false 不停止；prepareNextTurn 把
 *   `[反思]` 自评注入下轮 context（新建数组，不原地改）。
 *
 * 注意：本切片本身不驱动"下一轮"的触发（loop 内核仅在模型发工具调用或有 pending 消息时
 * 续跑）。与 P4 Goal（getFollowUpMessages 提供续跑消息）叠加时，反思注入自然落入续跑轮次，
 * 形成"目标守卫 + 反思修正"的组合范式，且 agentLoop 内核零改动。
 *
 * @param options 反思钩子选项（含可组合的 base 钩子）。
 * @returns 可直接并入 AgentLoopConfig 的钩子切片 reflexionHooks。
 */
export function createReflexionHook(options: ReflexionHookOptions): ReflexionHooks {
  const streamFn = options.streamFn ?? streamSimple;
  const maxReflections = options.maxReflections ?? 3;

  // 跨轮闭包状态：最近一次反思结果、对应 message（用于同轮内去重调用）、已用反思次数。
  let lastReflection: ReflexionResult | null = null;
  let lastReflectedMessage: AssistantMessage | null = null;
  let reflectionCount = 0;

  /**
   * 取（或计算）本轮反思结果：同一 message 只调一次 streamSimple，失败按中性处理。
   * @param context 钩子上下文。
   * @returns 自评结果。
   */
  async function reflect(context: ShouldStopAfterTurnContext | PrepareNextTurnContext): Promise<ReflexionResult> {
    if (context.message === lastReflectedMessage && lastReflection) {
      return lastReflection;
    }
    lastReflectedMessage = context.message;
    let result: ReflexionResult;
    try {
      const llmContext = buildReflectionContext(options, context);
      const raw = await generateText(streamFn, options.model, llmContext, { maxTokens: 1024 });
      result = parseReflectionFromModel(raw);
    } catch {
      // 反思 LLM 调用失败：当作满意/中性，绝不拖垮主循环。
      result = { satisfactory: true, critique: "" };
    }
    lastReflection = result;
    return result;
  }

  const shouldStopAfterTurn: ReflexionHooks["shouldStopAfterTurn"] = async (context) => {
    const reflection = await reflect(context);
    const canRetry = !reflection.satisfactory && reflectionCount < maxReflections;
    if (canRetry) {
      // 不满意且预算未耗尽：不停止，交给 prepareNextTurn 注入反思后重试。
      return false;
    }
    // 满意或预算耗尽：委托底层（如 P4 Goal）预算逻辑，无则默认停止。
    if (options.baseShouldStop) return await options.baseShouldStop(context);
    return true;
  };

  const prepareNextTurn: ReflexionHooks["prepareNextTurn"] = async (context) => {
    const reflection = await reflect(context);
    const base = options.basePrepareNextTurn ? await options.basePrepareNextTurn(context) : undefined;

    const shouldRetry = !reflection.satisfactory && reflectionCount < maxReflections;
    if (!shouldRetry) return base;

    // 消耗一次反思预算，并把 [反思] 自评注入下轮 context（新建数组，不原地改）。
    reflectionCount += 1;
    const critique = buildCritiqueMessage(reflection.critique);
    const baseContext = base?.context ?? context.context;
    return {
      ...base,
      context: { ...baseContext, messages: [...baseContext.messages, critique] },
    };
  };

  return { shouldStopAfterTurn, prepareNextTurn };
}
