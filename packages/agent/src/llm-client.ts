import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmClientConfig,
  LlmJsonChatRequest,
  LlmJsonChatResponse,
  LlmMessage,
  LlmResult,
  LlmRole,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolChatRequest,
  LlmToolChatResponse
} from "@aiagent/types";
import type { TraceRecorder } from "@aiagent/trace";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface OpenAiCompatibleChatMessage {
  role: LlmRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
}

interface OpenAiCompatibleToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAiCompatibleChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAiCompatibleToolCall[];
  };
  delta?: {
    content?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
  };
  finish_reason?: string | null;
}

interface OpenAiCompatibleChatResponse {
  model?: string;
  choices?: OpenAiCompatibleChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface TraceableLlmClientConfig extends LlmClientConfig {
  traceRecorder?: TraceRecorder;
}

interface NormalizedLlmClientConfig extends TraceableLlmClientConfig {
  timeoutMs: number;
  fetch: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const KIMI_CODE_OPENAI_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_CODE_MODEL = "kimi-for-coding";
const DEFAULT_PROFILE = "default";
let projectEnvLoaded = false;

/**
 * 使用显式配置创建统一 LLM client，并把供应商配置固定在 client 闭包中。
 *
 * @param config 调用 OpenAI compatible provider 所需的配置。
 * @returns 隐藏供应商 HTTP 细节的 LLM client。
 */
export function createLlmClient(config: TraceableLlmClientConfig): LlmClient {
  const normalized = normalizeConfig(config);

  return {
    chat(request) {
      return chat(normalized, request);
    },
    streamChat(request) {
      return streamChat(normalized, request);
    },
    jsonChat<TJson = unknown>(request: LlmJsonChatRequest) {
      return jsonChat<TJson>(normalized, request);
    },
    toolChat(request) {
      return toolChat(normalized, request);
    }
  };
}

/**
 * 从环境变量创建 LLM client，用结构化错误表达缺失或非法配置。
 *
 * @param env 可注入的环境变量集合，默认读取当前进程环境。
 * @returns 成功时返回 LLM client，失败时返回配置错误。
 */
export function createLlmClientFromEnv(env: Record<string, string | undefined> = getDefaultEnv()): LlmResult<LlmClient> {
  loadProjectEnv();
  const mergedEnv = mergeProcessEnv(env);
  const profile = resolveProfile(mergedEnv);
  const rawConfig = resolveProfileConfig(mergedEnv, profile);
  const timeoutResult = parseTimeoutMs(mergedEnv.AIAGENT_LLM_TIMEOUT_MS);

  if (!timeoutResult.ok) {
    return timeoutResult;
  }

  if (!rawConfig.apiKey) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: `Missing LLM API key for ${profile}.`,
        details: { profile, supportedEnv: rawConfig.supportedApiKeyEnv }
      }
    };
  }

  if (!rawConfig.model) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: `Missing LLM model for ${profile}.`,
        details: { profile, supportedEnv: rawConfig.supportedModelEnv }
      }
    };
  }

  return {
    ok: true,
    data: createLlmClient({
      apiKey: rawConfig.apiKey,
      baseUrl: rawConfig.baseUrl,
      model: rawConfig.model,
      timeoutMs: timeoutResult.data
    })
  };
}

/**
 * 合并已加载的进程环境和调用方显式传入的环境，让脚本临时覆盖不会丢失 .env 配置。
 *
 * @param env 调用方显式传入的环境变量集合。
 * @returns 合并后的环境变量集合，显式传入值优先。
 */
function mergeProcessEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (typeof process === "undefined") {
    return env;
  }

  return {
    ...process.env,
    ...env
  };
}

interface ResolvedEnvConfig {
  apiKey?: string;
  baseUrl: string;
  model?: string;
  supportedApiKeyEnv: string[];
  supportedModelEnv: string[];
}

/**
 * 解析当前要使用的模型 profile，让同一份 .env 可以同时保存多组模型配置。
 *
 * @param env 可注入的环境变量集合。
 * @returns 当前模型 profile，默认使用 default profile。
 */
