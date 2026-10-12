import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveValue } from "../dist/index.js";

// B1 回归：命中敏感键时只对字符串整值脱敏，数字 token 计数与数组必须保留，避免落库数据损坏。
test("redactSensitiveValue 仅对敏感键的字符串整值脱敏，保留数字与数组", () => {
  const input = {
    content: "联系 alice@example.com 或 13800138000",
    usage: { input: 120, output: 80, totalTokens: 200, cost: { total: 0.002 } },
    messages: [
      { role: "assistant", content: [{ type: "text", text: "hi" }] }
    ]
  };

  const out = redactSensitiveValue(input);

  // 敏感键 content 为字符串 → 整值脱敏。
  assert.equal(out.content, "[redacted]");

  // 敏感键 usage.input / usage.output 为数字 → 必须保留，不可被替换为 "[redacted]" 字符串。
  assert.equal(typeof out.usage.input, "number");
  assert.equal(out.usage.input, 120);
  assert.equal(typeof out.usage.output, "number");
  assert.equal(out.usage.output, 80);
  assert.equal(out.usage.totalTokens, 200);
  assert.equal(out.usage.cost.total, 0.002);

  // 敏感键 messages 为数组 → 必须保留且元素递归保留。
  assert.ok(Array.isArray(out.messages));
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, "assistant");
  assert.deepEqual(out.messages[0].content, [{ type: "text", text: "hi" }]);

  // 原对象不被修改。
  assert.equal(input.usage.input, 120);
});
