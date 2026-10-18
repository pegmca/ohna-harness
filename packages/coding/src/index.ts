/**
 * @aiagent/coding 的公共入口。
 *
 * 边界说明（对齐 AGENTS.md 的包边界纪律）：
 * - 本包只提供「编码域工具集」的组装，运行边界严格限定在传入的 cwd（工作区根目录）内；
 * - 权限策略（path-policy / command-policy）是组合根策略，工具内部引用但可整体替换；
 * - 具体工具实现按文件拆在 ./tools/*，本入口只做注册表组装，便于按模式选择工具集。
 */
import type { AgentTool } from "@aiagent/tools";
import { createBashTool } from "./tools/bash.js";
import { createEditTool } from "./tools/edit.js";
import { createFindTool } from "./tools/find.js";
import { createGrepTool } from "./tools/grep.js";
import { createLsTool } from "./tools/ls.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";

/** 编码注册表支持的工具名。 */
export type CodingToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

/** 只读注册表支持的工具名。 */
export type ReadOnlyToolName = Extract<CodingToolName, "read" | "grep" | "find" | "ls">;

/**
 * 注册表组装选项：透传给各工具工厂。
 * 字段名与各工具的 *ToolOptions 保持一致（例如 bash 用 defaultTimeoutMs），避免组合根的语义漂移。
 */
export interface CodingToolRegistryOptions {
  /** 单次输出的字节上限，缺省沿用 truncate.ts 的 DEFAULT_MAX_BYTES。 */
  maxBytes?: number;
  /** 单次输出的行数上限，缺省沿用 truncate.ts 的 DEFAULT_MAX_LINES。 */
  maxLines?: number;
  /** bash 工具的默认超时毫秒数。 */
  defaultTimeoutMs?: number;
}

/**
 * 组装完整编码工具集：读、写、编辑、执行、检索、列目录。
 *
 * @param cwd 工作区根目录，作为所有路径与命令的作用域边界。
 * @param options 输出上限 / 超时等共享配置，透传给支持该项的工具工厂。
 * @returns 可直接注入 agentLoop 的工具数组。
 */
export function createCodingToolRegistry(cwd: string, options?: CodingToolRegistryOptions): AgentTool[] {
  return [
    createReadTool(cwd, options),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd, options),
    createGrepTool(cwd, options),
    createFindTool(cwd, options),
    createLsTool(cwd, options),
  ];
}

/**
 * 组装只读工具集：只允许查看与检索，不产生任何写操作与命令执行。
 * 适用于「先探索、后确认」的安全默认态。
 *
 * @param cwd 工作区根目录。
 * @param options 输出上限等共享配置。
 * @returns 只读工具数组。
 */
export function createReadOnlyToolRegistry(cwd: string, options?: CodingToolRegistryOptions): AgentTool[] {
  return [createReadTool(cwd, options), createGrepTool(cwd, options), createFindTool(cwd, options), createLsTool(cwd, options)];
}

export { loadProjectContext } from "./context/project-context.js";
