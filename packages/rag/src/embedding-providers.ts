import {
  type EmbeddingClient,
  type EmbeddingItem,
  type EmbeddingResult,
  type RagStructuredError
} from "./types.js";
import { createDeterministicMockEmbeddingClient } from "./embedding.js";
import { readBridgeEmbeddingConfig } from "./bridge-config.js";

/**
 * 真实 OpenAI 兼容 embedding 端点的配置。
 *
 * 统一走私有 bridge（base URL 形如 `http://host/v1`），所有真实 provider 调用都复用它，
 * 避免在 embedding 实现里硬编码端点或 key；维度由调用方显式传入，便于与向量库列维度保持一致。
 */
export interface OpenAiCompatibleEmbeddingClientOptions {
  /** OpenAI 兼容端点（含 /v1 前缀，base URL 不含具体路径）。 */
  baseUrl: string;
  /** 鉴权 Bearer token，来自 bridge 环境变量。 */
  apiKey: string;
  /** 模型名（如 text-embedding-3-small / bge-m3）。 */
  model: string;
  /** 向量维度，需与向量库列维度一致；<=0 会被视为非法输入。 */
  dimensions: number;
}

/**
 * 创建 OpenAI 兼容 embedding client。
 *
 * 为什么走结构化 union 而不向上抛异常：embedding 是 RAG 索引/检索的关键外部依赖，
 * 网络抖动、key 失效、供应商返回格式漂移都可能出现；让调用方用 `result.ok` 分支处理，
 * 可避免把原始异常泄漏到 UI 或破坏批次索引流程（AGENTS.md 结构化错误要求）。
 *
 * @param options 端点、key、模型名与维度。
 * @returns 实现 EmbeddingClient 的真实 provider client。
 */
export function createOpenAiCompatibleEmbeddingClient(
  options: OpenAiCompatibleEmbeddingClientOptions
): EmbeddingClient {
  return new OpenAiCompatibleEmbeddingClient(options);
}

/**
 * OpenAI 兼容 `/v1/embeddings` 端点的运行时实现。
 *
 * 通过全局 `fetch` POST，解析 `data[]`（`{ embedding, index }`）映射回输入文本；
 * 全程捕获网络异常与字段缺失，统一收敛为 `EmbeddingResult` 的 ok/error union。
 */
class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;

  /**
   * 创建真实 embedding client。
   *
   * @param options 端点、key、模型名与维度。
   */
  public constructor(options: OpenAiCompatibleEmbeddingClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  /**
   * 将文本数组转换为真实向量。
   *
   * 行为要点（安全与结构化）：
   * - 维度非法（<=0）直接返回 `invalid_embedding_input`，不发起网络请求。
   * - 空输入安全返回 ok 空 embeddings，不让空批次触发供应商报错。
   * - HTTP 非 2xx / 网络异常 / 响应字段缺失 一律返回 `embedding_failed`。
   *
   * @param texts 待 embedding 的文本数组。
   * @returns 成功返回向量与 usage；失败返回结构化错误，绝不抛异常。
   */
  public async embedTexts(texts: readonly string[]): Promise<EmbeddingResult> {
    // 维度非法：属于调用方配置错误，提前结构化失败，避免无意义的网络往返。
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      return {
        ok: false,
        error: {
          code: "invalid_embedding_input",
          message: "embedding dimensions 必须是大于 0 的整数。",
          details: {
            dimensions: this.dimensions
          }
        }
      };
    }

    // 空输入安全处理：返回 ok 空数组，保持批次索引鲁棒。
    if (texts.length === 0) {
      return {
        ok: true,
        embeddings: [],
        usage: {
          inputTexts: 0,
          inputCharacters: 0
        },
        dimensions: this.dimensions,
        model: this.model
      };
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions
        })
      });
    } catch (cause) {
      // 网络层异常（DNS/超时/连接被拒）：结构化收敛，便于上层重试或降级。
      return {
        ok: false,
        error: this.createFailedError(
          `embedding 请求失败：${cause instanceof Error ? cause.message : String(cause)}`
        )
      };
    }

    // HTTP 非 2xx：携带 status，便于区分鉴权/限流/网关错误。
    if (!response.ok) {
      return {
        ok: false,
        error: this.createFailedError(`embedding 端点返回非 2xx 状态。`, {
          status: response.status
        })
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      return {
        ok: false,
        error: this.createFailedError(
          `embedding 响应解析失败：${cause instanceof Error ? cause.message : String(cause)}`
        )
      };
    }

    // 字段缺失校验：data 必须是非空数组，且每项含 number[] embedding 与 index。
    const data = (payload as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      return {
        ok: false,
        error: this.createFailedError("embedding 响应缺少 data 数组。")
      };
    }

    const embeddings: EmbeddingItem[] = [];
    for (const item of data) {
      const record = item as { embedding?: unknown; index?: unknown };
      if (
        !Array.isArray(record.embedding) ||
        !record.embedding.every((value) => typeof value === "number") ||
        typeof record.index !== "number"
      ) {
        return {
          ok: false,
          error: this.createFailedError("embedding 响应项缺少合法 embedding 或 index。")
        };
      }
      const index = record.index as number;
      embeddings.push({
        text: texts[index] ?? "",
        vector: record.embedding as number[],
        index,
        model: this.model
      });
    }

    return {
      ok: true,
      embeddings,
      usage: {
        inputTexts: texts.length,
        inputCharacters: texts.reduce((total, text) => total + text.length, 0)
      },
      dimensions: this.dimensions,
      model: this.model
    };
  }

  /**
   * 构造 `embedding_failed` 结构化错误。
   *
   * @param message 人类可读错误信息。
   * @param extra 额外的 details（如 HTTP status）。
   * @returns 结构化错误。
   */
  private createFailedError(
    message: string,
    extra: Record<string, unknown> = {}
  ): RagStructuredError {
    return {
      code: "embedding_failed",
      message,
      details: {
        model: this.model,
        ...extra
      }
    };
  }
}

/**
 * 根据环境变量创建生产级 embedding client（组合开关）。
 *
 * 为什么 env 缺省回退 mock：本地开发 / CI / eval 往往没有真实 key，
 * 直接失败会破坏整条索引链路；回退到 deterministic mock 可保证可复现、零外部依赖，
 * 真实环境配置 bridge 变量后自动切换为真实 provider，无需改代码（依赖倒置）。
 *
 * @returns bridge 启用时返回真实 client，否则返回 deterministic mock client。
 */
export function createEmbeddingClientFromEnv(): EmbeddingClient {
  const cfg = readBridgeEmbeddingConfig();
  if (!cfg.enabled) {
    return createDeterministicMockEmbeddingClient();
  }
  return createOpenAiCompatibleEmbeddingClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.embeddingModel,
    dimensions: cfg.dimensions
  });
}
