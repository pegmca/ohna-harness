import type {
  ApiResult,
  ChatAttachmentDto,
  ChatAttachmentUploadRequestDto,
  ModelCatalogDto
} from "@aiagent/types";
import { parseApiResult } from "./http-client";

/** @param signal 取消信号。 @returns 服务端可用模型目录。 */
export async function listModels(signal?: AbortSignal): Promise<ApiResult<ModelCatalogDto>> {
  return parseApiResult(await fetch("/api/models", { signal }));
}

/**
 * 上传 Markdown/TXT 并等待私有 RAG 索引完成。
 *
 * @param input 已在浏览器完成基础校验的文本附件。
 * @param signal 取消信号。
 * @returns 已索引附件。
 */
export async function uploadChatAttachment(
  input: ChatAttachmentUploadRequestDto,
  signal?: AbortSignal
): Promise<ApiResult<ChatAttachmentDto>> {
  return parseApiResult(await fetch("/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal
  }));
}
