import type { AgentTool } from "./types.js";

/**
 * 工具注册表：退化为 name → AgentTool 的收集容器。
 * 执行职责（校验、批执行、错误回喂）已移交 packages/agent 的 agent loop，
 * 这里只负责注册与查找，供 bootstrap 装配工具列表。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  /**
   * 注册工具实例，同名工具会被拒绝，避免后续 Agent 调度出现歧义。
   *
   * @param tool 要加入 registry 的工具。
   * @returns 当前 registry，便于测试或启动阶段链式注册。
   */
  register<TSchema extends import("zod").ZodType, TDetails>(tool: AgentTool<TSchema, TDetails>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as AgentTool);
    return this;
  }

  /**
   * 按名称查找工具，供 Agent 在 function calling 返回工具名后定位实现。
   *
   * @param name 工具名称。
   * @returns 找到的工具；不存在时返回 undefined。
   */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 返回所有已注册工具，可直接作为 AgentContext.tools 注入 loop。
   *
   * @returns 已注册工具的只读快照。
   */
  list(): AgentTool[] {
    return [...this.tools.values()];
  }
}
