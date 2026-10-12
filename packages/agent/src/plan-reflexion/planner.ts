/**
 * P5 · Plan-and-Execute（规划阶段）：在 `agentLoop` 之前用一次 LLM 调用把目标拆成
 * 子任务图（Plan）。解析失败结构化降级为单子任务计划，绝不直接抛错给调用方。
 *
 * 本文件只负责"规划"这一侧；反思一侧见 reflexion.ts，二者共享 shared.ts 的辅助。
 */
import { type Api, type Context, type Model, parseJsonWithRepair, streamSimple } from "@aiagent/ai";
import type { AgentContext, AgentMessage, StreamFn } from "../types.js";
import { extractJsonBlock, extractText, generateText, defaultPlanSystemPrompt } from "./shared.js";

/**
 * 子任务状态：规划阶段全部从 pending 起步；执行阶段由调用方按真实进展更新。
 */
export type SubtaskStatus = "pending" | "in_progress" | "done" | "failed";

/**
 * 子任务图节点：Plan-and-Execute 把目标拆成若干有依赖关系的子任务。
 * dependsOn 指向其它 subtask 的 id，构成有向无环图（DAG）。
 */
export interface Subtask {
  /** 稳定唯一标识，跨轮次追踪进度用。 */
  id: string;
  /** 子任务标题（一句话）。 */
  title: string;
  /** 子任务描述（更细的执行指引）。 */
  description: string;
  /** 当前状态，规划阶段固定为 pending。 */
  status: SubtaskStatus;
  /** 依赖的其它子任务 id 列表（可选）。 */
  dependsOn?: string[];
}

/**
 * 规划阶段产出的计划：子任务图。调用方据此驱动/监控 agentLoop 的执行。
 */
export interface Plan {
  /** 原始目标文本。 */
  goal: string;
  /** 子任务列表（含依赖关系）。 */
  subtasks: Subtask[];
  /** 计划创建时刻（Unix 毫秒）。 */
  createdAt: number;
}

/**
 * Planner 选项。
 * streamFn 默认用 @aiagent/ai 的 streamSimple；测试可注入 mock。
 */
export interface PlannerOptions {
  /** 用于规划的模型（通常比执行模型更轻，仅做分解）。 */
  model: Model<Api>;
  /** LLM 流式函数，缺省 streamSimple。 */
  streamFn?: StreamFn;
  /** 规划 system 提示，缺省用 defaultPlanSystemPrompt。 */
  systemPrompt?: string;
}

/**
 * Planner 实例：持有模型与 streamFn，对外暴露 `plan` 方法。
 */
export interface Planner {
  /**
   * 把目标文本分解为子任务图（一次 LLM 调用）。
   * 解析失败时结构化降级为单子任务计划，绝不直接抛错给调用方。
   *
   * @param goalText 自然语言目标。
   * @param context 可选的运行上下文，用于把近期对话作为规划背景。
   * @returns 子任务图 Plan。
   */
  plan(goalText: string, context?: AgentContext): Promise<Plan>;
}

/**
 * 规划解析失败的结构化错误：被 `plan` 捕获后降级为单子任务计划，不向上抛出。
 */
export interface PlannerError {
  /** 稳定错误码。 */
  code: "plan_parse_failed";
  /** 可读信息。 */
  message: string;
  /** 模型原始（未能解析的）输出，便于调试。 */
  rawText: string;
}

/** Planner 解析失败的异常实现（内部使用，plan 捕获后转降级计划）。 */
class PlannerParseError extends Error {
  readonly code = "plan_parse_failed" as const;
  readonly rawText: string;
  constructor(message: string, rawText: string) {
    super(message);
    this.rawText = rawText;
  }
}

/**
 * 把任意原始对象规整为 Subtask；缺字段/类型不符返回 null（由调用方过滤）。
 *
 * @param raw 模型产出的单个子任务对象。
 * @returns 规整后的 Subtask，或 null。
 */
function normalizeSubtask(raw: unknown): Subtask | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : String(obj.id ?? "");
  const title = typeof obj.title === "string" ? obj.title : typeof obj.name === "string" ? obj.name : "";
  if (!id || !title) return null;
  const description = typeof obj.description === "string" ? obj.description : title;
  const dependsOn = Array.isArray(obj.dependsOn)
    ? (obj.dependsOn as unknown[]).filter((d) => typeof d === "string")
    : undefined;
  return {
    id,
    title,
    description,
    status: "pending",
    dependsOn: dependsOn && dependsOn.length > 0 ? (dependsOn as string[]) : undefined,
  };
}

