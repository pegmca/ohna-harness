import type {
  ApiEnvelope,
  BatchSummary,
  DraftBatchValidationResult,
  DraftScopedValidationResult,
  DraftSummary,
  GoldenDraft,
  PdfEvidenceDocument,
  GoldenStudioClientOptions,
  RequestOptions
} from "./types.js";

/** Web 边界的结构化请求错误。 */
export class ApiError extends Error {
  /** 稳定错误码；传输失败固定为 network_error。 */
  readonly code: string;
  /** HTTP 状态码；传输失败为 0。 */
  readonly status: number;
  /** server 返回的机器可读详情。 */
  readonly details: Record<string, unknown>;

  /**
   * @param code 稳定错误码。
   * @param status HTTP 状态码。
   * @param message 可展示说明。
   * @param details 机器可读详情。
   */
  constructor(
    code: string,
    status: number,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Golden Studio Web 使用的数据客户端契约。 */
export interface GoldenStudioClient {
  /** 读取批次列表。 */
  listBatches(options?: RequestOptions): Promise<BatchSummary[]>;
  /** 读取一个批次内的草稿列表。 */
  listDrafts(batch: string, options?: RequestOptions): Promise<DraftSummary[]>;
  /** 读取单个草稿。 */
  readDraft(batch: string, id: string, options?: RequestOptions): Promise<GoldenDraft>;
  /** 保存单个草稿。 */
  saveDraft(
    batch: string,
    id: string,
    draft: GoldenDraft,
    options?: RequestOptions
  ): Promise<GoldenDraft>;
  /** 按语料相对路径读取 PDF 证据投影。 */
  readEvidence(
    filePath: string,
    options?: RequestOptions
  ): Promise<PdfEvidenceDocument>;
  /** 构造受控 PDF 字节流 URL，供内嵌预览使用。 */
  evidenceContentUrl(filePath: string): string;
  /** 保存后校验整个批次，并返回服务端结构化报告。 */
  validateBatch(
    batch: string,
    options?: RequestOptions
  ): Promise<DraftBatchValidationResult>;
  /** 校验当前草稿，并返回无跨草稿归因的权威报告。 */
  validateDraft(
    batch: string,
    id: string,
    options?: RequestOptions
  ): Promise<DraftScopedValidationResult>;
}

/**
 * 创建同源 Golden Studio 数据客户端。
 *
 * baseUrl 默认 `/`（同源），也允许指向独立 server 以便本地联调与测试注入。
 *
 * @param baseUrl 客户端请求的基础 URL。
 * @param options 客户端构造选项。
 * @returns 带统一信封解析与结构化错误的客户端。
 */
export function createGoldenStudioClient(
  baseUrl: string = "/",
  options: GoldenStudioClientOptions = {}
): GoldenStudioClient {
  const base = resolveBaseUrl(baseUrl);
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  /**
   * 发起请求并解包统一信封。
   *
   * @template T 成功响应的数据类型。
   * @param path 不含 baseUrl 的相对路径。
   * @param init fetch 选项。
   * @returns 解包后的数据。
   * @throws {ApiError} 传输失败、响应格式非法或 server 返回错误信封。
   */
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal = init.signal ?? AbortSignal.timeout(requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(new URL(path, base), { ...init, signal });
    } catch (error) {
      if (signal.aborted && isTimeoutAbort(signal)) {
        throw new ApiError(
          "request_timeout",
          0,
          `Request for ${path} timed out after ${requestTimeoutMs}ms.`,
          { requestTimeoutMs }
        );
      }
      const message = error instanceof Error ? error.message : "Network request failed.";
      throw new ApiError("network_error", 0, message, {});
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        "unexpected_response",
        response.status,
        `Response for ${path} is not valid JSON.`,
        {}
      );
    }

    const envelope = body as ApiEnvelope<T>;
    if (envelope.ok === false) {
      throw new ApiError(
        envelope.error.code,
        envelope.error.status,
        `${envelope.error.code}: ${envelope.error.message}`,
        envelope.error.details
      );
    }
    if (envelope.ok !== true) {
      throw new ApiError(
        "unexpected_response",
        response.status,
        `Response for ${path} is not a Golden Studio envelope.`,
        {}
      );
    }
    return envelope.data;
  }

  return {
    listBatches: (options) =>
      request<BatchSummary[]>("api/batches", { method: "GET", ...options }),
    listDrafts: (batch, options) =>
      request<DraftSummary[]>(
        `api/batches/${encodeURIComponent(batch)}/drafts`,
        { method: "GET", ...options }
      ),
    readDraft: (batch, id, options) =>
      request<GoldenDraft>(
        `api/batches/${encodeURIComponent(batch)}/drafts/${encodeURIComponent(id)}`,
        { method: "GET", ...options }
      ),
    saveDraft: (batch, id, draft, options) =>
      request<GoldenDraft>(
        `api/batches/${encodeURIComponent(batch)}/drafts/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draft }),
          ...options
        }
      ),
    readEvidence: (filePath, options) =>
      request<PdfEvidenceDocument>(
        `api/evidence?path=${encodeURIComponent(filePath)}`,
        { method: "GET", ...options }
      ),
    evidenceContentUrl: (filePath) =>
      new URL(
        `api/evidence/content?path=${encodeURIComponent(filePath)}`,
        base
      ).toString(),
    validateBatch: (batch, options) =>
      request<DraftBatchValidationResult>("api/actions/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          scope: "batch",
          batch
        }),
        ...options
      }),
    validateDraft: (batch, id, requestOptions) =>
      request<DraftScopedValidationResult>("api/actions/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          scope: "draft",
          batch,
          id
        }),
        ...requestOptions
      })
  };
}

/**
 * 判断取消原因是否为稳定请求超时。
 *
 * @param signal 当前请求信号。
 * @returns TimeoutError 时为 true。
 */
function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError";
}

/**
 * 把可能为相对路径的 baseUrl 规范化为绝对 URL。
 *
 * @param baseUrl 调用方传入的基础 URL。
 * @returns 可用于 URL 构造的绝对基础地址。
 */
function resolveBaseUrl(baseUrl: string): string {
  if (baseUrl.startsWith("/")) {
    const origin = globalThis.location?.origin ?? "http://127.0.0.1";
    return new URL(baseUrl, origin).toString();
  }
  return new URL(baseUrl).toString();
}
