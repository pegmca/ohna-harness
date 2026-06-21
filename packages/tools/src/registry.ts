import { executeTool } from "./executor.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";

/**
 * 工具注册表负责隔离“发现工具”和“执行工具”，Agent 只需要依赖稳定名称。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown, unknown>>();

  /**
   * 注册工具实例，同名工具会被拒绝，避免后续 Agent 调度出现歧义。
   *
   * @param tool 要加入 registry 的工具。
   * @returns 当前 registry，便于测试或启动阶段链式注册。
   */
  register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as Tool<unknown, unknown>);
    return this;
  }

  /**
   * 按名称查找工具，供 Agent 在 function calling 返回工具名后定位实现。
   *
   * @param name 工具名称。
   * @returns 找到的工具；不存在时返回 undefined。
   */
  get(name: string): Tool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  /**
   * 返回所有已注册工具，后续可转换成模型 function schema 或前端调试列表。
   *
   * @returns 已注册工具的只读快照。
   */
  list(): Tool<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  /**
   * 执行指定工具并统一完成入参校验、异常捕获、出参校验和 trace 记录。
   *
   * @param name 工具名称。
   * @param args 未信任的模型或调用方参数。
   * @param context 可选执行上下文，当前用于注入 trace recorder。
   * @returns 结构化成功或失败结果。
   */
  execute(name: string, args: unknown, context: ToolExecutionContext = {}): Promise<ToolExecutionResult> {
    return executeTool(this, name, args, context);
  }
}
