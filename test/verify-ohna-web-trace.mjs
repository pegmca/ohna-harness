#!/usr/bin/env node
/**
 * ohna 观测台（Trace）端到端验证：不联网、不碰真实 `~/.ohna`。
 *
 * 覆盖三条生产路径（docs/v1.4/02 §5 TC-W5-01/02/03；v2.0 见 docs/v2.0/04 §3/§8）：
 * 1. 托管 run：`createOhnaServer` + stub streamFn，在 `options.onPayload` 回填模拟请求体 →
 *    `createRun` → 事件流里必须出现完整的 `llm_call`（providerPayload + response + durationMs +
 *    v2.0 的 window / agentId / composition）与带身份的 agent_start / turn_start。
 * 2. 压缩路径：同一个桩模型，把 `contextWindow` 调到能触发 run 前压缩的小窗 + 预置超长历史 →
 *    run 事件里必须出现 `context_event`（compaction 单 kind），且 sequence 落在 agent_start 之前。
 *    这条只证明「serve 发射的链路成立」，**不是**「真实 provider 下压缩行为正确」的证据。
 * 3. 静态托管：`apps/ohna-web/dist` 存在时 `GET /trace` 必须 200（不存在则跳过，不算失败）。
 *
 * 注：原「observe run」路径（CLI 镜像 + 合成事件句柄）已在 06 A3-B 退役，
 * 单一形态下执行权唯一归属 serve，故该脚本只验证托管 run 与静态托管两条路径。
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
import { createOhnaServer, LocalMessageStore } from "../packages/serve/dist/index.js";

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
  // v2.0（docs/v2.0/04 §1/§2）：Web 执行地图与上下文三面板直接消费这些字段，缺一项就画不出比例尺——
  // 因此线格式契约在这里断言，而不是只靠前端 fixture 自证。
  assert.ok(record.window, `${label}: window 必须存在（v2.0 必填）`);
  assert.equal(record.window.contextWindow, MODEL.contextWindow, `${label}: window.contextWindow 应来自模型配置`);
  assert.equal(record.window.maxTokens, MODEL.maxTokens, `${label}: window.maxTokens 应来自模型配置`);
  assert.equal(typeof record.window.reserveTokens, "number", `${label}: window.reserveTokens 必须是数字`);
  assert.ok(record.window.reserveTokens > 0, `${label}: window.reserveTokens 必须为正（压缩预留）`);
  assert.equal(record.agentId, "supervisor", `${label}: 主线程 llm_call 应归因 supervisor（v2.0 §2）`);
  assert.ok(record.composition, `${label}: composition 必须在 onPayload 阶段现算并落盘`);
  for (const key of ["system", "tools", "user", "assistant", "toolResult"]) {
    assert.equal(typeof record.composition[key], "number", `${label}: composition.${key} 必须是数字`);
  }
  assert.equal(
    typeof record.composition.total,
    "number",
    `${label}: composition.total 必须是数字`
  );
}

/**
 * 断言 run 事件带上 v2.0 的身份与 turn 锚点（执行地图的归属依据）。
 *
 * @param {object[]} events canonical run event 列表。
 * @param {string} label 断言标签。
 */
function assertAgentAttribution(events, label) {
  const agentStart = events.find((event) => event.type === "agent_start");
  assert.ok(agentStart, `${label}: 事件流必须包含 agent_start`);
  assert.equal(agentStart.payload.agentId, "supervisor", `${label}: agent_start.agentId 应为 supervisor`);
  const turnStart = events.find((event) => event.type === "turn_start");
  assert.ok(turnStart, `${label}: 事件流必须包含 turn_start`);
  assert.equal(typeof turnStart.payload.turnIndex, "number", `${label}: turn_start.turnIndex 必须是数字`);
  assert.equal(turnStart.payload.agentId, "supervisor", `${label}: turn_start.agentId 应为 supervisor`);
  // 执行地图按 (agentId, turnIndex) 键归属，anchor 必须单调递增（用于 ✂ / turn 分桶定位）。
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((left, right) => left - right),
    `${label}: 事件 sequence 必须单调递增`
  );
}

/**
 * 断言 context_event（compaction）的形状与位置。
 *
 * 口径（docs/v2.0/04 §3.2）：压缩真的发生才发射；位置在 user_message 之后、agent_start 之前；
 * payload 是 `ContextEventPayloadDto`（kind / tokensBefore / tokensAfter / detail?）。
 * 注意 serve 发射的是 run-v2 信封上的 `user_message`（不是 loop 的 `message_end`）——
 * 「消息之后」必须按信封类型断言，否则会拿一个更晚的序号去比，得到假的失败。
 *
 * @param {object[]} events canonical run event 列表。
 * @param {string} label 断言标签。
 * @returns {object} 该事件，供调用方继续断言。
 */
