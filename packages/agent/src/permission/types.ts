/**
 * 权限策略领域类型（K1）。
 *
 * 分层原则（对齐 `team/` 与 §0 判据）：
 * - **策略是纯对象**：`PermissionPolicy.decide` 只做规则查询，不碰终端 / SSE；
 * - **问询在组合根**：CLI 的 readline 三选项、serve 的 SSE 确认卡片都实现同一 `AskAdapter`；
 * - **loop 内核零依赖**：`agent-loop.ts` 不 import 本目录，组合根把 `createPermissionGate`
 *   的产物挂到既有 `beforeToolCall` 挂载点。
 */
import type { ToolEffect } from "@aiagent/tools";

/** 权限判断使用的副作用类型，直接复用工具契约的单一事实源。 */
export type PermissionEffect = ToolEffect;

/** 一次待裁决的工具调用。 */
export interface PermissionRequest {
  /** 工具名（与 `AgentTool.name` 一致）。 */
  toolName: string;
  /** 已通过 zod 校验的工具参数。 */
  args: unknown;
  /** 工具自声明的副作用；缺省在闸门层按 `mutate` 兜底。 */
  effect: PermissionEffect;
  /**
   * 归一化后的操作目标（当前取 `args.path`，无路径工具为 undefined）。
   * 用于「本会话一律允许」按路径记忆；无目标时规则退化为工具级。
   */
  target?: string;
}

/**
 * 策略裁决：
 * - `allow`：直接放行，不询问；
 * - `deny`：直接拒绝（plan 模式 / 显式规则），不询问；
 * - `ask`：委托宿主问询，摘要可直接展示或由宿主重新格式化。
 */
export type PermissionDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "ask"; summary: string };

/** 会话级规则：工具级（无 target）或「工具 + 路径」级。 */
export interface PermissionRule {
  toolName: string;
  /** 缺省表示该工具在本会话内全部放行。 */
  target?: string;
}

/**
 * 会话级权限记忆（allowlist）。
 *
 * 只承载「用户本次会话点过 2. 本会话一律允许」产生的规则；不负责持久化——
 * 是否落盘由宿主决定（当前 CLI / serve 都只保存在进程内）。
 */
export interface PolicyState {
  /**
   * 记住一次「本会话一律允许」。
   *
   * @param toolName 工具名。
   * @param target 可选目标（如文件路径）；缺省表示按工具名全量放行。
   */
  allow(toolName: string, target?: string): void;
  /**
   * 查询是否已被会话规则放行。
   *
   * @param toolName 工具名。
   * @param target 可选目标；工具级规则匹配任意 target。
   * @returns true 表示命中会话规则。
   */
  isAllowed(toolName: string, target?: string): boolean;
  /**
   * 返回当前规则的只读快照（供 `/permissions` 展示）。
   *
   * @returns 规则数组副本。
   */
  rules(): readonly PermissionRule[];
  /** 清空全部会话规则（`/permissions clear`）。 */
  clear(): void;
}

/** 权限预设：对齐 Claude Code Shift+Tab 循环的三种交互态 + 全放行。 */
export type PermissionPreset = "default" | "acceptEdits" | "plan" | "bypass";

/** 可组合策略：规则查询纯函数，会话记忆通过 `PolicyState` 显式传入。 */
export interface PermissionPolicy {
  /**
   * 裁决一次权限请求。
   *
   * @param request 工具名 / 参数 / effect / 目标。
   * @param state 会话级 allowlist。
   * @returns allow / deny / ask。
   */
  decide(request: PermissionRequest, state: PolicyState): PermissionDecision;
}

/** 问询适配器的回答：允许一次 / 本会话一律允许 / 拒绝。 */
export type PermissionAnswer = "allow" | "allow-session" | "deny";

/**
 * 宿主问询适配器：CLI 用 readline/TUI，serve 用 SSE 确认卡片。
 *
 * 契约：实现方必须响应 `signal`（run 取消时尽快返回 `deny`），不得抛错；
 * 闸门会把 `deny` 转成 `{block:true}` 回喂模型。
 */
export type AskAdapter = (
  request: PermissionRequest,
  decision: Extract<PermissionDecision, { outcome: "ask" }>,
  signal?: AbortSignal,
) => Promise<PermissionAnswer>;
