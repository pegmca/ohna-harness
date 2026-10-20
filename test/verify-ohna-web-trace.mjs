#!/usr/bin/env node
/**
 * ohna 观测台（Trace）端到端验证：不联网、不碰真实 `~/.ohna`。
 *
 * 覆盖两条生产路径（docs/v1.4/02-web-llm-trace.md §5 TC-W5-01/02/03）：
 * 1. 托管 run：`createOhnaServer` + stub streamFn，在 `options.onPayload` 回填模拟请求体 →
 *    `createRun` → 事件流里必须出现完整的 `llm_call`（providerPayload + response + durationMs）。
 * 2. observe run：`observeRun()` 合成事件 → 与托管 run 同构地落盘/回放（CLI 镜像路径）。
 * 3. 静态托管：`apps/ohna-web/dist` 存在时 `GET /trace` 必须 200（不存在则跳过，不算失败）。
 *
 * 运行：
 *   pnpm --filter @aiagent/serve build
 *   pnpm --filter @aiagent/ohna-web build   # 可选，缺失时只跳过静态断言
 *   node test/verify-ohna-web-trace.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "../packages/ai/dist/index.js";
import { createOhnaServer } from "../packages/serve/dist/index.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(repoRoot, "apps/ohna-web/dist");

assert.ok(
  existsSync(path.join(repoRoot, "packages/serve/dist/index.js")),
  "请先 pnpm --filter @aiagent/serve build"
);

const MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096
};

/** 打印一条通过的断言。 */
function pass(message) {
  process.stdout.write(`✓ ${message}\n`);
}

/** 打印一条跳过的检查。 */
function skip(message) {
  process.stdout.write(`- ${message}\n`);
}

/**
 * 构造 assistant 消息。
 *
 * @param {string} text 文本。
 * @returns {object} AssistantMessage。
 */
