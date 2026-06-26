import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../dist/index.js";

test("POST /api/agent/run returns structured agent response", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "帮我查询 000001.SZ 最近一期净利润和 ROE。",
      reportMode: false
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.intent, "tool");
  assert.equal(body.data.ok, true);
  assert.equal(body.data.trace.events.some((event) => event.type === "tool_call"), true);

  await app.close();
});

test("POST /api/agent/run rejects empty messages with ApiResult failure", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "   "
    }
  });

  assert.equal(response.statusCode, 400);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "validation_failed");

  await app.close();
});

test("POST /api/agent/run returns structured agent failures with trace", async () => {
  const app = createApiServer();
  const response = await app.inject({
    method: "POST",
    url: "/api/agent/run",
    payload: {
      message: "帮我查询 999999.SZ 最近一期净利润和 ROE。"
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.ok, false);
  assert.equal(body.data.error.code, "agent_failed");
  assert.equal(body.data.trace.events.some((event) => event.type === "final_response" && event.ok === false), true);

  await app.close();
});
