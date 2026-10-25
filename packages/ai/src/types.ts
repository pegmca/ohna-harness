/**
 * 统一中间表示与公共类型：对齐 pi-ai（badlogic/packages/ai）`src/types.ts` 的裁剪版。
 *
 * 裁剪口径（详见 docs/worktree/02-llm-abstraction.md）：
 * - `Api` 只保留三种线协议；不搬 KnownProvider 40+ 枚举、images API、routing 类型；
 * - `Tool.parameters` 用宽松泛型而非 typebox `TSchema`，避免新增依赖（zod 桥接在 agent 层处理）；
 * - compat 标志只保留首批用得上的子集，不做 baseUrl 自动探测。
 */
import type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type { AssistantMessageEventStream } from "./utils/event-stream.js";

/** 支持的线协议标识。 */
export type Api = "openai-completions" | "anthropic-messages" | "google-generative-ai";

/** provider 标识（openai / moonshotai / deepseek 等），不枚举，目录显式声明。 */
export type ProviderId = string;

/** pi thinking 档位。 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;

/** pi thinking 档位 → 该模型实际参数值；null 表示该档位不支持。 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/** 各 thinking 档位的 token 预算（仅 token 制 provider 使用）。 */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type FetchFunction = typeof globalThis.fetch;

/** 自定义请求头；值为 null 表示抑制同名的默认头。 */
export type ProviderHeaders = Record<string, string | null>;

/** onResponse 回调收到的响应摘要。 */
export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

/** 所有 provider 共享的基础流式选项。 */
export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/** 可选 fetch 实现，默认 globalThis.fetch；测试用它注入录制响应。 */
	fetch?: FetchFunction;
	/** 自定义请求头，覆盖 provider 默认头；null 抑制同名默认头。 */
	headers?: ProviderHeaders;
	/** HTTP 请求超时（毫秒），默认 10 分钟对齐 pi / OpenAI SDK。 */
	timeoutMs?: number;
	/** provider 内最大重试次数（retryProviderRequest），默认 0。 */
	maxRetries?: number;
	/**
	 * 服务端要求的最大重试等待毫秒数。超过则立即失败交由上层处理。
	 * 默认 60000；设为 0 关闭该上限。
	 */
	maxRetryDelayMs?: number;
	/** 发送前检查/替换 payload 的钩子；返回 undefined 表示不修改。 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/** 收到 HTTP 响应后、消费 body 流之前的钩子。 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
}

/** streamSimple 使用的统一选项：带 thinking 档位。 */
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** 自定义各档位 thinking token 预算（仅 token 制 provider）。 */
	thinkingBudgets?: ThinkingBudgets;
	/** 工具选择策略（透传给支持的协议 adapter，如 openai-completions 的 tool_choice）。 */
	toolChoice?: unknown;
	/**
	 * 观测扩展：调用方（RunManager / TeamController）注入的 agent 身份，采集层读取
	 * （`createLlmTraceStreamFn` 写进 `LlmCallRecordDto.agentId`，docs/v2.0/04 §1.2）。
	 *
	 * **不进 provider 请求体**：adapter 层一律忽略该字段，也不得把它拼进 payload；
	 * 它只是 loop 选项对象上的旁路通道，因此不需要穿透 `StreamFn` / `Context` 签名。
	 */
	observer?: {
		/** 发起本次调用的 agent 身份；supervisor 根节点为 "supervisor"。 */
		agentId?: string;
	};
}

/**
 * 流式函数统一契约：
 * - 必须返回 AssistantMessageEventStream；
 * - 调用后的请求/模型/运行时失败编码进事件流，不抛出；
 * - 错误收尾必须产生 stopReason 为 "error" 或 "aborted" 且带 errorMessage 的 AssistantMessage。
 */
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

/** 协议 adapter 模块的统一形状：api/ 与 providers/ 下每个模块导出这两个函数。 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export interface TextContent {
	type: "text";
	text: string;
	/** provider 签名字段透传：历史回放时原样放回（如 OpenAI responses 的消息元数据）。 */
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	/** 被安全过滤的加密思考块；签名透传保证多轮思考连续性。 */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	/** base64 编码的图片数据。 */
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Google 专用思考签名，回放时透传。 */
	thoughtSignature?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 推理 token 数（provider 上报时）；是 output 的子集。 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** Unix 毫秒时间戳。 */
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	/** 上游实际返回的 chunk.model（与请求模型不同的时候，如路由网关）。 */
	responseModel?: string;
	/** provider 侧响应标识（chunk.id）。 */
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	/** Unix 毫秒时间戳。 */
	timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	/** 工具侧结构化结果（引用、行数等），不进 LLM 上下文。 */
	details?: TDetails;
	isError: boolean;
	/** Unix 毫秒时间戳。 */
	timestamp: number;
}

/** 统一消息三元组。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * 工具定义。parameters 刻意用宽松泛型而非 pi 的 typebox TSchema：
 * 本层只做透传（序列化为 JSON Schema 放进请求），zod 桥接在 agent 层 AgentTool 处理。
 */
export interface Tool<TParameters = unknown> {
	name: string;
	description: string;
	/** JSON Schema 形状的参数定义（如 zod 的 z.toJSONSchema 输出）。 */
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 流先发出 `start`，随后是 text/thinking/toolcall 的 start/delta/end 增量（每个事件都携带
 * 当前累积的完整 partial message，`contentIndex` 定位当前块），最终以 `done`（成功）或
 * `error`（stopReason 为 "error"/"aborted" 且带 errorMessage）收尾。
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** OpenAI 兼容 completions API 的兼容覆盖集（首批子集；不做 baseUrl 自动探测，目录显式声明）。 */
export interface OpenAICompletionsCompat {
	/** 是否支持 developer 角色（否则用 system）。默认 false。 */
	supportsDeveloperRole?: boolean;
	/** 是否支持 reasoning_effort 字段。默认 true。 */
	supportsReasoningEffort?: boolean;
	/** 是否支持 stream_options.include_usage 流式 usage。默认 true。 */
	supportsUsageInStreaming?: boolean;
	/** max tokens 用哪个字段。默认 "max_completion_tokens"。 */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** thinking 块是否必须转成纯文本回放。默认 false。 */
	requiresThinkingAsText?: boolean;
	/**
	 * thinking 参数格式："openai" 用 reasoning_effort；"deepseek" 用 thinking: { type }；
	 * "qwen" 用顶层 enable_thinking。默认 "openai"。
	 */
	thinkingFormat?: "openai" | "deepseek" | "qwen";
}

/** Anthropic Messages API 的兼容覆盖集（首批子集）。 */
export interface AnthropicMessagesCompat {
	/** 是否强制 adaptive thinking（thinking.type: "adaptive" + effort）。默认 false。 */
	forceAdaptiveThinking?: boolean;
	/** 是否接受 temperature 字段。默认 true。 */
	supportsTemperature?: boolean;
	/** 是否支持长缓存保留（cache_control.ttl: "1h"）。默认 true。 */
	supportsLongCacheRetention?: boolean;
}

/** 模型费率，单位 $/百万 token。 */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** 模型目录条目；compat 按 api 条件化，承接各 provider 的协议怪癖。 */
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	/** pi thinking 档位 → 该模型实际参数值；缺失用默认，null 表示不支持。 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "anthropic-messages"
			? AnthropicMessagesCompat
			: never;
}