/**
 * 解析模型输出为 Plan；形状不符或 JSON 损坏时抛出 PlannerParseError（由 plan 捕获降级）。
 *
 * @param raw 模型原始文本。
 * @param goalText 原始目标，作为 Plan.goal 与降级计划文案。
 * @returns 解析成功的 Plan。
 */
export function parsePlanFromModel(raw: string, goalText: string): Plan {
  const jsonText = extractJsonBlock(raw);
  const parsed = parseJsonWithRepair<unknown>(jsonText);
  const rawSubtasks =
    Array.isArray(parsed)
      ? parsed
      : (parsed as Record<string, unknown> | null)?.subtasks ??
        (parsed as Record<string, unknown> | null)?.tasks;

  if (!Array.isArray(rawSubtasks)) {
    throw new PlannerParseError("missing subtasks array", raw);
  }

  const subtasks = rawSubtasks.map(normalizeSubtask).filter((s): s is Subtask => s !== null);
  if (subtasks.length === 0) {
    throw new PlannerParseError("no valid subtask parsed", raw);
  }

  return { goal: goalText, subtasks, createdAt: Date.now() };
}

/**
 * 规划失败的结构化降级：把整段目标作为一个 pending 子任务，loop 仍可继续跑。
 *
 * @param goalText 原始目标。
 * @returns 单子任务 Plan。
 */
function createFallbackPlan(goalText: string): Plan {
  return {
    goal: goalText,
    subtasks: [{ id: "task-1", title: goalText, description: goalText, status: "pending" }],
    createdAt: Date.now(),
  };
}

/**
 * 把 AgentMessage[] 浓缩为近期文本（最多 6 条），供规划器把对话背景带入 prompt。
 *
 * @param messages 运行上下文消息。
 * @returns 多行文本摘要。
 */
function summarizeAgentMessages(messages: AgentMessage[]): string {
  return messages
    .slice(-6)
    .map((m) => {
      if (m.role === "user" && typeof m.content === "string") return `[user] ${m.content}`;
      if (m.role === "assistant") return `[assistant] ${extractText(m)}`;
      if (m.role === "toolResult") {
        return `[toolResult] ${m.content.map((c) => ("text" in c ? c.text : "")).join(" ")}`;
      }
      return ""; // CompactionMessage 等自定义消息忽略
    })
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * 构造规划用户 prompt：目标 + 可选对话背景 + 结构化 JSON 格式约定。
 *
 * @param goalText 目标。
 * @param agentContext 可选上下文。
 * @returns 用户消息文本。
 */
function buildPlanUserPrompt(goalText: string, agentContext?: AgentContext): string {
  const contextSummary = agentContext ? summarizeAgentMessages(agentContext.messages) : "";
  return [
    `目标：${goalText}`,
    contextSummary ? `当前对话背景：\n${contextSummary}` : "",
    "请把上述目标拆解为可执行的子任务图，仅返回 JSON，不要额外解释。",
    '格式：{ "subtasks": [ { "id": "1", "title": "...", "description": "...", "dependsOn": [] } ] }',
    "也可以直接返回子任务数组 [ { ... } ]；dependsOn 填依赖的子任务 id。",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * 创建 Planner：持有模型与 streamFn，对外暴露一次性分解目标的 `plan` 方法。
 *
 * @param options Planner 选项（model 必填，streamFn/systemPrompt 可选）。
 * @returns Planner 实例。
 */
export function createPlanner(options: PlannerOptions): Planner {
  const streamFn = options.streamFn ?? streamSimple;

  return {
    async plan(goalText: string, context?: AgentContext): Promise<Plan> {
      const llmContext: Context = {
        systemPrompt: options.systemPrompt ?? defaultPlanSystemPrompt,
        messages: [{ role: "user", content: buildPlanUserPrompt(goalText, context), timestamp: Date.now() }],
      };

      let raw = "";
      try {
        raw = await generateText(streamFn, options.model, llmContext, { maxTokens: 2048 });
      } catch {
        // 规划 LLM 调用失败：降级为单子任务，不向上抛。
        return createFallbackPlan(goalText);
      }

      try {
        return parsePlanFromModel(raw, goalText);
      } catch (error) {
        // 解析失败：结构化降级（保留错误码信息到内部），不 crash 调用方。
        const plannerError: PlannerError =
          error instanceof PlannerParseError
            ? { code: error.code, message: error.message, rawText: error.rawText }
            : { code: "plan_parse_failed", message: "unexpected parse error", rawText: raw };
        void plannerError; // 当前仅用于降级决策；调用方可后续扩展为回调/埋点。
        return createFallbackPlan(goalText);
      }
    },
  };
}
