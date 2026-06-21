import { createLlmClientFromEnv } from "../packages/agent/src/llm-client.ts";

const result = await verifyLlmClient(getVerifyCase(process.argv), getProvider(process.argv));
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

/**
 * 从命令行参数中读取本次要验证的 LLM client 调用类型。
 *
 * @param argv 当前进程参数。
 * @returns 要验证的调用类型；缺失或非法时返回错误对象。
 */
function getVerifyCase(argv) {
  const caseIndex = argv.indexOf("--case");
  const verifyCase = caseIndex >= 0 ? argv[caseIndex + 1] : undefined;
  const allowedCases = new Set(["chat", "stream", "json", "tool"]);

  if (!verifyCase || !allowedCases.has(verifyCase)) {
    return { ok: false, step: "parse_case", error: { message: "Set --case to chat, stream, json, or tool." } };
  }

  return { ok: true, data: verifyCase };
}

/**
 * 从命令行参数中读取模型 profile，便于同一脚本调试多个模型供应商。
 *
 * @param argv 当前进程参数。
 * @returns 模型 profile；未指定时使用 .env 中的默认配置。
 */
function getProvider(argv) {
  const providerIndex = argv.indexOf("--provider");
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : undefined;

  if (!provider) {
    return { ok: true, data: undefined };
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(provider)) {
    return {
      ok: false,
      step: "parse_provider",
      error: { message: "Set --provider to a profile name like deepseek, kimi, or openai." }
    };
  }

  return { ok: true, data: provider };
}

/**
 * 调用真实 provider 验证指定的 LLM client 行为。
 *
 * @param caseResult 本次要验证的调用类型解析结果。
 * @param providerResult 本次要使用的模型 profile 解析结果。
 * @returns 汇总后的验证结果。
 */
async function verifyLlmClient(caseResult, providerResult) {
  if (!caseResult.ok) {
    return caseResult;
  }

  if (!providerResult.ok) {
    return providerResult;
  }

  const clientResult = createLlmClientFromEnv({
    ...process.env,
    ...(providerResult.data ? { AIAGENT_LLM_PROVIDER: providerResult.data } : {})
  });
  if (!clientResult.ok) {
    return { ok: false, step: "create_client", error: clientResult.error };
  }

  const client = clientResult.data;
  const verifyCase = caseResult.data;
  const resultByCase = {
    chat: verifyChat,
    stream: verifyStream,
    json: verifyJson,
    tool: verifyTool
  };

  const result = await resultByCase[verifyCase](client);

  return {
    ok: result.ok,
    mode: "real",
    case: verifyCase,
    provider: providerResult.data ?? process.env.AIAGENT_LLM_PROVIDER ?? process.env.MODEL_PROVIDER ?? "default",
    [verifyCase]: result
  };
}

/**
 * 验证普通 chat 调用。
 *
 * @param client 已创建的真实 LLM client。
 * @returns chat 调用结果。
 */
async function verifyChat(client) {
  return client.chat({
    messages: [{ role: "user", content: "解释一下 ROE 是什么？" }]
  });
}

/**
 * 验证流式 chat 调用，并收集完整事件序列。
 *
 * @param client 已创建的真实 LLM client。
 * @returns stream 调用结果和汇总文本。
 */
async function verifyStream(client) {
  const streamResult = await client.streamChat({
    messages: [{ role: "user", content: "用一句话解释 ROE。" }]
  });

  return collectStreamResult(streamResult);
}

/**
 * 验证 JSON chat 调用。
 *
 * @param client 已创建的真实 LLM client。
 * @returns JSON chat 调用结果。
 */
async function verifyJson(client) {
  return client.jsonChat({
    schemaName: "metric query",
    messages: [{ role: "user", content: "返回一个包含 ticker、metric、period 的 JSON。" }]
  });
}

/**
 * 验证 tool chat 调用。
 *
 * @param client 已创建的真实 LLM client。
 * @returns tool chat 调用结果。
 */
async function verifyTool(client) {
  return client.toolChat({
    messages: [{ role: "user", content: "查询 000001.SZ 最近一期净利润。" }],
    tools: [
      {
        name: "financial_metric_lookup",
        description: "查询公司财务指标。",
        parameters: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            metric: { type: "string" },
            period: { type: "string" }
          },
          required: ["ticker", "metric"]
        }
      }
    ],
    toolChoice: "auto"
  });
}

/**
 * 收集 streamChat() 返回的异步事件，便于真实 provider 调试时检查流式输出形状。
 *
 * @param streamResult streamChat() 的结构化返回结果。
 * @returns 成功时返回事件列表和拼接后的文本，失败时透传结构化错误。
 */
async function collectStreamResult(streamResult) {
  if (!streamResult.ok) {
    return streamResult;
  }

  const events = [];
  let content = "";

  for await (const event of streamResult.data) {
    events.push(event);

    if (event.type === "content_delta") {
      content += event.delta;
    }
  }

  return {
    ok: true,
    data: {
      content,
      events
    }
  };
}
