import type { AttachmentRepository } from "@aiagent/database";
import { createIdentityService, createInMemoryIdentityRepository, type IdentityService } from "@aiagent/identity";
import {
  createDataSourceRuntime,
  createDeterministicMockEmbeddingClient,
  createInMemoryAttachmentStore,
  type AttachmentStore,
  type CitationRepository,
  type DataSourceRuntime,
  type EmbeddingClient
} from "@aiagent/rag";
import type { ArtifactRepository, WorkflowRepository } from "@aiagent/report";
import type { ConversationRepository, MessageStore } from "@aiagent/conversation";
import type { RunStore } from "../application/run-ports.js";
import { createInMemoryAttachmentRepository } from "./in-memory-attachment-repository.js";
import { createInMemoryCitationRepository } from "./in-memory-citation-repository.js";
import { createInMemoryConversationStores } from "./in-memory-conversation-store.js";
import { createInMemoryReportRepositories } from "./in-memory-report-persistence.js";
import { createInMemoryRunStore } from "./in-memory-run-runtime.js";

/** 测试用内存依赖集合；生产 composition 不得使用，只能由测试显式创建并注入。 */
export interface InMemoryApiTestRuntime {
  identityService: IdentityService;
  dataSourceRuntime: DataSourceRuntime;
  workflowRepository: WorkflowRepository;
  artifactRepository: ArtifactRepository;
  conversationRepository: ConversationRepository;
  messageStore: MessageStore;
  runStore: RunStore;
  attachmentRepository: AttachmentRepository;
  citationRepository: CitationRepository;
  /** 会话级临时附件存储（内存实现）；供附件路由与 run grounding 使用。 */
  attachmentStore: AttachmentStore;
  /** 确定性 embedding 替身；与 dataSourceRuntime 共用同一实例，保证两路向量一致可比。 */
  embeddingClient: EmbeddingClient;
}

/**
 * 创建一套共享同一份内存事实源的测试依赖。
 *
 * @param options.stores 需要跨 server 实例共享（模拟重启）时显式传入的内存事实源。
 * @returns 可直接展开传入 createApiServer 的内存依赖。
 */
export function createInMemoryApiTestRuntime(options: {
  stores?: Pick<InMemoryApiTestRuntime, "runStore" | "conversationRepository" | "messageStore">;
} = {}): InMemoryApiTestRuntime {
  const conversationStores = createInMemoryConversationStores();
  const stores = options.stores ?? {
    runStore: createInMemoryRunStore({ messageStore: conversationStores.messageStore }),
    conversationRepository: conversationStores.conversationRepository,
    messageStore: conversationStores.messageStore
  };
  const report = createInMemoryReportRepositories();
  // 单例确定性 embedding 替身：同时注入 dataSourceRuntime（持久化 RAG）与附件路由/grounding，
  // 保证附件路与内部库路在同一向量空间，测试断言可跨源比较。
  const embeddingClient = createDeterministicMockEmbeddingClient();
  return {
    identityService: createIdentityService(createInMemoryIdentityRepository(), {
      fingerprintPepper: "test-only-identity-pepper"
    }),
    // 测试替身显式注入（非生产配置）：embedding client 已无生产默认值，
    // 这里必须注入 deterministic mock 替身，否则 ingest 直接返回 embedding_provider_disabled，
    // agent-run / attachment-upload 等依赖 RAG 索引的用例会失败。
    dataSourceRuntime: createDataSourceRuntime({ embeddingClient }),
    workflowRepository: report.workflowRepository,
    artifactRepository: report.artifactRepository,
    attachmentRepository: createInMemoryAttachmentRepository(),
    citationRepository: createInMemoryCitationRepository(),
    attachmentStore: createInMemoryAttachmentStore(),
    embeddingClient,
    ...stores
  };
}
