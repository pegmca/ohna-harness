import { streamSimple } from "../packages/ai/dist/index.js";

const result = await verifyLlm(getVerifyCase(process.argv), getProvider(process.argv));
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

/**
 * 从命令行参数中读取本次要验证的调用类型。
 *
 * @param argv 当前进程参数。
 * @returns 要验证的调用类型；缺失或非法时返回错误对象。
 */
function getVerifyCase(argv) {
  const caseIndex = argv.indexOf("--case");
  const verifyCase = caseIndex >= 0 ? argv[caseIndex + 1] : undefined;
  const allowedCases = new Set(["chat", "tool"]);

  if (!verifyCase || !allowedCases.has(verifyCase)) {
    return { ok: false, step: "parse_case", error: { message: "Set --case to chat or tool." } };
  }

  return { ok: true, data: verifyCase };
}

/**
 * 从命令行参数中读取模型 profile，便于同一脚本调试多个模型供应商。
 *
 * @param argv 当前进程参数。
 * @returns 模型 profile；缺省为 default（读 AIAGENT_LLM_API_KEY 等通用变量）。
 */
function getProvider(argv) {
  const providerIndex = argv.indexOf("--provider");
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : "default";

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(provider)) {
    return { ok: false, step: "parse_provider", error: { message: "Set --provider to a profile name like deepseek or openrouter." } };
  }

  return { ok: true, data: provider };
}

/**
 * 调用真实 provider 验证 packages/ai 的 streamSimple 链路。
 *
 * @param caseResult 本次要验证的调用类型解析结果。
 * @param providerResult 本次要使用的模型 profile 解析结果。
 * @returns 汇总后的验证结果。
 */
async function verifyLlm(caseResult, providerResult) {
  if (!caseResult.ok) return caseResult;
  if (!providerResult.ok) return providerResult;

  const profile = providerResult.data;
  const suffix = profile.toUpperCase();
  const apiKey = process.env[`AIAGENT_LLM_API_KEY_${suffix}`] ?? process.env.AIAGENT_LLM_API_KEY;
  if (!apiKey) {
    return { ok: false, step: "create_model", error: { message: `Missing API key (AIAGENT_LLM_API_KEY_${suffix}).` } };
  }
  const modelName = process.env[`AIAGENT_LLM_MODEL_${suffix}`] ?? process.env.AIAGENT_LLM_MODEL;
  if (!modelName) {
    return { ok: false, step: "create_model", error: { message: `Missing model (AIAGENT_LLM_MODEL_${suffix}).` } };
  }
  const model = {
    id: modelName,
    name: modelName,
    api: "openai-completions",
    provider: profile,
    baseUrl: process.env[`AIAGENT_LLM_BASE_URL_${suffix}`] ?? process.env.AIAGENT_LLM_BASE_URL ?? "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  };

  const context = caseResult.data === "tool"
    ? {
        systemPrompt: "你是金融研究 Agent。",
        messages: [{ role: "user", content: "查询 000001.SZ 最近一期净利润。", timestamp: Date.now() }],
        tools: [{
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
        }]
      }
    : {
        systemPrompt: "你是金融研究 Agent。",
        messages: [{ role: "user", content: "用一句话解释 ROE。", timestamp: Date.now() }]
      };

  const stream = streamSimple(model, context, { apiKey });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const message = await stream.result();

  return {
    ok: message.stopReason !== "error",
    mode: "real",
    case: caseResult.data,
    provider: profile,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    events,
    content: message.content
  };
}
