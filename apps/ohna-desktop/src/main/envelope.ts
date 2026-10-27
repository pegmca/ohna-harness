/**
 * 渲染端请求信封的形状校验（fail-closed，spec §4.2 / §9）。
 *
 * 抽成纯模块（不依赖 Electron）以便纯 Node 单测直接驱动；ipc.ts 仅 re-export 本函数，
 * 保持「main 校验 sender 归属 + 信封形状」的两道防线集中可读。协议版本不匹配、
 * requestId/method 非字符串、payload 非对象都拒绝。
 */
import {
  PROTOCOL_VERSION,
  type RuntimeErrorDto,
  type RuntimeRequestEnvelope,
} from "@aiagent/types";

/**
 * 校验渲染端发来的请求信封形状（fail-closed）。
 * 协议版本不匹配、requestId/method 非字符串、payload 非对象都拒绝。
 *
 * @param envelope 待校验信封。
 * @returns 校验错误 DTO（含 `protocol_mismatch` / `bad_request`），合法时返回 null。
 */
export function validateEnvelope(envelope: unknown): RuntimeErrorDto | null {
  if (!envelope || typeof envelope !== "object") {
    return { code: "bad_request", message: "信封必须是对象", requestId: "" };
  }
  const candidate = envelope as Record<string, unknown>;
  if (candidate.protocolVersion !== PROTOCOL_VERSION) {
    return {
      code: "protocol_mismatch",
      message: `协议版本不匹配：期望 ${PROTOCOL_VERSION}`,
      requestId: typeof candidate.requestId === "string" ? candidate.requestId : ""
    };
  }
  if (typeof candidate.requestId !== "string" || candidate.requestId.trim() === "") {
    return { code: "bad_request", message: "requestId 必须是非空字符串", requestId: "" };
  }
  if (typeof candidate.method !== "string" || candidate.method.trim() === "") {
    return { code: "bad_request", message: "method 必须是非空字符串", requestId: candidate.requestId };
  }
  if (candidate.payload !== undefined && (typeof candidate.payload !== "object" || candidate.payload === null)) {
    return { code: "bad_request", message: "payload 必须是对象", requestId: candidate.requestId };
  }
  return null;
}

/** 合法信封类型再导出，便于 ipc.ts 本地引用。 */
export type { RuntimeRequestEnvelope };