function resolveProfile(env: Record<string, string | undefined>): string {
  const profile = env.AIAGENT_LLM_PROVIDER ?? env.MODEL_PROVIDER;

  if (!profile || profile === "openai-compatible") {
    return DEFAULT_PROFILE;
  }

  if (profile === "kimi-code") {
    return "kimi";
  }

  return profile;
}

/**
 * 按 profile 解析 OpenAI compatible 配置，优先读取 AIAGENT_LLM_*_<PROFILE> 命名。
 *
 * @param env 可注入的环境变量集合。
 * @param profile 当前模型 profile。
 * @returns 归一化前的 provider 配置。
 */
function resolveProfileConfig(env: Record<string, string | undefined>, profile: string): ResolvedEnvConfig {
  const suffix = toEnvSuffix(profile);
  const profileApiKeyEnv = `AIAGENT_LLM_API_KEY_${suffix}`;
  const profileBaseUrlEnv = `AIAGENT_LLM_BASE_URL_${suffix}`;
  const profileModelEnv = `AIAGENT_LLM_MODEL_${suffix}`;

  if (profile === "kimi") {
    return resolveKimiProfileConfig(env, profileApiKeyEnv, profileBaseUrlEnv, profileModelEnv);
  }

  return {
    apiKey: env[profileApiKeyEnv] ?? env.AIAGENT_LLM_API_KEY ?? env.OPENAI_API_KEY ?? env.MODEL_API_KEY,
    baseUrl:
      env[profileBaseUrlEnv] ??
      env.AIAGENT_LLM_BASE_URL ??
      env.OPENAI_BASE_URL ??
      env.MODEL_BASE_URL ??
      DEFAULT_BASE_URL,
    model: env[profileModelEnv] ?? env.AIAGENT_LLM_MODEL ?? env.OPENAI_MODEL ?? env.MODEL_NAME,
    supportedApiKeyEnv: [profileApiKeyEnv, "AIAGENT_LLM_API_KEY", "OPENAI_API_KEY", "MODEL_API_KEY"],
    supportedModelEnv: [profileModelEnv, "AIAGENT_LLM_MODEL", "OPENAI_MODEL", "MODEL_NAME"]
  };
}

/**
 * 解析 Kimi profile 配置，并兼容 Claude Code 常用的 Anthropic 环境变量。
 *
 * @param env 可注入的环境变量集合。
 * @param profileApiKeyEnv Kimi profile 的标准 API key 变量名。
 * @param profileBaseUrlEnv Kimi profile 的标准 base URL 变量名。
 * @param profileModelEnv Kimi profile 的标准 model 变量名。
 * @returns 归一化前的 Kimi profile 配置。
 */
function resolveKimiProfileConfig(
  env: Record<string, string | undefined>,
  profileApiKeyEnv: string,
  profileBaseUrlEnv: string,
  profileModelEnv: string
): ResolvedEnvConfig {
  return {
    apiKey: env[profileApiKeyEnv] ?? env.MODEL_API_KEY_KIMI ?? env.KIMI_API_KEY ?? env.ANTHROPIC_API_KEY,
    baseUrl:
      env[profileBaseUrlEnv] ??
      env.MODEL_BASE_URL_KIMI ??
      env.KIMI_BASE_URL ??
      mapKimiAnthropicBaseUrl(env.ANTHROPIC_BASE_URL) ??
      KIMI_CODE_OPENAI_BASE_URL,
    model: env[profileModelEnv] ?? env.MODEL_NAME_KIMI ?? env.KIMI_MODEL ?? env.ANTHROPIC_MODEL ?? KIMI_CODE_MODEL,
    supportedApiKeyEnv: [profileApiKeyEnv, "MODEL_API_KEY_KIMI", "KIMI_API_KEY", "ANTHROPIC_API_KEY"],
    supportedModelEnv: [profileModelEnv, "MODEL_NAME_KIMI", "KIMI_MODEL", "ANTHROPIC_MODEL"]
  };
}

/**
 * 将 profile 名称转换为环境变量后缀，例如 deepseek-v3 会变成 DEEPSEEK_V3。
 *
 * @param profile 模型 profile 名称。
 * @returns 可拼接到 AIAGENT_LLM_*_ 后面的环境变量后缀。
 */
