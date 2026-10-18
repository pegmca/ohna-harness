import type { ModelOptionDto } from "@aiagent/types";
import { useEffect, useState } from "react";
import { listModels } from "../../shared/api/composer-client";
import { formatApiError } from "./format";

/** Composer 模型目录状态；本地版无附件上传，只维护单模型目录的选择。 */
export interface ComposerDraftState {
  models: ModelOptionDto[];
  selectedModelId: string;
  modelCatalogStatus: "loading" | "ready" | "failed";
  modelCatalogError?: string;
  selectModel(modelId: string): void;
  retryModels(): void;
}

/**
 * 管理模型目录加载与用户偏好。
 *
 * @returns Composer 模型状态与操作。
 */
export function useComposerState(): ComposerDraftState {
  const [models, setModels] = useState<ModelOptionDto[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelCatalogStatus, setModelCatalogStatus] =
    useState<ComposerDraftState["modelCatalogStatus"]>("loading");
  const [modelCatalogError, setModelCatalogError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, []);

  /** @param signal 取消信号。 @returns 模型目录加载完成 Promise。 */
  async function loadCatalog(signal: AbortSignal): Promise<void> {
    setModelCatalogStatus("loading");
    setModelCatalogError(undefined);
    try {
      const result = await listModels(signal);
      if (!result.ok || result.data.models.length === 0) {
        setModelCatalogStatus("failed");
        setModelCatalogError(result.ok ? "服务端没有可用模型。" : formatApiError(result.error));
        return;
      }
      setModels(result.data.models);
      const stored = readStoredModelId();
      setSelectedModelId(result.data.models.some((model) => model.id === stored)
        ? stored!
        : result.data.defaultModelId);
      setModelCatalogStatus("ready");
    } catch (error) {
      if (signal.aborted) return;
      setModelCatalogStatus("failed");
      setModelCatalogError(error instanceof Error ? error.message : "模型目录加载失败。");
    }
  }

  /** @returns 浏览器保存的模型 ID；存储不可用时返回 null。 */
  function readStoredModelId(): string | null {
    try {
      return window.localStorage.getItem("ohna.selected-model");
    } catch {
      return null;
    }
  }

  return {
    models,
    selectedModelId,
    modelCatalogStatus,
    modelCatalogError,
    selectModel(modelId) {
      setSelectedModelId(modelId);
      try {
        window.localStorage.setItem("ohna.selected-model", modelId);
      } catch {
        // localStorage 不可用时只保留页面内选择。
      }
    },
    retryModels: () => void loadCatalog(new AbortController().signal)
  };
}
