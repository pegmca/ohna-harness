/**
 * 压缩后的「硬收敛」（Phase 5 起为共享实现的 barrel）。
 *
 * 实现已下沉到 `@aiagent/agent/src/compaction-enforce.ts`：serve 的「run 前会话级压缩」
 * 与 CLI 的「run 后落盘压缩」必须使用同一套截断 / 配对丢弃 / usage 重标定语义，
 * 否则两侧会出现「一边放得下、一边超窗」的漂移。本文件保留原导入路径，
 * CLI 内部调用点与单测无需修改。
 */
export {
  enforceContextWindow,
  estimateSequenceTokens,
  resolveCompactionSettings,
  TRUNCATION_MARKER,
  type EnforceContextWindowOptions,
  type EnforceContextWindowResult,
} from "@aiagent/agent";