function toEnvSuffix(profile: string): string {
  return profile
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/**
 * 将 Kimi Code 的 Anthropic-compatible base URL 转为同服务的 OpenAI-compatible base URL。
 *
 * @param baseUrl Anthropic-compatible base URL，例如 https://api.kimi.com/coding/。
 * @returns OpenAI-compatible base URL；无法识别时返回 undefined。
 */
function mapKimiAnthropicBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized === "https://api.kimi.com/coding") {
    return KIMI_CODE_OPENAI_BASE_URL;
  }

  return undefined;
}

/**
 * 解析可选超时配置，避免非法数字进入请求控制流。
 *
 * @param timeoutValue 环境变量中的超时文本。
 * @returns 成功时返回 timeoutMs，失败时返回配置错误。
 */
function parseTimeoutMs(timeoutValue: string | undefined): LlmResult<number | undefined> {
  const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return {
      ok: false,
      error: {
        code: "configuration_error",
        message: "AIAGENT_LLM_TIMEOUT_MS must be a positive number.",
        details: { timeoutValue }
      }
    };
  }

  return { ok: true, data: timeoutMs };
}

/**
 * 归一化 client 配置，让后续请求构造逻辑只处理完整配置。
 *
 * @param config 调用方传入的原始 client 配置。
 * @returns 带默认超时、默认 fetch 和无尾斜杠 baseUrl 的完整配置。
 */
function normalizeConfig(config: TraceableLlmClientConfig): NormalizedLlmClientConfig {
  return {
    apiKey: config.apiKey,
    // 只在入口归一化一次，后续拼接供应商路径时不会出现重复斜杠。
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    traceRecorder: config.traceRecorder,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetch: config.fetch ?? fetch
  };
}

/**
 * 读取默认运行环境，兼容浏览器等没有 process 的执行上下文。
 *
 * @returns 当前进程环境变量；不可用时返回空对象。
 */
function getDefaultEnv(): Record<string, string | undefined> {
  loadProjectEnv();
  return typeof process === "undefined" ? {} : process.env;
}

/**
 * 自动加载当前项目的 .env，让本地 Node 进程无需在每个入口重复显式注入环境变量。
 *
 * @returns 无返回值。
 */
function loadProjectEnv(): void {
  if (projectEnvLoaded || typeof process === "undefined") {
    return;
  }

  projectEnvLoaded = true;

  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  const envFile = findUpFile(".env", process.cwd());
  if (envFile) {
    process.loadEnvFile(envFile);
  }
}

/**
 * 从起始目录向上查找指定文件，用于兼容 pnpm filter 改变 package 工作目录的场景。
 *
 * @param fileName 要查找的文件名。
 * @param startDir 起始目录。
 * @returns 找到时返回绝对路径；未找到时返回 undefined。
 */
