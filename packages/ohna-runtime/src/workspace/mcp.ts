/**
 * 工作区 MCP 生命周期容器（spec §6.2）。
 *
 * runtime 为每个已授权工作区维护独立的一组 MCP client，并在撤销工作区时统一
 * `close()`。首版只提供按 workspace 隔离的容器与关闭语义；真实 MCP client 的发现与
 * 工具投影在后续 task 接入（当前 MCP 装配仍在 cli harness，不在 runtime 边界内），
 * 这里不提前耦合具体 client 实现，以免边界膨胀。
 */

/** 单个工作区的 MCP 会话句柄：当前为占位，后续 task 替换为真实 client。 */
export interface WorkspaceMcpSession {
  workspaceId: string;
  /** 关闭并释放该工作区下所有 MCP client。 */
  close(): Promise<void>;
}

/**
 * 按 workspaceId 隔离的 MCP 容器。
 *
 * 撤销工作区时调用 `close()` 释放连接，避免悬空 client 泄漏；切换工作区不影响其它
 * 已授权工作区的会话。
 */
export class WorkspaceMcpRegistry {
  private readonly sessions = new Map<string, WorkspaceMcpSession>();

  /**
   * 取某工作区的 MCP 会话；首次访问时建立占位会话。
   *
   * @param workspaceId 工作区 ID。
   * @returns 该工作区的 MCP 会话句柄。
   */
  async get(workspaceId: string): Promise<WorkspaceMcpSession> {
    const existing = this.sessions.get(workspaceId);
    if (existing) return existing;
    const session: WorkspaceMcpSession = {
      workspaceId,
      close: async () => {
        this.sessions.delete(workspaceId);
      }
    };
    this.sessions.set(workspaceId, session);
    return session;
  }

  /**
   * 关闭并移除某个工作区的所有 MCP 会话。
   *
   * @param workspaceId 工作区 ID。
   */
  async release(workspaceId: string): Promise<void> {
    const session = this.sessions.get(workspaceId);
    if (session) await session.close();
  }

  /**
   * 关闭所有工作区会话（runtime 关闭时调用）。
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
  }
}
