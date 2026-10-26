/**
 * schema.ts 占位校验测试：Task 2 只建立 SCHEMA_VERSION 常量与占位校验函数，
 * 真正的行级 schema 校验接线由 Task 10 完成。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMA_VERSION, schemaLine } from "../dist/store/schema.js";

test("SCHEMA_VERSION === 1（首版数据格式）", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("schemaLine: 数字 schema 字段等于 SCHEMA_VERSION 时通过", () => {
  assert.equal(schemaLine({ schema: 1 }), true);
});

test("schemaLine: 非 1 的 schema 版本拒绝", () => {
  assert.equal(schemaLine({ schema: 2 }), false);
  assert.equal(schemaLine({ schema: 0 }), false);
});

test("schemaLine: 非对象或缺字段拒绝", () => {
  assert.equal(schemaLine(null), false);
  assert.equal(schemaLine("not-an-object"), false);
  assert.equal(schemaLine({}), false);
  assert.equal(schemaLine({ schema: "1" }), false);
});