function findUpFile(fileName: string, startDir: string): string | undefined {
  let current = startDir;

  while (true) {
    const candidate = resolve(current, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

/**
 * 普通 chat 只负责完成一次供应商调用，并把响应归一化为稳定的 LLM contract。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的普通 chat 请求。
 * @returns 成功时返回归一化 chat 响应，失败时返回结构化错误。
 */
async function chat(config: NormalizedLlmClientConfig, request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>> {
  return traceModelCall(config, "chat", () => chatCore(config, request));
}

/**
 * 执行普通 chat 的核心逻辑，供 jsonChat 复用而不重复写入 trace。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的普通 chat 请求。
 * @returns 成功时返回归一化 chat 响应，失败时返回结构化错误。
 */
async function chatCore(config: NormalizedLlmClientConfig, request: LlmChatRequest): Promise<LlmResult<LlmChatResponse>> {
  const response = await requestChatCompletion(config, request);
  if (!response.ok) {
    return response;
  }

  return parseChatResponse(response.data, config.model);
}

/**
 * 流式 chat 复用同一套请求配置，只把 provider 的 SSE body 转换成内部流事件。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的流式 chat 请求。
 * @returns 成功时返回内部流事件迭代器，失败时返回结构化错误。
 */
async function streamChat(
  config: NormalizedLlmClientConfig,
  request: LlmChatRequest
): Promise<LlmResult<AsyncIterable<LlmStreamEvent>>> {
  return traceModelCall(config, "stream_chat", () => streamChatCore(config, request));
}

/**
 * 执行流式 chat 的核心逻辑，trace wrapper 只记录建立请求阶段的结构化结果。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的流式 chat 请求。
 * @returns 成功时返回内部流事件迭代器，失败时返回结构化错误。
 */
async function streamChatCore(
  config: NormalizedLlmClientConfig,
  request: LlmChatRequest
): Promise<LlmResult<AsyncIterable<LlmStreamEvent>>> {
  const response = await requestChatCompletion(config, request, { stream: true });
  if (!response.ok) {
    return response;
  }

  if (!response.data.body) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Provider did not return a readable stream."
      }
    };
  }

  return {
    ok: true,
    data: parseSseStream(response.data.body)
  };
}

/**
 * JSON chat 在普通 chat 之上增加解析层，解析失败也保持 LlmResult 结构化返回。
 *
 * @template TJson 期望从模型输出中解析出的 JSON 数据类型。
 * @param config 已归一化的 LLM client 配置。
 * @param request 带可选 schema 名称的 JSON chat 请求。
 * @returns 成功时返回原始 chat 响应和解析后的 JSON，失败时返回结构化错误。
 */
async function jsonChat<TJson = unknown>(
  config: NormalizedLlmClientConfig,
  request: LlmJsonChatRequest
): Promise<LlmResult<LlmJsonChatResponse<TJson>>> {
  return traceModelCall(config, "json_chat", async () => {
    const chatResult = await chatCore(config, request);
    if (!chatResult.ok) {
      return chatResult;
    }

    const parseResult = parseJsonObject<TJson>(chatResult.data.content);
    if (!parseResult.ok) {
      return {
        ok: false,
        error: {
          code: "json_parse_error",
          message: `Failed to parse ${request.schemaName ?? "model"} JSON output.`,
          details: {
            // 预览内容限制长度，便于 trace 排障，同时避免保存完整模型输出。
            reason: parseResult.error,
            contentPreview: chatResult.data.content.slice(0, 500)
          }
        }
      };
    }

    return {
      ok: true,
      data: {
        ...chatResult.data,
        json: parseResult.data
      }
    };
  });
}

/**
 * Tool chat 将内部工具定义映射为 OpenAI compatible function tool，并归一化模型返回的 tool call。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 包含工具定义和 tool choice 的 chat 请求。
 * @returns 成功时返回模型选择的工具调用，失败时返回结构化错误。
 */
async function toolChat(
  config: NormalizedLlmClientConfig,
  request: LlmToolChatRequest
): Promise<LlmResult<LlmToolChatResponse>> {
  return traceModelCall(config, "tool_chat", () => toolChatCore(config, request));
}

/**
 * 执行 tool chat 的核心逻辑，解析失败保持结构化错误并交给 wrapper 写 trace。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 包含工具定义和 tool choice 的 chat 请求。
 * @returns 成功时返回模型选择的工具调用，失败时返回结构化错误。
 */
async function toolChatCore(
  config: NormalizedLlmClientConfig,
  request: LlmToolChatRequest
): Promise<LlmResult<LlmToolChatResponse>> {
  const response = await requestChatCompletion(config, request, {
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    })),
    tool_choice: mapToolChoice(request.toolChoice)
  });

  if (!response.ok) {
    return response;
  }

  const chatResult = await parseChatResponse(response.data, config.model);
  if (!chatResult.ok) {
    return chatResult;
  }

  const [toolCall] = chatResult.data.toolCalls ?? [];
  if (!toolCall) {
    return {
      ok: false,
      error: {
        code: "tool_parse_error",
        message: "Model response did not include a tool call.",
        details: {
          contentPreview: chatResult.data.content.slice(0, 500)
        }
      }
    };
  }

  return {
    ok: true,
    data: {
      ...chatResult.data,
      toolCall
    }
  };
}

/**
 * 包装 LLM client 的公开调用，记录模型调用耗时、用量和结构化错误。
 *
 * @template TResult LLM 调用成功时的数据类型。
 * @param config 已归一化的 LLM client 配置。
 * @param purpose 调用目的，供 trace timeline 区分 chat/json/tool/stream。
 * @param action 实际模型调用逻辑。
 * @returns 原始 LLM 调用结果。
 */
