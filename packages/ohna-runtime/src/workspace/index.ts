/**
 * 工作区授权与归属校验模块的统一出口。
 *
 * 三个内聚件：registry（授权表 + 归属反查）、context（按 canonical 根缓存系统提示词与
 * 工具集）、mcp（按 workspace 隔离的会话生命周期）。runtime 边界内持有，渲染端仅凭
 * `workspaceId` 操作资源，绝对根目录不离开 runtime。
 */
export { WorkspaceRegistry, canonicalizeWorkspaceRoot, type WorkspaceRegistryDeps } from "./registry.js";
export { WorkspaceContextCache, type WorkspaceContext } from "./context.js";
export { WorkspaceMcpRegistry, type WorkspaceMcpSession } from "./mcp.js";
