import type { ModelOptionDto } from "@aiagent/types";
import { useEffect, useState } from "react";
import { listModels, uploadChatAttachment } from "../../shared/api/composer-client";
import { formatApiError } from "./format";
import type { DraftAttachment } from "./types";

/** Composer 模型目录与附件草稿状态，避免页面壳承担上传细节。 */
export interface ComposerDraftState {
  models: ModelOptionDto[];
  selectedModelId: string;
  modelCatalogStatus: "loading" | "ready" | "failed";
  modelCatalogError?: string;
  attachments: DraftAttachment[];
  onFilesSelected(files: FileList): void;
  removeAttachment(clientAttachmentId: string): void;
  retryAttachment(clientAttachmentId: string): void;
  selectModel(modelId: string): void;
  clearAttachments(clientAttachmentIds?: readonly string[]): void;
  retryModels(): void;
}

/**
 * 管理模型偏好与附件上传生命周期。
 *
 * @param reportError 将非阻塞校验错误展示到 Composer。
 * @param ensureConversationId 解析当前会话 ID：已有会话直接返回，否则按需创建；创建失败返回 null。
 *   附件是会话级临时资源，上传接口要求 conversationId，因此在发起上传前必须先拿到会话。
 * @returns Composer 草稿状态与操作。
 */
export function useComposerState(
  reportError: (message: string) => void,
  ensureConversationId: () => Promise<string | null>
): ComposerDraftState {
  const [models, setModels] = useState<ModelOptionDto[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
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

  /** @param files 用户选择的文件。 @returns 无返回值。 */
  function onFilesSelected(files: FileList): void {
    const remaining = Math.max(0, 5 - attachments.length);
    if (files.length > remaining) reportError("每条消息最多上传 5 个附件。");
    for (const file of Array.from(files).slice(0, remaining)) {
      const draft: DraftAttachment = {
        clientAttachmentId: crypto.randomUUID(),
        fileName: file.name,
        contentType: file.type || (file.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain"),
        sizeBytes: file.size,
        status: "uploading",
        file
      };
      setAttachments((current) => [...current, draft]);
      void upload(draft);
    }
  }

  /** @param draft 待上传草稿。 @returns 上传和索引完成 Promise。 */
  async function upload(draft: DraftAttachment): Promise<void> {
    const extensionAllowed = /\.(md|markdown|txt)$/i.test(draft.fileName);
    if (!extensionAllowed || draft.sizeBytes > 10 * 1024 * 1024) {
      update(draft.clientAttachmentId, {
        status: "failed",
        error: extensionAllowed ? "文件不能超过 10 MB。" : "仅支持 MD 和 TXT 文件。"
      });
      return;
    }
    try {
      // 附件按会话隔离：上传前先确保会话存在，否则服务端会拒绝缺少 conversationId 的请求。
      const conversationId = await ensureConversationId();
      if (!conversationId) {
        update(draft.clientAttachmentId, {
          status: "failed",
          error: "无法创建会话，附件上传已取消。"
        });
        return;
      }
      const result = await uploadChatAttachment({
        clientAttachmentId: draft.clientAttachmentId,
        conversationId,
        fileName: draft.fileName,
        contentType: draft.contentType,
        sizeBytes: draft.sizeBytes,
        content: await draft.file.text()
      });
      update(draft.clientAttachmentId, result.ok
        ? { status: "indexed", documentId: result.data.documentId, error: undefined }
        : { status: "failed", error: formatApiError(result.error) });
    } catch (error) {
      update(draft.clientAttachmentId, {
        status: "failed",
        error: error instanceof Error ? error.message : "附件上传失败。"
      });
    }
  }

  /** @param id 附件 ID。 @param patch 状态补丁。 @returns 无返回值。 */
  function update(id: string, patch: Partial<DraftAttachment>): void {
    setAttachments((current) => current.map((item) =>
      item.clientAttachmentId === id ? { ...item, ...patch } : item));
  }

  /** @param id 附件 ID。 @returns 无返回值。 */
  function retryAttachment(id: string): void {
    const draft = attachments.find((item) => item.clientAttachmentId === id);
    if (!draft) return;
    update(id, { status: "uploading", error: undefined });
    void upload({ ...draft, status: "uploading", error: undefined });
  }

  /** @param modelId 模型 ID。 @returns 无返回值。 */
  function selectModel(modelId: string): void {
    setSelectedModelId(modelId);
    try {
      window.localStorage.setItem("aiagent.selected-model", modelId);
    } catch {
      // localStorage 不可用时只保留页面内选择。
    }
  }

  return {
    models,
    selectedModelId,
    modelCatalogStatus,
    modelCatalogError,
    attachments,
    onFilesSelected,
    removeAttachment: (id) => setAttachments((current) =>
      current.filter((attachment) => attachment.clientAttachmentId !== id)),
    retryAttachment,
    retryModels: () => void loadCatalog(new AbortController().signal),
    selectModel,
    clearAttachments: (ids) => setAttachments((current) => {
      if (!ids) return [];
      const submitted = new Set(ids);
      return current.filter((attachment) => !submitted.has(attachment.clientAttachmentId));
    })
  };
}

/** @returns 浏览器保存的模型 ID；存储不可用时返回 null。 */
function readStoredModelId(): string | null {
  try {
    return window.localStorage.getItem("aiagent.selected-model");
  } catch {
    return null;
  }
}
