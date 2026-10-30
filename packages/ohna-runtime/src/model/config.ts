/**
 * run 创建时的配置快照解析（spec §7.1）。
 *
 * 快照在 conversation 调度放行后、RunManager 执行前生成，把模型/凭据/权限/Team/
 * 预算与工作区上下文固定为本次 run 的不可变装配输入。后续运行期切换模型或工作区，
 * 已创建 run 的执行来源不再随实例状态漂移。
 */
import type { Model } from "@aiagent/ai";
import type { AgentTool } from "@aiagent/tools";
import { resolveCompactionSettings } from "@aiagent/agent";

/** 配置快照解析所需的最小启动输入（与 runtime 协议形状一致）。 */
interface RunConfigInput {
  conversationId: string;
  workspaceId?: string;
  /** 本次 run 选择的模型 id（来自 composer）；缺省沿用实例基模型。 */
  modelId?: string;
  maxTurns?: number;
  deadlineMs?: number;
  maxCost?: number;
}

/** run 级配置快照。 */
export interface RunConfigSnapshot {
  model: Model<"openai-completions">;
  apiKey: string;
  autoApprove: boolean;
  team: boolean;
  maxTurns?: number;
  deadlineMs?: number;
  maxCost?: number;
  compaction: {
    contextWindow: number;
    maxTokens: number;
    reserveTokens: number;
  };
  workspace: {
    workspaceId: string;
    workspaceRoot: string;
    tools: AgentTool[];
    systemPrompt: string;
  };
}

/** 快照解析依赖：实例基配置与 Task 6 工作区上下文容器。 */
export interface RunConfigResolverDependencies {
  model: Model<"openai-completions">;
  apiKey: string;
  autoApprove: boolean;
  team: boolean;
  workspaceRegistry: {
    resolveAuthorizedWorkspace(workspaceId: string): Promise<{ workspaceId: string; workspaceRoot: string } | undefined>;
    resolveConversationWorkspace(conversationId: string): Promise<{ workspaceId: string; workspaceRoot: string }>;
  };
  workspaceContextCache: {
    get(workspaceRoot: string): Promise<{ systemPrompt: string; tools: AgentTool[] }>;
  };
  fallback: {
    workspaceId: string;
    workspaceRoot: string;
    systemPrompt: string;
    tools: AgentTool[];
  };
}

/**
 * 创建 run 配置快照解析器。
 *
 * 依赖由组合根一次注入；返回的函数保持计划约定的
 * `resolveRunConfig(conversationId, input)` 公共签名，避免把宿主依赖泄露给调用方。
 *
 * @param dependencies 实例基配置、工作区注册表与上下文缓存。
 * @returns 按会话与启动入参解析快照的函数。
 */
export function createRunConfigResolver(
  dependencies: RunConfigResolverDependencies
): (conversationId: string, input: RunConfigInput) => Promise<RunConfigSnapshot> {
  /**
   * 解析一次 run 的完整配置快照。
   *
   * @param conversationId 会话 id。
   * @param input run 启动输入。
   * @returns 固定本次 run 的配置快照。
   */
  return async (conversationId, input) => {
    // 模型覆盖必须在本 run 创建时固定，避免运行期切换 composer 影响在途 run。
    const model = input.modelId
      ? { ...dependencies.model, id: input.modelId, name: input.modelId }
      : dependencies.model;
    let workspace = dependencies.fallback;
    try {
      const resolved =
        (input.workspaceId
          ? await dependencies.workspaceRegistry.resolveAuthorizedWorkspace(input.workspaceId)
          : undefined) ??
        (await dependencies.workspaceRegistry
          .resolveConversationWorkspace(conversationId)
          .catch(() => undefined));
      if (resolved) {
        const context = await dependencies.workspaceContextCache.get(resolved.workspaceRoot);
        workspace = {
          workspaceId: resolved.workspaceId,
          workspaceRoot: resolved.workspaceRoot,
          systemPrompt: context.systemPrompt,
          tools: context.tools
        };
      }
    } catch {
      // 工作区上下文是增强能力：解析失败回退实例单工作区语义，不阻断 run。
    }

    return {
      model,
      apiKey: dependencies.apiKey,
      autoApprove: dependencies.autoApprove,
      team: dependencies.team,
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
      ...(input.maxCost !== undefined ? { maxCost: input.maxCost } : {}),
      compaction: {
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reserveTokens: resolveCompactionSettings(model.contextWindow).reserveTokens
      },
      workspace
    };
  };
}