async function traceModelCall<TResult>(
  config: NormalizedLlmClientConfig,
  purpose: string,
  action: () => Promise<LlmResult<TResult>>
): Promise<LlmResult<TResult>> {
  const startedAt = performance.now();
  const result = await action();
  const traceRecorder = config.traceRecorder;

  if (!traceRecorder) {
    return result;
  }

  try {
    traceRecorder.record({
      type: "model_call",
      id: createTraceEventId(traceRecorder.traceId, `llm_${purpose}`),
      traceId: traceRecorder.traceId,
      requestId: traceRecorder.requestId,
      model: getTraceModel(result, config.model),
      purpose,
      durationMs: elapsedMs(startedAt),
      ok: result.ok,
      usage: result.ok ? getTraceUsage(result.data) : undefined,
      error: result.ok ? undefined : result.error,
      createdAt: new Date().toISOString()
    });
  } catch {
    // trace 是旁路观测能力，不能改变 LLM client 的主结果。
  }

  return result;
}

/**
 * 从 LLM 结果中提取模型名，失败时回退到配置模型，避免记录 unknown 影响排障。
 *
 * @param result LLM 调用结果。
 * @param fallbackModel 配置中的模型名。
 * @returns trace 中展示的模型名。
 */
function getTraceModel<TResult>(result: LlmResult<TResult>, fallbackModel: string): string {
  if (result.ok && isRecord(result.data) && typeof result.data.model === "string") {
    return result.data.model;
  }

  return fallbackModel;
}

/**
 * 从成功结果中提取 token usage，stream 建连等无 usage 的路径返回 undefined。
 *
 * @param data LLM 成功结果。
 * @returns token usage 或 undefined。
 */
function getTraceUsage(data: unknown): LlmChatResponse["usage"] {
  if (isRecord(data) && isRecord(data.usage)) {
    return data.usage as LlmChatResponse["usage"];
  }

  return undefined;
}

/**
 * 构造并发送 OpenAI compatible chat completions 请求，统一处理 HTTP 错误、网络错误和超时。
 *
 * @param config 已归一化的 LLM client 配置。
 * @param request 调用方传入的 chat 请求。
 * @param extraBody 仅特定调用模式需要追加的 provider body 字段。
 * @returns 成功时返回原始 Response，失败时返回结构化错误。
 */
async function requestChatCompletion(
  config: NormalizedLlmClientConfig,
  request: LlmChatRequest,
  extraBody: Record<string, unknown> = {}
): Promise<LlmResult<Response>> {
  const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // 普通请求和流式请求共用 AbortController 作为唯一超时机制。
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await config.fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildRequestHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages: request.messages.map(mapMessage),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        ...extraBody
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        ok: false,
        error: await parseProviderError(response)
      };
    }

    return { ok: true, data: response };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        error: {
          code: "request_timeout",
          message: `LLM request timed out after ${timeoutMs}ms.`,
          details: { timeoutMs }
        }
      };
    }

    return {
      ok: false,
      error: {
        code: "network_error",
        message: "LLM request failed before receiving a provider response.",
        // 未知异常在跨出 agent 边界前统一转换为结构化数据。
        details: { reason: getErrorMessage(error) }
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 构造 provider 请求头，并在配置存在时带上 Claude Code 兼容的会话归因字段。
 *
 * @param config 已归一化的 LLM client 配置。
 * @returns 发送给 OpenAI compatible provider 的 HTTP headers。
 */
function buildRequestHeaders(config: NormalizedLlmClientConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json"
  };
}

/**
 * 解析 provider 的非流式 chat 响应，并转换为内部 LLM 响应结构。
 *
 * @param response provider 返回的原始 HTTP 响应。
 * @param fallbackModel provider 未返回 model 时使用的配置模型名。
 * @returns 成功时返回归一化响应，失败时返回结构化解析错误。
 */
async function parseChatResponse(response: Response, fallbackModel: string): Promise<LlmResult<LlmChatResponse>> {
  const jsonResult = await parseResponseJson<OpenAiCompatibleChatResponse>(response);
  if (!jsonResult.ok) {
    return jsonResult;
  }

  const payload = jsonResult.data;
  const [choice] = payload.choices ?? [];
  if (!choice?.message) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Provider response did not include a chat message.",
        details: { payload }
      }
    };
  }

  // 在这里解析 tool calls，让 chat() 和 toolChat() 共享同一套供应商归一化逻辑。
  const toolCallsResult = parseToolCalls(choice.message.tool_calls ?? []);
  if (!toolCallsResult.ok) {
    return toolCallsResult;
  }

  return {
    ok: true,
    data: {
      content: choice.message.content ?? "",
      model: payload.model ?? fallbackModel,
      finishReason: choice.finish_reason ?? undefined,
      usage: payload.usage
        ? {
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens
          }
        : undefined,
      toolCalls: toolCallsResult.data.length > 0 ? toolCallsResult.data : undefined
    }
  };
}

