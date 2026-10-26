/**
 * 迁移期薄壳：Run 事件存储已迁入 `@aiagent/ohna-runtime`。
 *
 * 本文件只做 re-export，保持 serve 公共 API 与导入路径不变；
 * 最终随 serve 整体删除（runtime 迁移完成后）。
 */
export {
  LocalRunStore,
  isPersistableRunEvent,
  isTerminalRunStatus,
  type RunMeta,
  type RunEventTypeDto
} from "@aiagent/ohna-runtime";
