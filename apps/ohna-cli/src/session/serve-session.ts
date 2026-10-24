/**
 * 服务端会话适配器（docs/v1.4/06 A3 持久化收敛）。
 *
 * 会话持久化已统一收敛到 `@aiagent/serve` 的 store；CLI 不再写本地 JSONL，只通过
 * `OhnaServer` 句柄（或同源的 store 类）读取会话列表与消息，用于终端展示 / 压缩 / 导出 /
 * fork。所有写操作（消息落盘、标题、压缩摘要）都由 serve 的 `createRun` / `createConversation`
 * 承担，CLI 是 serve 执行线的订阅者。
 *
 * 读消息直接复用 serve 导出的 `LocalMessageStore` 类（同一 dataDir），避免把 serve 的
 * 存储路径再实现一遍；这是「经 serve 句柄读消息列表」的最小代价实现。
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@aiagent/agent";
import type { OhnaServer } from "@aiagent/serve";
import { LocalMessageStore, LocalSessionStore } from "@aiagent/serve";
import type { LinearMessageDto, WorkspaceConversationDto } from "@aiagent/types";

/** 默认数据目录：`~/.ohna`（与 serve 缺省一致）。 */
export function defaultDataDir(): string {
  return path.join(os.homedir(), ".ohna");
}

/**
 * 解析数据目录（缺省 `~/.ohna`）。
 *
 * @param dataDir 可选覆盖（测试注入）。
 * @returns 绝对路径。
 */
export function resolveDataDir(dataDir?: string): string {
  return path.resolve(dataDir ?? defaultDataDir());
}

/**
 * 结构化错误：旧格式会话 id（`<uuid>.jsonl`）无法在 serve 会话模型下打开。
 *
 * 旧 CLI 把会话存为 `~/.ohna/sessions/<uuid>.jsonl`；收敛后会话由 serve 的
 * `index.jsonl` 持有，id 为无扩展名的 UUID。误传旧格式 id 时给出可读错误，
 * 而不是静默开新会话（避免用户以为「会话丢了」）。
 */
export class LegacySessionIdError extends Error {
  /** 误传的旧格式 id。 */
  readonly legacyId: string;

  /**
   * @param legacyId 用户传入的 `<uuid>.jsonl` 形态 id。
   */
  constructor(legacyId: string) {
    super(
      `会话 id "${legacyId}" 是旧版 CLI 的本地 JSONL 格式（<uuid>.jsonl），` +
        `新版本会话由本地服务统一托管，已不再使用。请用 /resume 查看可用会话，或重新发起对话。`,
    );
    this.name = "LegacySessionIdError";
    this.legacyId = legacyId;
  }
}

/**
 * 判断会话 id 是否为旧版本地 JSONL 格式（`<uuid>.jsonl`）。
 *
 * @param id 用户传入的会话 id。
 * @returns 是旧格式返回 true。
 */
export function isLegacySessionId(id: string): boolean {
  return /\.jsonl$/i.test(id);
}

/**
 * 列出会话（等价于 GET /api/conversations）。
 *
 * @param server 进程内 serve 句柄。
 * @returns 会话摘要列表（按更新时间倒序由 serve 保证）。
 */
export function listConversations(server: OhnaServer): Promise<WorkspaceConversationDto[]> {
  return server.listConversations();
}

/**
 * 读取会话全量消息（serve 存储的线性消息映射回 AgentMessage，供 /resume / /compact /
 * /export 与本地历史展示）。
 *
 * @param dataDir 数据目录（必须与托管 serve 实例一致）。
 * @param conversationId 会话 id。
 * @returns AgentMessage 序列（按 sequence 升序）。
 */
export async function loadMessages(
  dataDir: string,
  conversationId: string,
): Promise<AgentMessage[]> {
  const store = new LocalMessageStore(path.join(resolveDataDir(dataDir), "conversations"));
  const lines = await store.list(conversationId);
  return lines.map(toAgentMessage).filter((message): message is AgentMessage => message !== null);
}

/**
 * 把 serve 的 LinearMessageDto 映射为 AgentMessage（最贴近原形的尽力映射）。
 *
 * serve 是消息的唯一事实源；本映射只用于终端展示 / 压缩 / 导出，不回写 serve，
 * 因此内容级信息（role / content / 摘要）即可，运行期 usage 等字段按可选补齐。
 *
 * @param line 线性消息 DTO。
 * @returns AgentMessage 或 null（无法识别时跳过）。
 */
function toAgentMessage(line: LinearMessageDto): AgentMessage | null {
  const timestamp = line.createdAt ? Date.parse(line.createdAt) || Date.now() : Date.now();
  if (line.messageType === "compaction") {
    const summary =
      typeof line.content === "string" ? line.content : flattenContent(line.content as never);
    return { role: "compaction", summary, timestamp } as AgentMessage;
  }
  if (line.role === "user") {
    return { role: "user", content: line.content, timestamp } as AgentMessage;
  }
  if (line.role === "assistant") {
    const message = {
      role: "assistant",
      content: line.content,
      timestamp,
      ...(line.modelId ? { model: line.modelId } : {}),
      ...(line.usage ? { usage: line.usage } : {}),
      ...(line.stopReason ? { stopReason: line.stopReason } : {}),
    } as unknown as AgentMessage;
    return message;
  }
  if (line.role === "toolResult") {
    const message = {
      role: "toolResult",
      content: line.content,
      toolName: (line as { toolName?: string }).toolName ?? "tool",
      timestamp,
    } as unknown as AgentMessage;
    return message;
  }
  return null;
}

/**
 * 把任意 content 展平为纯文本（compaction 摘要 / 兜底）。
 *
 * @param content 字符串或内容块数组。
 * @returns 纯文本。
 */
function flattenContent(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : "[图片]"))
    .join("\n");
}

/**
 * fork 旧会话：复制其消息到新会话（serve 侧新建），旧会话保留。
 *
 * @param server 进程内 serve 句柄。
 * @param dataDir 数据目录。
 * @param sourceId 被 fork 的旧会话 id。
 * @param title 标题（缺省沿用旧标题）。
 * @returns 新会话 id。
 */
export async function forkConversation(
  server: OhnaServer,
  dataDir: string,
  sourceId: string,
  title?: string,
): Promise<string> {
  const messages = await loadMessages(dataDir, sourceId);
  const created = await server.createConversation(title ?? "新会话");
  const store = new LocalMessageStore(path.join(resolveDataDir(dataDir), "conversations"));
  for (const message of messages) {
    const role = message.role === "compaction" ? "user" : message.role;
    await store.append(created.conversationId, {
      role: role as LinearMessageDto["role"],
      content: (message as { content?: unknown; summary?: unknown }).content ??
        (message as { summary?: string }).summary ?? "",
      ...(message.role === "compaction" ? { messageType: "compaction" as const } : {}),
    });
  }
  return created.conversationId;
}

/**
 * 读取会话元数据（标题 / 工作区），供欢迎头与 /status 展示。
 *
 * @param dataDir 数据目录。
 * @param conversationId 会话 id。
 * @returns 元数据或 null。
 */
export async function getConversationMeta(
  dataDir: string,
  conversationId: string,
): Promise<{ id: string; title: string; workspaceRoot: string } | null> {
  if (!conversationId) return null;
  const store = new LocalSessionStore(path.join(resolveDataDir(dataDir), "sessions"));
  const meta = await store.get(conversationId);
  if (!meta) return null;
  return { id: meta.id, title: meta.title, workspaceRoot: meta.workspaceRoot };
}
