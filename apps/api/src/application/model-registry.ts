import type { LlmClient, ModelCatalogDto, ModelOptionDto } from "@aiagent/types";

export interface ModelRuntimeEntry {
  option: ModelOptionDto;
  client?: LlmClient;
  /** 仅确定性 mock runtime 可在没有 LLM client 时执行。 */
  clientlessRuntime?: boolean;
}

/** 服务端模型目录同时承担公开元数据与私有 client 解析，浏览器永远拿不到凭据。 */
export interface ModelRuntimeRegistry {
  catalog(): ModelCatalogDto;
  resolve(modelId: string): LlmClient | undefined;
  has(modelId: string): boolean;
  defaultModelId: string;
}

/**
 * 创建不可变模型目录。
 *
 * @param entries 已完成配置校验的模型条目。
 * @param defaultModelId 默认模型稳定 ID。
 * @returns 模型目录与 client resolver。
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
    resolve: (modelId) => byId.get(modelId)?.client,
    // real profile 缺配置时必须在创建 Run 前失败，不能静默走 Agent 的 mock 分支。
    has: (modelId) => {
      const entry = byId.get(modelId);
      return Boolean(entry && (entry.client || entry.clientlessRuntime));
    }
  };
}