/**
 * 解析 provider 的 HTTP 错误响应，尽量保留可观测诊断字段。
 *
 * @param response provider 返回的非 2xx HTTP 响应。
 * @returns provider_error 结构化错误。
 */
async function parseProviderError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => undefined);
    const providerError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    return {
      code: "provider_error" as const,
      message:
        typeof providerError?.message === "string"
          ? providerError.message
          : `LLM provider returned HTTP ${response.status}.`,
      details: {
        // 保留供应商诊断字段用于可观测性，但不把原始响应体暴露给调用方。
        status: response.status,
        type: typeof providerError?.type === "string" ? providerError.type : undefined,
        providerCode: typeof providerError?.code === "string" ? providerError.code : undefined
      }
    };
  }

  return {
    code: "provider_error" as const,
    message: `LLM provider returned HTTP ${response.status}.`,
    details: {
      status: response.status,
      bodyPreview: (await response.text().catch(() => "")).slice(0, 500)
    }
  };
}

/**
 * 安全解析 HTTP JSON 响应，避免 JSON.parse 异常穿透到调用方。
 *
 * @template T 期望的 JSON payload 类型。
 * @param response provider 返回的 HTTP 响应。
 * @returns 成功时返回 JSON payload，失败时返回 invalid_provider_response。
 */
async function parseResponseJson<T>(response: Response): Promise<LlmResult<T>> {
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Provider response was not valid JSON.",
        details: { reason: getErrorMessage(error) }
      }
    };
  }
}

/**
 * 解析 OpenAI compatible tool_calls，并验证函数名和参数对象形状。
 *
 * @param toolCalls provider 返回的 tool_calls 数组。
 * @returns 成功时返回内部工具调用列表，失败时返回 tool_parse_error。
 */
function parseToolCalls(toolCalls: OpenAiCompatibleToolCall[]): LlmResult<LlmToolCall[]> {
  const parsed: LlmToolCall[] = [];

  for (const toolCall of toolCalls) {
    const name = toolCall.function?.name;
    if (!name) {
      return {
        ok: false,
        error: {
          code: "tool_parse_error",
          message: "Tool call response was missing a function name.",
          details: { toolCall }
        }
      };
    }

    const argumentsText = toolCall.function?.arguments ?? "{}";
    const argumentsResult = parseJsonObject<Record<string, unknown>>(argumentsText);
    if (!argumentsResult.ok || !isRecord(argumentsResult.data)) {
      return {
        ok: false,
        error: {
          code: "tool_parse_error",
          message: `Tool call arguments for ${name} were not valid JSON object.`,
          details: {
            reason: argumentsResult.ok ? "Parsed value is not an object." : argumentsResult.error,
            argumentsPreview: argumentsText.slice(0, 500)
          }
        }
      };
    }

    parsed.push({
      id: toolCall.id,
      name,
      // 工具参数必须是对象，后续工具执行才能按稳定形状做校验。
      arguments: argumentsResult.data
    });
  }

  return { ok: true, data: parsed };
}

/**
 * 解析模型输出中的 JSON，并兼容常见的 markdown fenced JSON。
 *
 * @template T 期望的 JSON 数据类型。
 * @param content 模型输出文本。
 * @returns 成功时返回解析结果，失败时返回错误原因字符串。
 */
