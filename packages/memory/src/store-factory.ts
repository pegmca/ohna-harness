/**
 * 记忆存储工厂：统一创建 InMemory / Jsonl 两种实现。
 * 未来接 PG + 向量库时，只需在此新增一个 "pg" 分支并复用 MemoryStore 接口即可，调用方零改动。
 */
import { InMemoryMemoryStore } from "./in-memory-store.js";
import { JsonlMemoryStore } from "./jsonl-store.js";
import type { MemoryStore } from "./types.js";

/** 创建记忆存储的选项。 */
export interface CreateMemoryStoreOptions {
  /** jsonl 模式必填：episode 持久化文件路径。 */
  filePath?: string;
  /** jsonl 模式可选：工作记忆持久化文件路径。 */
  workingFilePath?: string;
}

/**
 * 按 kind 创建记忆存储实例。
 *
 * @param kind "memory"（纯内存）或 "jsonl"（Node fs 持久化）。
 * @param options jsonl 模式需要 filePath；workingFilePath 可选。
 * @returns 记忆存储实例（实现 MemoryStore）。
 */
export function createMemoryStore(kind: "memory" | "jsonl", options: CreateMemoryStoreOptions = {}): MemoryStore {
  if (kind === "jsonl") {
    if (!options.filePath) {
      throw new Error("createMemoryStore: jsonl 模式需要提供 filePath");
    }
    return new JsonlMemoryStore({ filePath: options.filePath, workingFilePath: options.workingFilePath });
  }
  return new InMemoryMemoryStore();
}
