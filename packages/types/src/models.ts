/** 浏览器可选择的模型能力摘要；只暴露产品能力，不暴露供应商凭据。 */
export interface ModelOptionDto {
  id: string;
  label: string;
  provider: "deepseek" | "openrouter" | "mock";
  description: string;
  isDefault: boolean;
  capabilities: {
    structuredOutput: boolean;
    toolCalling: boolean;
  };
}

/** 模型目录响应；defaultModelId 必须指向 models 中的可用项。 */
export interface ModelCatalogDto {
  defaultModelId: string;
  models: ModelOptionDto[];
}
