import type {
  Conversation,
  ConversationRepository,
  MessageStore,
  StoredMessage
} from "@aiagent/conversation";
import { ConversationRepositoryError } from "@aiagent/conversation";
import type {
  ConversationDto,
  CreateConversationRequestDto,
  CursorPageDto,
  LinearMessageDto,
  UpdateConversationRequestDto
} from "@aiagent/types";

export interface ConversationApplicationService {
  create(userId: string, input: CreateConversationRequestDto): Promise<ConversationDto>;
  list(userId: string, input: { cursor?: string; limit: number }): Promise<CursorPageDto<ConversationDto>>;
  listMessages(
    userId: string,
    input: { conversationId: string; cursor?: string; limit: number }
  ): Promise<CursorPageDto<LinearMessageDto>>;
  update(userId: string, conversationId: string, input: UpdateConversationRequestDto): Promise<ConversationDto>;
}

/**
 * 创建 Conversation 用例服务；HTTP adapter 不直接接触领域 row，也不持有第二份状态。
 * 阶段 3：消息列表直接返回线性 Message DTO（content 块原样透传，含 compaction 行）。
 *
 * @param repositories 已注入的领域 repository。
 * @returns Conversation API 用例集合。
 */
export function createConversationApplicationService(repositories: {
  conversationRepository: ConversationRepository;
  messageStore: MessageStore;
}): ConversationApplicationService {
  return {
    /** @param userId 当前用户。 @param input 创建输入。 @returns 会话 DTO。 */
    async create(userId, input) {
      return toConversationDto(await repositories.conversationRepository.create(userId, {
        title: input.title.trim()
      }));
    },

    /** @param userId 当前用户。 @param input 分页输入。 @returns 会话 DTO 页。 */
    async list(userId, input) {
      const page = await repositories.conversationRepository.list(userId, {
        status: "active",
        limit: input.limit,
        cursor: input.cursor
      });
      return { items: page.items.map(toConversationDto), nextCursor: page.nextCursor };
    },

    /** @param userId 当前用户。 @param input 消息分页输入。 @returns 线性消息 DTO 页。 */
    async listMessages(userId, input) {
      if (!await repositories.conversationRepository.find(userId, input.conversationId)) {
        throw new ConversationRepositoryError("not_found", "Conversation resource was not found.");
      }
      const page = await repositories.messageStore.list(userId, input);
      return { items: page.items.map(toLinearMessageDto), nextCursor: page.nextCursor };
    },

    /** @param userId 当前用户。 @param conversationId 会话 ID。 @param input 更新输入。 @returns 会话 DTO。 */
    async update(userId, conversationId, input) {
      const conversation = typeof input.title === "string"
        ? await repositories.conversationRepository.updateTitle(userId, conversationId, input.title.trim())
        : await repositories.conversationRepository.archive(userId, conversationId);
      return toConversationDto(conversation);
    }
  };
}

/** @param conversation 领域会话。 @returns 不含 userId 的 API DTO。 */
function toConversationDto(conversation: Conversation): ConversationDto {
  return {
    conversationId: conversation.id,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    archivedAt: conversation.archivedAt
  };
}

/** @param message 领域存储消息。 @returns 不含 userId/clientMessageId 的线性消息 DTO。 */
function toLinearMessageDto(message: StoredMessage): LinearMessageDto {
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    runId: message.runId,
    role: message.role,
    content: message.content,
    messageType: message.messageType,
    sequence: message.sequence,
    usage: message.usage,
    modelId: message.modelId,
    stopReason: message.stopReason,
    createdAt: message.createdAt
  };
}
