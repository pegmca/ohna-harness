/**
 * runtime 边界的入参形状校验。
 *
 * 这些断言在 preload / runtime 边界使用：协议版本不匹配、id 越界、字段缺省
 * 都 fail-closed。断言抛出的错误交由 `toRuntimeError(..., "<对应码>")` 包成
 * 归一 `RuntimeErrorDto`，不应直接向外传播裸 Error。
 */
import { PROTOCOL_VERSION } from "@aiagent/types";
import { isValidStoreId } from "./store/jsonl.js";

/**
 * 断言协议版本与当前 runtime 一致，不一致即抛出，由调用方归一成 `protocol_mismatch`。
 *
 * @param version 信封携带的 `protocolVersion`。
 * @throws 当版本号缺失或与本端 `PROTOCOL_VERSION` 不相等时。
 */
export function assertProtocolVersion(version: unknown): asserts version is typeof PROTOCOL_VERSION {
  if (typeof version !== "number" || version !== PROTOCOL_VERSION) {
    throw new Error(`协议版本不匹配：期望 ${PROTOCOL_VERSION}，实际 ${String(version)}`);
  }
}

/**
 * 断言非空字符串字段，缺省 / 空串 / 非字符串都抛出，供调用方归一成 `validation_failed`。
 *
 * @param value 待校验值。
 * @param field 字段名（用于错误定位，不向外暴露）。
 * @throws 当值不是非空字符串时。
 */
export function validateString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`字段 ${field} 必须是非空字符串`);
  }
}

/**
 * 断言安全存储 id（复用 store 的白名单），拒绝 `../`、`/` 等路径逃逸。
 *
 * @param value 待校验 id。
 * @param field 字段名（用于错误定位，不向外暴露）。
 * @throws 当 id 不在白名单内时。
 */
export function validateId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !isValidStoreId(value)) {
    throw new Error(`字段 ${field} 不是合法存储 id：期望字母数字连字符下划线，实际 ${String(value)}`);
  }
}