function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "stub-model",
    usage: {
      input: 9,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 21,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

/**
 * stub StreamFn：像真实 adapter 一样在 provider 位置调用 onPayload / onResponse。
 *
 * @returns {Function} StreamFn。
 */
function createTraceableStream() {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage("托管回复");
    queueMicrotask(async () => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      await options?.onPayload?.(
        {
          model: model.id,
          messages: context.messages,
          stream: true,
          // 回填字段用于证明「记录到的是最终 provider 请求体」。
          stubMarker: "verify-trace"
        },
        model
      );
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      stream.push({ type: "text_delta", contentIndex: 0, delta: "托管回复", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 构造一条 llm_call 记录（observe 路径：模拟 CLI 采集层产物）。
 *
 * @returns {object} LlmCallRecordDto。
 */
function syntheticRecord() {
  return {
    callId: "verify-call-1",
    callIndex: 1,
    startedAt: Date.now() - 3,
    durationMs: 3,
    attemptCount: 1,
    request: {
      provider: "mock",
      api: "openai-completions",
      modelId: "stub-model",
      baseUrl: "http://127.0.0.1/mock",
      systemPrompt: "verify system prompt",
      messages: [{ role: "user", content: "镜像消息", timestamp: 1 }],
      tools: [{ name: "read", description: "read file" }],
      providerPayload: { model: "stub-model", stream: true, messages: [{ role: "user", content: "镜像消息" }] }
    },
    response: {
      status: 200,
      finishReason: "stop",
      usage: {
        input: 9,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 21,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      message: assistantMessage("镜像回复")
    }
  };
}

/**
 * 解析 SSE 文本里的 run_event 帧。
 *
 * @param {string} body SSE 响应体。
 * @returns {object[]} canonical run event 列表。
 */
function parseSseFrames(body) {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes("event: run_event"))
    .map((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return JSON.parse(data);
    });
}

/**
 * 轮询直到 run 进入终态。
 *
 * @param {string} baseUrl 服务地址。
 * @param {string} runId run id。
 * @returns {Promise<object>} 终态快照。
 */
async function waitForTerminal(baseUrl, runId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);
    const payload = await response.json();
    const snapshot = payload?.data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} 未在超时前进入终态`);
}

/**
 * 读取某 run 的完整事件流（终态后服务端 replay 完即关闭连接）。
 *
 * @param {string} baseUrl 服务地址。
 * @param {string} runId run id。
 * @returns {Promise<object[]>} 事件列表。
 */
async function readRunEvents(baseUrl, runId) {
  const response = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events`, {
    headers: { accept: "text/event-stream" }
  });
  assert.equal(response.status, 200, "事件流端点应返回 200");
  return parseSseFrames(await response.text());
}

/**
 * 断言 llm_call 记录字段完整（两条路径共用）。
 *
 * @param {object} record LlmCallRecordDto。
 * @param {string} label 断言标签。
 */
function assertLlmRecord(record, label) {
  assert.ok(record, `${label}: 事件流必须包含 llm_call`);
  assert.ok(record.request?.providerPayload, `${label}: providerPayload 必须存在`);
  assert.equal(record.request.providerPayload.stream, true, `${label}: providerPayload 应为最终请求体`);
  assert.ok(record.request.modelId, `${label}: request.modelId 必须存在`);
  assert.ok(record.response, `${label}: response 必须存在`);
  assert.ok(record.response.message, `${label}: response.message 必须存在`);
  assert.ok(record.response.usage, `${label}: response.usage 必须存在`);
  assert.equal(typeof record.response.usage.cost.total, "number", `${label}: usage.cost.total 必须是数字`);
  assert.ok(record.response.finishReason, `${label}: finishReason 必须存在`);
  assert.equal(typeof record.durationMs, "number", `${label}: durationMs 必须是数字`);
  assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0, `${label}: durationMs 必须 ≥ 0`);
}

/**
 * 主流程：托管 run → observe run → 静态托管。
 */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-trace-verify-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "verify system prompt",
    tools: [],
    staticDir: webDist,
    streamFn: createTraceableStream()
  });
  const { url } = await server.listen(0);

  try {
    const conversation = await server.createConversation("verify-trace");

    // ---- 路径 1：托管 run ----
    const created = await server.createRun({
      conversationId: conversation.conversationId,
      message: "验证托管路径",
      requestId: "verify-managed"
    });
    const managedSnapshot = await waitForTerminal(url, created.accepted.runId);
    assert.equal(managedSnapshot.status, "completed", "托管 run 应正常完成");

    const managedEvents = await readRunEvents(url, created.accepted.runId);
    const managedCall = managedEvents.find((event) => event.type === "llm_call");
    assertLlmRecord(managedCall?.payload, "托管路径");
    assert.equal(managedCall.payload.request.providerPayload.stubMarker, "verify-trace", "providerPayload 应包含 stub 回填字段");
    assert.equal(managedCall.payload.response.usage.totalTokens, 21, "usage 应来自最终 AssistantMessage");
    assert.equal(managedCall.payload.response.message.content[0].text, "托管回复", "response.message 应透传内容");
    pass(`托管 run：llm_call 完整（providerPayload + response.usage.cost + durationMs=${managedCall.payload.durationMs}）`);

    // ---- 路径 2：observe run（CLI 镜像） ----
    const observed = await server.observeRun({
      conversationId: conversation.conversationId,
      requestId: "verify-observe:1"
    });
    observed.push({ type: "message_start", message: { role: "user", content: "镜像消息", timestamp: 1 } });
    observed.push({ type: "message_end", message: { role: "user", content: "镜像消息", timestamp: 1 } });
    observed.push({ type: "message_end", message: assistantMessage("镜像回复") });
    observed.push({ type: "llm_call", payload: syntheticRecord() });
    observed.end();

    const observeSnapshot = await waitForTerminal(url, observed.runId);
    assert.equal(observeSnapshot.status, "completed", "observe run 应由 end() 正常收尾");
    assert.equal(observeSnapshot.mode, "observe", "observe run 的 mode 应为 observe");
    assert.equal(observeSnapshot.source, "cli", "observe run 的 source 应为 cli");

    const observedEvents = await readRunEvents(url, observed.runId);
    const observedCall = observedEvents.find((event) => event.type === "llm_call");
    assertLlmRecord(observedCall?.payload, "观测路径");
    assert.equal(observedCall.payload.request.systemPrompt, "verify system prompt", "观测路径应保留 systemPrompt");
    assert.equal(observedCall.payload.response.message.content[0].text, "镜像回复", "观测路径应保留最终消息");
    assert.ok(
      observedEvents.every((event) => event.type !== "message_update"),
      "message_update 是瞬态事件，不应出现在落盘/replay 中"
    );
    pass("observe run：llm_call 与消息事件按序列落盘并可 replay");

    // observe 型 run 不写会话消息（避免与 CLI 本地会话双份存储）。
    // 注意：同一 conversation 里托管 run 的 assistant 消息是正常落盘的，这里只针对本次 observe runId。
    const conversationFile = path.join(dataDir, "conversations", `${conversation.conversationId}.jsonl`);
    const rows = (await fs.readFile(conversationFile, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.some((row) => row.role === "assistant" && row.runId === observed.runId),
      false,
      "observe 型 run 不得写入 assistant 会话消息"
    );
    assert.ok(
      rows.some((row) => row.role === "assistant" && row.runId === created.accepted.runId),
      "托管 run 的 assistant 消息应正常落盘"
    );
    pass("observe 型 run 未污染会话消息存储（托管 run 消息保持落盘）");

    // ---- 路径 3：静态托管 ----
    if (existsSync(path.join(webDist, "index.html"))) {
      const traceResponse = await fetch(`${url}/trace`);
      assert.equal(traceResponse.status, 200, "GET /trace 应返回 200");
      assert.match(traceResponse.headers.get("content-type") ?? "", /text\/html/, "GET /trace 应返回 HTML");
      pass("静态托管：GET /trace 200（返回前端构建产物）");
    } else {
      skip("未找到 apps/ohna-web/dist，跳过 GET /trace 断言（运行 pnpm --filter @aiagent/ohna-web build 后可覆盖）");
    }

    process.stdout.write("\n全部 trace 端到端断言通过（本地桩模型，无真实 key）。\n");
  } finally {
    await server.shutdown().catch(() => undefined);
    await server.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`\n✗ trace 端到端验证失败：${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
