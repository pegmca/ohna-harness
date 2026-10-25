/**
 * 模型目录条目（浏览器可见的模型元数据）。
 *
 * 含成本计量字段（docs/v2.0/04 §5.6）：不含任何供应商凭据，纯费率与窗口，可安全下发给浏览器。
 * **仅服务设置弹窗 / 模型选择器**——Trace 面板不读 `/api/models`，它只消费 `llm_call` 里
 * 每次调用自带快照的 `window`（单一事实源，见 04 §5.4）。
 */
export interface ModelOptionDto {
  id: string;
  label: string;
  provider: "deepseek" | "openrouter" | "bridge_ai" | "mock";
  description: string;
  isDefault: boolean;
  capabilities: {
    structuredOutput: boolean;
    toolCalling: boolean;
  };
  /** 模型全窗口（token）。 */
  contextWindow: number;
  /** 输出预算（contextWindow 之外的输出窗，token）。 */
  maxTokens: number;
  /**
   * 费率（美元 / 百万 token）。mock / bridge 模型可能全 0 或部分缺失，
   * 缺失一律按 0 下发，由 UI 决定如何展示（如「—」）。
   */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** 模型目录响应；defaultModelId 必须指向 models 中的可用项。 */
export interface ModelCatalogDto {
  defaultModelId: string;
  models: ModelOptionDto[];
}
