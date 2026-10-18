import type { Api, Model } from "@aiagent/ai";
import type { StreamFn } from "@aiagent/agent";
import type { ModelCatalogDto, ModelOptionDto } from "@aiagent/types";

/**
 * 一个可执行模型的运行时：pi 形态的 Model 目录条目 + 可选注入的 streamFn 与 apiKey。
 * streamFn 缺省时 loop 使用 @aiagent/ai 的 streamSimple（真实 OpenAI 兼容链路）；
 * 注入 streamFn 的模型（如测试替身）与真实 provider 走同一条 agentLoop 代码路径。
 */
export interface ModelRuntime {
  model: Model<Api>;
  streamFn?: StreamFn;
  apiKey?: string;
}

export interface ModelRuntimeEntry {
  option: ModelOptionDto;
  /** 缺失表示该目录项不可用（如 real profile 缺配置），has() 必须为 false。 */
  runtime?: ModelRuntime;
}

/** 服务端模型目录同时承担公开元数据与私有 runtime 解析，浏览器永远拿不到凭据。 */
export interface ModelRuntimeRegistry {
  catalog(): ModelCatalogDto;
  resolve(modelId: string): ModelRuntime | undefined;
  has(modelId: string): boolean;
  defaultModelId: string;
}

/**
 * 创建不可变模型目录。
 *
 * @param entries 已完成配置校验的模型条目。
 * @param defaultModelId 默认模型稳定 ID。
 * @returns 模型目录与 runtime resolver。
 */
export function createModelRuntimeRegistry(
  entries: ModelRuntimeEntry[],
  defaultModelId: string
): ModelRuntimeRegistry {
  const byId = new Map(entries.map((entry) => [entry.option.id, entry]));
  if (!byId.has(defaultModelId)) {
    throw new Error(`Default model is not registered: ${defaultModelId}`);
  }
  return {
    defaultModelId,
    catalog: () => ({
      defaultModelId,
      models: entries.map((entry) => structuredClone(entry.option))
    }),
    resolve: (modelId) => byId.get(modelId)?.runtime,
    // 缺 runtime 的目录项必须在创建 Run 前失败，不能静默降级。
    has: (modelId) => Boolean(byId.get(modelId)?.runtime)
  };
}
