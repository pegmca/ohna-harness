import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText, redactSensitiveValue } from "../dist/index.js";

test("redacts secrets in text", () => {
  const text = "Authorization: Bearer sk-abc123def456; api-key-secretvalue123; Cookie: aiagent_session=raw-value";
  const redacted = redactSensitiveText(text);
  assert.equal(redacted.includes("sk-abc123def456"), false);
  assert.equal(redacted.includes("secretvalue123"), false);
  assert.equal(redacted.includes("raw-value"), false);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.match(redacted, /\[redacted\]/);
});

test("redacts PII in text", () => {
  const text = "联系人：user@example.com，手机 13812345678，身份证 11010519491231002X，卡号 6222 0201 2345 6789 012";
  const redacted = redactSensitiveText(text);
  assert.equal(redacted.includes("user@example.com"), false);
  assert.equal(redacted.includes("13812345678"), false);
  assert.equal(redacted.includes("11010519491231002X"), false);
  assert.equal(redacted.includes("6222 0201 2345 6789 012"), false);
  assert.match(redacted, /\[redacted:email\]/);
  assert.match(redacted, /\[redacted:phone\]/);
  assert.match(redacted, /\[redacted:id\]/);
  assert.match(redacted, /\[redacted:account\]/);
});

test("redactSensitiveValue redacts nested keys and truncates long strings", () => {
  const value = {
    authorization: "Bearer abc",
    session: "raw-session-value",
    sessionId: "raw-session-id",
    aiagent_session: "raw-aiagent-session",
    cookieHeader: "aiagent_session=raw-cookie-session; theme=dark",
    note: `Cookie: aiagent_session=raw-text-cookie; theme=dark\nBearer secret-token ${"x".repeat(600)}`,
    error: { code: "timeout", message: "Bearer hidden-token", details: { apiKey: "sk-secretsecretsecret" } }
  };
  const redacted = redactSensitiveValue(value);
  const serialized = JSON.stringify(redacted);
  for (const secret of [
    "secret-token", "secretsecretsecret", "raw-session-value", "raw-session-id",
    "raw-aiagent-session", "raw-cookie-session", "raw-text-cookie"
  ]) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("[truncated]"), true);
  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted.error.details.apiKey, "[redacted]");
});

test("redactSensitiveValue preserves non-sensitive primitives", () => {
  assert.equal(redactSensitiveValue(42), 42);
  assert.equal(redactSensitiveValue(null), null);
  assert.equal(redactSensitiveValue("hello"), "hello");
  assert.deepEqual(redactSensitiveValue([1, 2, 3]), [1, 2, 3]);
});
