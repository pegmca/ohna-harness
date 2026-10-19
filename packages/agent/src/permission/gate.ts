/**
 * 权限闸门：把策略 + 会话记忆 + 宿主问询组装成 `beforeToolCall` 钩子。
 *
 * 关键边界：
 * - **loop 内核不 import 本模块**：闸门只是钩子实现，组合根选择是否挂载；
 * - **effect 从工具表读取**：`ctx.context.tools` 是按名字查副作用声明的唯一入口，
 *   未标注（如 MCP）按 `mutate` 保守处理；
 * - **read 直接放行**：不调用策略、不产生问询，审批成本只花在真实副作用上。
 */
import type { AgentTool, ToolEffect } from "@aiagent/tools";
import type { BeforeToolCallContext, BeforeToolCallResult } from "../types.js";
import type {
  AskAdapter,
  PermissionPolicy,
  PermissionRequest,
  PolicyState,
} from "./types.js";

/**
 * 从工具表解析副作用声明。
 *
 * @param tools 当前上下文中的工具列表。
 * @param toolName 工具名。
 * @returns 工具声明的 effect；找不到或未标注时返回 `mutate`（保守）。
 */
export function resolveToolEffect(
  tools: readonly AgentTool<any>[] | undefined,
  toolName: string,
): ToolEffect {
  return tools?.find((tool) => tool.name === toolName)?.effect ?? "mutate";
}

/**
 * 从工具参数中取归一化目标（当前只认 `path`）。
 *
 * @param args 已校验参数。
 * @returns 非空路径字符串；无路径工具返回 undefined。
 */
export function resolvePermissionTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 创建 `beforeToolCall` 权限钩子。
 *
 * @param getPolicy 每次裁决实时读取策略（CLI 的 Shift+Tab 切换模式依赖这一点）。
 * @param state 跨轮共享的会话记忆。
 * @param ask 宿主问询适配器（readline / TUI / SSE）。
 * @returns 可直接赋给 `AgentLoopConfig.beforeToolCall` 的钩子。
 */
export function createPermissionGate(
  getPolicy: () => PermissionPolicy,
  state: PolicyState,
  ask: AskAdapter,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
  return async (context, signal) => {
    if (signal?.aborted) {
      return { block: true, reason: "Run 已取消，操作未执行。" };
    }

    const toolName = context.toolCall.name;
    const effect = resolveToolEffect(context.context.tools, toolName);
    // 只读工具直接放行：策略与问询都不参与。
    if (effect === "read") return undefined;

    const target = resolvePermissionTarget(context.args);
    const request: PermissionRequest = {
      toolName,
      args: context.args,
      effect,
      ...(target ? { target } : {}),
    };

    const decision = getPolicy().decide(request, state);
    if (decision.outcome === "allow") return undefined;
    if (decision.outcome === "deny") return { block: true, reason: decision.reason };

    const answer = await ask(request, decision, signal);
    // 问询期间 run 可能被取消：此时即使回答 allow 也不能继续执行副作用。
    if (signal?.aborted) {
      return { block: true, reason: "Run 已取消，操作未执行。" };
    }
    if (answer === "allow") return undefined;
    if (answer === "allow-session") {
      // 有 target 时按「工具 + 路径」记忆，否则按工具名全量记忆。
      state.allow(toolName, target);
      return undefined;
    }
    return { block: true, reason: `用户拒绝了该操作：${decision.summary}` };
  };
}
