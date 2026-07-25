import assert from "node:assert/strict";
import test from "node:test";
import { ConversationRepositoryError } from "../dist/index.js";

test("对话 repository 错误不会序列化内部 cause", () => {
  const error = new ConversationRepositoryError("invalid_cursor", "Invalid conversation cursor.", new Error("private"));
  assert.equal(error.code, "invalid_cursor");
  assert.equal(JSON.stringify(error).includes("private"), false);
});
