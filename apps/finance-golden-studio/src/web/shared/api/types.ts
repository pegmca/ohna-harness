import type { BatchSummary, DraftSummary, GoldenDraft } from "../../../core/types.js";

/** 统一错误信封中的错误对象。 */
export interface ApiErrorShape {
  /** HTTP 状态码。 */
  status: number;
  /** server 提供的稳定错误码。 */
  code: string;
  /** 可直接展示给用户的说明。 */
  message: string;
  /** 机器可读的错误详情。 */
  details: Record<string, unknown>;
}

/** Golden Studio server 的统一 JSON 信封。 */
export type ApiEnvelope<TData> =
  | { ok: true; data: TData }
  | { ok: false; error: ApiErrorShape };

/** 请求级可选项；目前只暴露取消信号。 */
export interface RequestOptions {
  /** 取消请求用的 AbortSignal。 */
  signal?: AbortSignal;
}

export type {
  BatchSummary,
  DraftSummary,
  GoldenDraft
};
