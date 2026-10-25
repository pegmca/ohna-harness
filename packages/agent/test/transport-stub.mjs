/**
 * `[L2b-kernel]` 共享的「真 provider 链路 + 传输层桩」测试件（docs/v2.0/04 §8）。
 *
 * 为什么需要：`onSubagentEvent` 的端到端验证必须让**真实** `agentLoop` 发事件，
 * 而在无 LLM 凭据的环境里只能用桩。本模块与 `team-l2b-kernel.test.mjs` 同一口径：
 * 桩只替换 HTTP `fetch`（回放服务端 SSE 字节），**不注入任何 AssistantMessage**
 * ——「模型说了什么」仍由 `openai-completions` adapter 从字节流解析得出，
 * 因此不属于 03 §4.2 红线禁止的「mock 模型输出」。
 *
 * 文件名不带 `.test.` 后缀：node --test 只跑 `*.test.mjs`，本文件不单独成用例。
 */
import { streamSimple } from "@aiagent/ai";

/**
 * 构造一个指向假 baseUrl 的 Model（元数据与 @aiagent/ai 的 Model 对齐）。
 *
 * @param id 模型 id。
 * @param patch 覆盖字段（费率等）。
 * @returns Model 对象。
 */
export function makeModel(id = "kernel-model", patch = {}) {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...patch,
  };
}

/**
 * 把 SSE chunk 列表编码成 fetch Response（服务端字节流形状）。
 *
 * @param chunks OpenAI chat.completion.chunk 对象数组。
 * @returns HTTP Response。
 */
export function sseResponse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * 构造「服务端返回纯文本回复」的 SSE chunk 序列。
 *
 * @param text 服务端回包文本。
 * @param usage 服务端上报的用量（可选）。
 * @param modelId 回包中的 model 字段。
 * @returns chunk 数组。
 */
export function textChunks(text, usage, modelId = "kernel-model") {
  const chunks = [
    { id: "c-1", model: modelId, choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "c-1", model: modelId, choices: [{ delta: { content: text }, finish_reason: null }] },
    { id: "c-1", model: modelId, choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  if (usage) chunks.at(-1).usage = usage;
  return chunks;
}

/**
 * 构造「真 provider 链路 + 传输层桩」的 streamFn：内部就是 `streamSimple`
 * （与 controller 缺省路径同一函数），只把 `fetch` 换成本地桩。
 *
 * @param handler `(url, init) => Response` 的服务端处理器（记录请求并回放字节流）。
 * @returns StreamFn。
 */
export function createTransportStubbedStreamFn(handler) {
  return (model, context, options) =>
    streamSimple(model, context, { ...options, apiKey: "test-key", fetch: handler });
}
