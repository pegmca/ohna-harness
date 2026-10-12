/**
 * P5 · Plan-and-Execute + Reflexion 共享工具（planner 与 reflexion 共用的纯函数）。
 *
 * 这一层只放「与模型交互 / 文本抽取 / JSON 容错解析」的通用辅助，不携带任何状态，
 * 也不依赖 planner 或 reflexion 的具体类型，便于两边复用且互不耦合。
 */
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  parseJsonWithRepair,
} from "@aiagent/ai";
import type { StreamFn } from "../types.js";

/**
 * 默认规划 system 提示：要求模型仅输出结构化子任务 JSON，不要额外解释。
 */
export const defaultPlanSystemPrompt =
  "你是一个任务规划器。把用户给定的目标拆解为可执行、可并行的子任务图。" +
  "只输出 JSON，不要任何额外解释或 Markdown 代码围栏之外的文字。";

/**
 * 默认反思 system 提示：要求模型作为严格自检评审，仅输出结构化自评 JSON。
 */
export const defaultReflectionPrompt =
  "你是一个严格的自检评审器。评估上一轮助手工作是否朝目标取得有效进展，" +
  "只输出 JSON，不要任何额外解释。";

/**
 * 从模型文本中抽取 JSON 块：先剥离 ```json 围栏，再截取最外层 {} 或 []。
 * 这是容错解析的第一层（第二层交给 parseJsonWithRepair）。
 *
 * @param text 模型原始输出。
 * @returns 尽可能干净的 JSON 字符串。
 */
export function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const firstObj = candidate.indexOf("{");
  const firstArr = candidate.indexOf("[");
  if (firstObj === -1 && firstArr === -1) return candidate;

  let start: number;
  let endChar: "}" | "]";
  if (firstObj === -1) {
    start = firstArr;
    endChar = "]";
  } else if (firstArr === -1) {
    start = firstObj;
    endChar = "}";
  } else if (firstObj < firstArr) {
    start = firstObj;
    endChar = "}";
  } else {
    start = firstArr;
    endChar = "]";
  }

  const end = candidate.lastIndexOf(endChar);
  if (start === -1 || end === -1 || end < start) return candidate;
  return candidate.slice(start, end + 1);
}

/**
 * 取 assistant 消息的纯文本（忽略 thinking / toolCall）。
 *
 * @param message 助手消息。
 * @returns 拼接后的文本。
 */
export function extractText(message: AssistantMessage): string {
  return message.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * 消费一次事件流，返回最终 assistant 文本；流以 error 收尾时抛错（由调用方兜底）。
 *
 * @param streamFn LLM 流式函数。
 * @param model 模型。
 * @param context LLM 上下文。
 * @param options 流式选项（如 maxTokens）。
 * @returns 最终文本。
 */
export async function generateText(
  streamFn: StreamFn,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<string> {
  const stream = await streamFn(model, context, options);
  let text = "";
  for await (const event of stream) {
    if (event.type === "done") {
      text = extractText(event.message);
    } else if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "stream ended with error");
    }
  }
  return text;
}
