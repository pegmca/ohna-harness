/**
 * serve 侧的「语义会话标题」生成（BUG-002）。
 *
 * 目标：把会话标题从「首条用户消息纯截断」升级为「LLM 语义化压缩」，失败静默降级回截断。
 *
 * 为什么独立于 compaction：compaction 走 `createServeSummarizer` 的完整对话摘要语义
 * （长上下文、多轮、可迭代），而标题生成是「首条消息 → 短标题」的单发、低 token、
 * 尽力而为的一次性调用——两者 prompt 与约束不同，共享同一 model + apiKey + streamFn
 * 装配但拆成独立入口，避免互相拖累。
 *
 * 失败语义：标题是会话体验增强而非功能前提，任何异常（调用失败、空返回、超时）都必须
 * 返回 undefined，由调用方降级为 `deriveTitle` 截断，绝不阻断消息发送。
 */
import { streamSimple } from "@aiagent/ai";
import type { Model } from "@aiagent/ai";
import type { StreamFn } from "@aiagent/agent";

/** 语义标题的字符上限（中文友好：≤ 20 字，短标题在侧栏可读）。 */
const TITLE_MAX_CHARS = 20;

/** 标题生成请求的系统提示词（测试桩按该文案识别标题调用）。 */
const TITLE_SYSTEM_PROMPT =
  "你是会话标题生成器。把用户的首条消息压缩成一个简短、信息密集的中文会话标题，" +
  "保留用户的核心目标或问题。不要输出引号、换行、标点堆砌或任何解释；" +
  `只输出标题本身，且不超过 ${TITLE_MAX_CHARS} 个字符。`;

/** 标题素材的字符上限：标题只关心首条消息，截断到足够小即可。 */
const TITLE_SOURCE_MAX_CHARS = 2_000;

/**
 * 把首条用户消息规范化成标题生成的输入文本（压缩空白 + 截断）。
 *
 * @param text 首条用户消息。
 * @returns 已规范化的标题素材。
 */
function normalizeTitleSource(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TITLE_SOURCE_MAX_CHARS
    ? `${normalized.slice(0, TITLE_SOURCE_MAX_CHARS)}…`
    : normalized;
}

/** 标题生成器配置。 */
export interface TitleGeneratorOptions {
  /** 当前模型（复用同一 provider / 凭据）。 */
  model: Model<"openai-completions">;
  /** provider 凭据。 */
  apiKey: string;
  /** 测试注入的流函数；与 RunManagerOptions.streamFn 同形。 */
  streamFn?: StreamFn;
}

/**
 * 语义标题生成器：一次 LLM 调用把首条消息压成短标题。
 *
 * @param options 模型、凭据与可选 streamFn。
 * @returns 生成器函数；失败（调用异常 / 空返回 / error / aborted）时返回 undefined。
 */
export function createTitleGenerator(options: TitleGeneratorOptions) {
  return async (text: string, signal?: AbortSignal): Promise<string | undefined> => {
    const source = normalizeTitleSource(text);
    if (!source) return undefined;

    try {
      // StreamFn 允许返回流或已 resolve 的流；先 await 统一再取 result。
      const stream = await (options.streamFn ?? streamSimple)(
        options.model,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: source, timestamp: Date.now() }],
        },
        { apiKey: options.apiKey, maxTokens: Math.min(64, options.model.maxTokens), signal },
      );
      const message = await stream.result();
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return undefined;
      }
      const title = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      if (!title) return undefined;
      // 兜底收紧长度：模型偶尔会超长，这里再截一次，保证侧栏标题不爆版。
      return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS)}` : title;
    } catch {
      // 任何异常（含流函数逃逸、超时）都静默降级，标题生成绝不阻断消息发送。
      return undefined;
    }
  };
}

/**
 * 生成一次语义标题（便捷函数）：默认用 streamSimple 装配，等价 `createTitleGenerator` 的单次调用。
 *
 * 保留此签名以便测试与调用方直接注入生成器 stub；生产路径通常走 createTitleGenerator。
 *
 * @param generator 标题生成器（已注入 model/apiKey/streamFn）。
 * @param text 首条用户消息。
 * @param signal 可选取消信号。
 * @returns 语义标题；失败时 undefined（调用方降级为截断）。
 */
export async function generateTitle(
  generator: (text: string, signal?: AbortSignal) => Promise<string | undefined>,
  text: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return generator(text, signal);
}
