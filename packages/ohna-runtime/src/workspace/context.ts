/**
 * 工作区上下文缓存：按 canonical 根目录缓存编码工具集与系统提示词（spec §6.2）。
 *
 * 同一 runtime 可服务多个已授权工作区，切换工作区只改变当前 UI 选择，不调用
 * `process.chdir()`；每个 run 固定绑定创建时的工作区。本缓存避免每次 run 都重新
 * 读项目上下文（AGENTS.md / DESIGN.md / git 状态），渲染进程不接触绝对路径。
 */
import { buildCodingSystemPrompt, createCodingToolRegistry } from "@aiagent/coding";

/** 单个工作区的预构建上下文。 */
export interface WorkspaceContext {
  workspaceRoot: string;
  systemPrompt: string;
  tools: import("@aiagent/tools").AgentTool[];
}

/**
 * 按 canonical 根目录缓存的工作区上下文构造器。
 *
 * 失败时（项目上下文读取错误）回退到只含模板的提示词，与 coding 包的降级语义一致；
 * 上下文是增强项，不是 run 的前置条件。
 */
export class WorkspaceContextCache {
  private readonly cache = new Map<string, WorkspaceContext>();

  /**
   * 取某工作区的上下文；首次访问时构建并缓存。
   *
   * @param workspaceRoot canonical 绝对根目录。
   * @returns 该工作区的上下文（工具集 + 系统提示词）。
   */
  async get(workspaceRoot: string): Promise<WorkspaceContext> {
    const existing = this.cache.get(workspaceRoot);
    if (existing) return existing;

    const systemPrompt = await buildCodingSystemPrompt(workspaceRoot, {
      onContextError: () => undefined
    });
    const context: WorkspaceContext = {
      workspaceRoot,
      systemPrompt,
      tools: createCodingToolRegistry(workspaceRoot)
    };
    this.cache.set(workspaceRoot, context);
    return context;
  }

  /**
   * 清除所有缓存（runtime 关闭或测试清理时调用）。
   */
  clear(): void {
    this.cache.clear();
  }
}
