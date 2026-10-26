/**
 * runtime 边界错误映射与参数校验测试。
 *
 * 不启动模型、不加载 Fastify，只验证 `toRuntimeError` 的归一映射与
 * `assertProtocolVersion` / `validateId` / `validateString` 的 fail-closed 校验。
 * 经 `../dist/index.js` 引用已编译产物，运行前需先 `pnpm build`。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toRuntimeError, assertProtocolVersion, validateString, validateId } from "../dist/index.js";

test("toRuntimeError: 普通 Error 归一到 internal_error", () => {
  const err = toRuntimeError(new Error("x"), "r1");
  assert.equal(err.code, "internal_error");
  assert.equal(err.message, "x");
  assert.equal(err.requestId, "r1");
});

test("toRuntimeError: 已是归一错误时保留原始 code 并回填 requestId", () => {
  const err = toRuntimeError({ code: "not_found", message: "找不到", requestId: "old" }, "r2");
  assert.equal(err.code, "not_found");
  assert.equal(err.message, "找不到");
  assert.equal(err.requestId, "r2");
});

test("toRuntimeError: fallbackCode 覆盖未知错误形态", () => {
  const err = toRuntimeError({ weird: true }, "r3", "bad_request");
  assert.equal(err.code, "bad_request");
  assert.equal(err.requestId, "r3");
});

test("assertProtocolVersion: 不匹配被包成 protocol_mismatch", () => {
  assert.throws(
    () => {
      try {
        assertProtocolVersion(2);
      } catch (e) {
        throw toRuntimeError(e, "r1", "protocol_mismatch");
      }
    },
    (e) => e.code === "protocol_mismatch" && e.requestId === "r1"
  );
});

test("assertProtocolVersion: 匹配时通过", () => {
  assert.doesNotThrow(() => assertProtocolVersion(1));
});

test("validateId: 非法 id 抛出 validation_failed", () => {
  assert.throws(
    () => {
      try {
        validateId("../etc", "conversationId");
      } catch (e) {
        throw toRuntimeError(e, "r1", "validation_failed");
      }
    },
    (e) => e.code === "validation_failed" && e.requestId === "r1"
  );
});

test("validateId: 合法 id 通过", () => {
  assert.doesNotThrow(() => validateId("abc-123", "conversationId"));
});

test("validateString: 非字符串或空串抛出 validation_failed", () => {
  assert.throws(
    () => {
      try {
        validateString("", "title");
      } catch (e) {
        throw toRuntimeError(e, "r1", "validation_failed");
      }
    },
    (e) => e.code === "validation_failed"
  );
  assert.throws(
    () => {
      try {
        validateString(42, "title");
      } catch (e) {
        throw toRuntimeError(e, "r1", "validation_failed");
      }
    },
    (e) => e.code === "validation_failed"
  );
});

test("validateString: 合法非空串通过", () => {
  assert.doesNotThrow(() => validateString("hello", "title"));
});