function assertContextEvent(events, label) {
  const contextEvents = events.filter((event) => event.type === "context_event");
  assert.equal(contextEvents.length, 1, `${label}: 压缩发生时应恰好发射一条 context_event`);
  const [contextEvent] = contextEvents;
  const payload = contextEvent.payload;
  assert.equal(payload.kind, "compaction", `${label}: v2.0 只有 compaction 一种 kind`);
  assert.equal(typeof payload.tokensBefore, "number", `${label}: tokensBefore 必须是数字`);
  assert.equal(typeof payload.tokensAfter, "number", `${label}: tokensAfter 必须是数字`);
  assert.ok(payload.tokensAfter < payload.tokensBefore, `${label}: 压缩后应少于压缩前`);
  const agentStartSeq = events.find((event) => event.type === "agent_start")?.sequence ?? Number.POSITIVE_INFINITY;
  const userMessageSeq = events.find((event) => event.type === "user_message")?.sequence ?? -1;
  assert.ok(userMessageSeq > 0, `${label}: 事件流必须包含 user_message（run-v2 信封）`);
  assert.ok(contextEvent.sequence > userMessageSeq, `${label}: context_event 应在首条消息之后`);
  assert.ok(contextEvent.sequence < agentStartSeq, `${label}: context_event 应在 agent_start 之前`);
  return contextEvent;
}

/**
 * 主流程：托管 run → 压缩路径 → 静态托管。
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
    assertAgentAttribution(managedEvents, "托管路径");
    pass("托管 run：agent_start / turn_start 带 agentId + turnIndex（执行地图归属依据）");
    pass(`托管 run：llm_call 完整（providerPayload + response.usage.cost + durationMs=${managedCall.payload.durationMs}）`);

    // ---- 路径 2：压缩路径（run 前会话级压缩 → context_event） ----
    //
    // 用同一个桩 streamFn、换一个只够装下很小窗口的模型：serve 的 run 前压缩按
    // contextWindow 判定，极小窗口 + 预置超长历史 → 压缩必然发生。这里验证的是「发射链路」，
    // 真实 provider 下的压缩质量另有 serve 单测覆盖（packages/serve/test/context-event.test.mjs）。
    const smallWindowRoot = path.join(root, "small-window");
    await fs.mkdir(smallWindowRoot, { recursive: true });
    const compactionServer = await createOhnaServer({
      workspaceRoot: smallWindowRoot,
      dataDir: path.join(root, "data-small"),
      model: { ...MODEL, id: "stub-small", name: "Stub Small", contextWindow: 512, maxTokens: 256 },
      apiKey: "test-key",
      systemPrompt: "verify system prompt",
      tools: [],
      staticDir: webDist,
      streamFn: createTraceableStream()
    });
    const compactionUrl = (await compactionServer.listen(0)).url;
    try {
      const conversation = await compactionServer.createConversation("verify-compaction");
      // 预置超长历史：HTTP 侧没有「写消息」路由，直接写线性消息存储（与 serve 单测同法）。
      // 与 server 共用同一个 dataDir 下的 conversations 目录，因此 store 实例不冲突。
      const messageStore = new LocalMessageStore(path.join(root, "data-small", "conversations"));
      const long = "这是一段用于撑爆上下文窗口的历史内容。".repeat(40);
      for (let index = 0; index < 6; index += 1) {
        await messageStore.append(conversation.conversationId, {
          role: index % 2 === 0 ? "user" : "assistant",
          // 线性格式的 assistant.content 是内容块数组，写成字符串会让 token 估算器拿不到块。
          content: index % 2 === 0 ? `${index} ${long}` : [{ type: "text", text: `${index} ${long}` }]
        });
      }
      const created = await compactionServer.createRun({
        conversationId: conversation.conversationId,
        message: "压缩路径验证",
        requestId: "verify-compaction"
      });
      await waitForTerminal(compactionUrl, created.accepted.runId);
      const events = await readRunEvents(compactionUrl, created.accepted.runId);
      const contextEvent = assertContextEvent(events, "压缩路径");
      pass(
        `压缩路径：context_event compaction ${contextEvent.payload.tokensBefore} → ${contextEvent.payload.tokensAfter} tokens（sequence ${contextEvent.sequence}，在 agent_start 之前）`
      );
    } finally {
      await compactionServer.shutdown().catch(() => undefined);
      await compactionServer.close().catch(() => undefined);
    }

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
