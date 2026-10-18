/**
 * 测试替身：不联网的 StreamFn。
 *
 * 正常流：start → text_start → text_delta → text_end → done。
 * 慢速流：监听 AbortSignal，收到取消后产出 stopReason="aborted" 的 error 事件；
 * 用它验证 serve 的取消终态（Gate 3），而不是等真实网络超时。
 * 工具流：按用户文本返回确定性 toolCall，收到 toolResult 后收尾——
 * 用于 Phase 3 的确认闸门 / 沙箱负向用例，不依赖真实 provider。
 */
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream } from "@aiagent/ai";

/**
 * 构造一条 assistant 消息。
 *
 * @param {string} text 文本内容。
 * @param {string} stopReason 停止原因。
 * @returns {object} AssistantMessage。
 */
export function assistantMessage(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "mock",
    model: "stub-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason,
    timestamp: Date.now()
  };
}

/**
 * 正常文本流：一次性产出完整文本并 done。
 *
 * @param {string} text 回复文本。
 * @returns {Function} StreamFn。
 */
export function createTextStream(text = "你好，我是 ohna。") {
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = assistantMessage(text);
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] }
      });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

/**
 * 从 LLM 上下文中取最后一条 user 文本（content 可能是字符串或块数组）。
 *
 * @param {object[]} messages 上下文消息。
 * @returns {string} 用户文本。
 */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n");
    }
  }
  return "";
}

/**
 * 按用户文本决定一次确定性工具调用。
 *
 * @param {string} text 最后一条用户文本。
 * @param {{writePath?: string, writeContent?: string, command?: string}} options 覆盖项。
 * @returns {object|undefined} toolCall 内容块。
 */
function decideToolCall(text, options) {
  const id = `stub_call_${randomUUID()}`;
  if (/改文件|改码|写入/u.test(text)) {
    return {
      type: "toolCall",
      id,
      name: "write",
      arguments: {
        path: options.writePath ?? "note.txt",
        content: options.writeContent ?? "改好了\n"
      }
    };
  }
  if (/危险|rm -rf/u.test(text)) {
    return {
      type: "toolCall",
      id,
      name: "bash",
      arguments: { command: options.command ?? "rm -rf /" }
    };
  }
  if (/越界|passwd/u.test(text)) {
    return { type: "toolCall", id, name: "read", arguments: { path: "/etc/passwd" } };
  }
  if (/读取|读文件|只读/u.test(text)) {
    return {
      type: "toolCall",
      id,
      name: "read",
      arguments: { path: options.readPath ?? "note.txt" }
    };
  }
  if (/列目录|列出|探索/u.test(text)) {
    return { type: "toolCall", id, name: "ls", arguments: { path: options.listPath ?? "." } };
  }
  return undefined;
}

/**
 * 工具调用流：首轮产出 toolCall；拿到 toolResult 后以文本收尾（含错误摘要）。
 *
 * @param {{writePath?: string, writeContent?: string, command?: string, readPath?: string}} [options] 覆盖项。
 * @returns {Function} StreamFn。
 */
export function createToolStream(options = {}) {
  return (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const messages = context.messages ?? [];
    const last = messages[messages.length - 1];

    /** 收尾：统一按 content 块产出 text / toolcall 事件。 */
    const emitMessage = (message) => {
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        message.content.forEach((block, contentIndex) => {
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex, partial: message });
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
          } else if (block.type === "toolCall") {
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
          }
        });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message
        });
      });
      return stream;
    };

    // 第二轮：模型已拿到工具结果（成功或 isError），给一段确定性总结。
    if (last?.role === "toolResult") {
      const text = Array.isArray(last.content)
        ? last.content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("\n")
        : String(last.content ?? "");
      const message = assistantMessage(
        last.isError ? `工具执行失败：${text}` : `工具执行完成：${text}`
      );
      return emitMessage(message);
    }

    const toolCall = decideToolCall(lastUserText(messages), options);
    if (!toolCall) {
      return emitMessage(assistantMessage("（测试替身）无需工具调用。"));
    }
    const message = { ...assistantMessage(""), content: [toolCall], stopReason: "toolUse" };
    return emitMessage(message);
  };
}

/**
 * 慢速流：先吐一个 delta，然后挂起；只有 abort 或超时才结束。
 *
 * @param {{ idleMs?: number }} [options] idleMs 为无取消时的最长等待。
 * @returns {Function} StreamFn。
 */
export function createSlowStream(options = {}) {
  const idleMs = options.idleMs ?? 10_000;
  return (_model, _context, streamOptions = {}) => {
    const stream = createAssistantMessageEventStream();
    const partial = assistantMessage("正在思考…");
    const abort = streamOptions.signal;
    queueMicrotask(() => {
      const pushAborted = () => {
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...partial, stopReason: "aborted", errorMessage: "aborted by client" }
        });
      };
      if (abort?.aborted) {
        pushAborted();
        return;
      }
      stream.push({ type: "start", partial: { ...partial, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "正在思考…", partial });
      const timer = setTimeout(() => {
        cleanup();
        stream.push({ type: "done", reason: "stop", message: partial });
      }, idleMs);
      const onAbort = () => {
        cleanup();
        pushAborted();
      };
      const cleanup = () => {
        clearTimeout(timer);
        abort?.removeEventListener("abort", onAbort);
      };
      abort?.addEventListener("abort", onAbort, { once: true });
    });
    return stream;
  };
}