function parseJsonObject<T>(content: string): { ok: true; data: T } | { ok: false; error: string } {
  const trimmed = content.trim();
  // 模型经常用 markdown fence 包裹 JSON，client 边界直接兼容这种常见输出。
  const jsonText = trimmed.startsWith("```") ? stripJsonFence(trimmed) : trimmed;

  try {
    return { ok: true, data: JSON.parse(jsonText) as T };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/**
 * 去掉包裹 JSON 的 markdown fence，保留内部 JSON 文本。
 *
 * @param content 以 markdown fence 包裹的模型输出。
 * @returns 去除 fence 后的文本。
 */
function stripJsonFence(content: string): string {
  return content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * 解析 OpenAI compatible SSE 响应体，并逐条产出内部流事件。
 *
 * @param body provider 返回的可读字节流。
 * @returns 内部 LLM 流事件的异步迭代器。
 */
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<LlmStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      // SSE chunk 可能在网络读取中截断一行，所以把未完成的行留在 buffer 中。
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          continue;
        }

        const eventResult = parseStreamPayload(data);
        if (eventResult.ok) {
          for (const event of eventResult.data) {
            yield event;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析单条 SSE data payload，并转换为一个或多个内部流事件。
 *
 * @param payload SSE data 行中的 JSON 字符串。
 * @returns 成功时返回流事件列表，失败时返回结构化解析错误。
 */
function parseStreamPayload(payload: string): LlmResult<LlmStreamEvent[]> {
  const jsonResult = parseJsonObject<OpenAiCompatibleChatResponse>(payload);
  if (!jsonResult.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_provider_response",
        message: "Streaming response chunk was not valid JSON.",
        details: { reason: jsonResult.error, payloadPreview: payload.slice(0, 500) }
      }
    };
  }

  const events: LlmStreamEvent[] = [];
  const [choice] = jsonResult.data.choices ?? [];
  const content = choice?.delta?.content;
  if (content) {
    events.push({ type: "content_delta", delta: content });
  }

  for (const toolCall of choice?.delta?.tool_calls ?? []) {
    events.push({
      type: "tool_call_delta",
      index: toolCall.index ?? 0,
      id: toolCall.id,
      name: toolCall.function?.name,
      argumentsDelta: toolCall.function?.arguments
    });
  }

  if (choice?.finish_reason) {
    events.push({ type: "done", finishReason: choice.finish_reason });
  }

  return { ok: true, data: events };
}

/**
 * 将内部消息结构映射为 OpenAI compatible message 结构。
 *
 * @param message 内部 LLM 消息。
 * @returns provider 可识别的 chat message。
 */
function mapMessage(message: LlmMessage): OpenAiCompatibleChatMessage {
  return {
    role: message.role,
    content: message.content,
    name: message.name,
    tool_call_id: message.toolCallId
  };
}

/**
 * 将内部 tool choice 选项映射为 OpenAI compatible tool_choice。
 *
 * @param choice 内部工具选择配置。
 * @returns provider body 中的 tool_choice 字段；未指定时返回 undefined。
 */
function mapToolChoice(choice: LlmToolChatRequest["toolChoice"]): unknown {
  if (!choice) {
    return undefined;
  }

  if (choice === "auto" || choice === "required") {
    return choice;
  }

  return {
    type: "function",
    function: {
      name: choice.name
    }
  };
}

/**
 * 生成 LLM client trace event id，避免为可观测能力新增 UUID 依赖。
 *
 * @param traceId 当前 trace id。
 * @param label 事件标签。
 * @returns trace event id。
 */
function createTraceEventId(traceId: string, label: string): string {
  return `${traceId}_${label}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 计算模型调用耗时并保留两位小数。
 *
 * @param startedAt performance.now 起始值。
 * @returns 毫秒耗时。
 */
function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

/**
 * 判断未知异常是否是 AbortController 触发的中止错误。
 *
 * @param error 捕获到的未知异常。
 * @returns 如果异常表示请求被 abort 则返回 true。
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 将未知异常转换为可放入结构化错误 details 的字符串。
 *
 * @param error 捕获到的未知异常。
 * @returns 可读错误信息。
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断未知值是否是普通对象，供 provider payload 解析和工具参数校验复用。
 *
 * @param value 待检查的未知值。
 * @returns 如果 value 是非数组对象则返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
