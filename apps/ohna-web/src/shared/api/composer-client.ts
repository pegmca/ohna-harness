import type { ApiResult, ModelCatalogDto } from "@aiagent/types";
import { parseApiResult } from "./http-client";

/** @param signal 取消信号。 @returns 服务端可用模型目录（本地为单模型）。 */
export async function listModels(signal?: AbortSignal): Promise<ApiResult<ModelCatalogDto>> {
  return parseApiResult(await fetch("/api/models", { signal }));
}
