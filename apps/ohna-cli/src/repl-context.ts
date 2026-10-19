/**
 * REPL 的跨模块装配上下文：来源标注（MCP / Team）与权限闸门回填。
 *
 * 从 repl.ts 拆出的原因：repl 已到单文件行数上限，而这三个字段都属于「组合根注入
 * REPL 的接线信息」，不参与输入循环本身；拆出后 repl 只保留 `import type` 与 re-export，
 * 既有导入方（harness）无需修改。
 */
import type { ConfirmHook } from "./confirm.js";

/** REPL 的装配上下文：MCP / Team 来源标注与闸门回填。 */
export interface ReplContext {
  /** MCP 发现的工具名（/tools 与欢迎头据此标注来源）。 */
  mcpToolNames?: ReadonlySet<string>;
  /** 已接入的 MCP server 名（欢迎头展示）。 */
  mcpServerNames?: readonly string[];
  /** Team 编排工具名（/tools 据此标注「（Team）」）。 */
  teamToolNames?: ReadonlySet<string>;
  /**
   * 权限闸门就绪回调（K3 时序）：team controller 先于 REPL 创建，但闸门必须在 REPL /
   * 单次模式内部根据 TTY 与 readline 实例构造。组合根通过该回调把「就绪后的闸门」
   * 写回可变引用，子代理与 supervisor 此后共用同一闸门与会话 PolicyState。
   *
   * @param gate 已装配好的 beforeToolCall 权限钩子。
   */
  onGateReady?: (gate: ConfirmHook) => void;
}
