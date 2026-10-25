/**
 * W2（docs/v2.0/04 §2.2）· serve 托管 run 的 Team 接线测试的**共享夹具**。
 *
 * 为什么抽成独立模块：Team 接线的验收面有两个内聚域（事件归属 / 权限与并发），分别由
 * `team-wiring-events.test.mjs` 与 `team-wiring-guards.test.mjs` 承载——原单文件 663 行会
 * 违反 AGENTS.md「单文件约 500 行」约束。本模块只放**不产生断言**的构造器（服务、脚本化
 * streamFn、SSE 解析），断言全部留在两个用例文件里。
 *
 * 关于 streamFn：本夹具用的是 **adapter 位置桩**（直接构造
 * `createAssistantMessageEventStream` 并 push start/text_delta/toolcall_end/done），
 * **不经过 provider adapter、不联网**。它与 `llm-window.test.mjs` 的 transport-stub
 * 手法不同：transport-stub 走真实 provider 链路、只替换 fetch，因此能验证 `observer` 是否
 * 穿过 `buildBaseOptions` 存活（那条用例在 `team-wiring-guards.test.mjs` 里）。
 * 工具调用轮由「最后一条消息是否为 toolResult」驱动（stub-stream 的既有约定）。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createCodingToolRegistry } from "@aiagent/coding";
import { SUPERVISOR_AGENT_ID } from "@aiagent/agent";
import { createAssistantMessageEventStream } from "@aiagent/ai";
import { createOhnaServer } from "../dist/index.js";
import { createServeTeamSession } from "../dist/run/team-session.js";
import { createTransportStubbedStreamFn, sseResponse, textChunks } from "../../agent/test/transport-stub.mjs";

export const MODEL = {
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

/**
 * 构造一条 assistant 消息。
 *
 * @param {object[]} content 内容块。
 * @param {string} stopReason 停止原因。
 * @returns {object} AssistantMessage。
 */
export function assistantMessage(content, stopReason) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: MODEL.id,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  };
}

/**
 * 把一条消息推成完整的流式事件序列。
 *
 * @param {object} stream AssistantMessageEventStream。
 * @param {object} message AssistantMessage。
 */
export function pushMessage(stream, message) {
  stream.push({ type: "start", partial: { ...message, content: [] } });
  message.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    } else {
      stream.push({ type: "toolcall_start", contentIndex, partial: message });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
    }
  });
  stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
}

/**
 * 从上下文里取最后一条 user 文本。
 *
 * @param {object[]} messages LLM 上下文消息。
 * @returns {string} 文本。
 */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
    }
  }
  return "";
}

/**
 * 从上下文里取最后一条 toolResult 文本。
 *
 * @param {object[]} messages LLM 上下文消息。
 * @returns {string|undefined} 文本；没有 toolResult 时为 undefined。
 */
function lastToolResultText(messages) {
  const last = messages[messages.length - 1];
  if (last?.role !== "toolResult") return undefined;
  return Array.isArray(last.content)
    ? last.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
    : String(last.content ?? "");
}

/**
 * 脚本化 streamFn：按「当前对话阶段」决定这一轮说什么。
 *
 * 阶段划分（全局计数，supervisor 与子代理混跑）：
 * 1. 首次调用 → TeamCreate(member="analyst")
 * 2. TeamCreate 结果回喂 → SendMessage(recipient="analyst", content="...")
 * 3. SendMessage 结果回喂 → 纯文本收尾
 * 4. 其余（子代理自己的轮次）→ 纯文本收尾，形成 agent_start/turn_* /agent_end 边界事件
 *
 * @param {{calls: object[]}} log 调用记录（断言用）。
 * @returns {Function} StreamFn。
 */
export function createTeamScriptStream(log) {
  return (_model, context, options) => {
    const messages = context.messages ?? [];
    log.calls.push({
      systemPrompt: context.systemPrompt,
      toolNames: (context.tools ?? []).map((tool) => tool.name),
      hasSendMessageResult: lastToolResultText(messages)?.includes("子代理") ?? false
    });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      await options?.onPayload?.({ model: MODEL.id, stream: true }, MODEL);
      const toolResult = lastToolResultText(messages);
      if (toolResult === undefined) {
        // 第一层：还没有任何工具结果 → 若工具表里有 TeamCreate，先建成员。
        const toolNames = (context.tools ?? []).map((tool) => tool.name);
        if (toolNames.includes("TeamCreate")) {
          pushMessage(
            stream,
            assistantMessage(
              [
                {
                  type: "toolCall",
                  id: "call_create",
                  name: "TeamCreate",
                  arguments: { name: "analyst", role: "分析师", tools: [] }
                }
              ],
              "toolUse"
            )
          );
          return;
        }
      } else if (toolResult.includes("已创建成员")) {
        pushMessage(
          stream,
          assistantMessage(
            [
              {
                type: "toolCall",
                id: "call_send",
                name: "SendMessage",
                arguments: { recipient: "analyst", content: "请分析一下这个任务" }
              }
            ],
            "toolUse"
          )
        );
        return;
      }
      pushMessage(stream, assistantMessage([{ type: "text", text: "任务完成。" }], "stop"));
    });
    return stream;
  };
}

/**
 * 简单文本流（team 关闭对照组用）：直接收尾，不触发任何工具。
 *
 * @returns {Function} StreamFn。
 */
export function createPlainTextStream() {
  return () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => pushMessage(stream, assistantMessage([{ type: "text", text: "好的。" }], "stop")));
    return stream;
  };
}

/**
 * 创建隔离的测试服务。
 *
 * @param {object} [options] 测试选项。
 * @returns {Promise<object>} 测试上下文。
 */
export async function createTestServer(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-serve-team-"));
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: "test system prompt",
    tools: [],
    staticDir: path.join(root, "web-dist"),
    autoApprove: true,
    streamFn: options.streamFn,
    ...(options.team ? { team: true } : {})
  });
  return { server, root };
}

/**
 * 清理服务与临时目录。
 *
 * @param {object} context 测试上下文。
 */
export async function dispose(context) {
  await context.server.shutdown();
  await context.server.close();
  await fs.rm(context.root, { recursive: true, force: true });
}

/**
 * 解析 SSE 响应体中的 run_event 帧。
 *
 * @param {string} body SSE 文本。
 * @returns {object[]} 事件数组（按出现顺序）。
 */
export function parseSseEvents(body) {
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
 * @param {object} server 服务。
 * @param {string} snapshotUrl 快照地址。
 * @returns {Promise<object>} 终态快照。
 */
export async function waitForTerminal(server, snapshotUrl) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = (await server.app.inject({ method: "GET", url: snapshotUrl })).json().data;
    if (["completed", "failed", "cancelled", "interrupted"].includes(snapshot?.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Run did not reach terminal state.");
}
