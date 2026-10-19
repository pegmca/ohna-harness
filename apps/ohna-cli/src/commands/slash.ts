/**
 * 兼容入口壳（Phase C2 · D4）。
 *
 * 命令元数据与分发已迁入 `commands/registry.ts`（单一注册表）；本文件只 re-export，
 * 保持既有文档 / 导入路径可用。新代码请直接引用 `registry.js`。
 */
export {
  COMMAND_DEFINITIONS,
  COMMAND_REGISTRY,
  CommandRegistry,
  createSlashDispatcher,
  filterSlashCommands,
  listPanelCommands,
  parseSlashCommand,
  printUnknownCommand,
  shortName,
} from "./registry.js";
export type {
  CommandContext,
  CommandDef,
  CommandHandler,
  SlashCommandDef,
  SlashDispatcher,
  SlashDispatcherOptions,
  SlashInvocation,
} from "./registry.js";
