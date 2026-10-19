/**
 * 文件树联动刷新事件总线（W-8，L2）。
 *
 * Workbench 在消费 run 事件流时，凡是 `tool_execution_end` 且工具会改动文件
 * （write / edit / bash），就 `notifyFilesChanged`；FileTreePanel 订阅后自动
 * 重新拉取当前展开目录，无需手动刷新。
 *
 * 用模块级发射器而不是 React 状态：事件源（run 流回调）与消费者（文件树）
 * 分属不同子树，且高频事件不值得触发整树 re-render。
 */

/**
 * 会改动工作区文件的 Agent 工具集合（仅用于文件树刷新启发式）。
 *
 * 注意：权限审批已改为读取 `AgentTool.effect`（K1），本集合不再是审批名单；
 * 这里保留工具名判断是因为前端只消费事件流，拿不到 serve 侧的工具表。
 */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash"]);

type FilesChangedListener = (toolName: string) => void;

const listeners = new Set<FilesChangedListener>();

/**
 * 判断工具是否会改动文件（决定是否触发文件树刷新）。
 *
 * @param toolName Agent 工具名。
 * @returns 是否属于写类工具。
 */
export function isFileMutatingTool(toolName: string): boolean {
  return FILE_MUTATING_TOOLS.has(toolName);
}

/**
 * 广播「文件已被 Agent 改动」。
 *
 * @param toolName 触发改动的工具名（write / edit / bash）。
 * @returns 无返回值。
 */
export function notifyFilesChanged(toolName: string): void {
  for (const listener of listeners) listener(toolName);
}

/**
 * 订阅文件变更。
 *
 * @param listener 变更回调。
 * @returns 取消订阅函数（幂等）。
 */
export function onFilesChanged(listener: FilesChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
