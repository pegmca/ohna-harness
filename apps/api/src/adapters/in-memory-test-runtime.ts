import type { AttachmentRepository } from "@aiagent/database";
import { createIdentityService, createInMemoryIdentityRepository, type IdentityService } from "@aiagent/identity";
import { createDataSourceRuntime, type CitationRepository, type DataSourceRuntime } from "@aiagent/rag";
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
  return {
    identityService: createIdentityService(createInMemoryIdentityRepository(), {
      fingerprintPepper: "test-only-identity-pepper"
    }),
    dataSourceRuntime: createDataSourceRuntime(),
    workflowRepository: report.workflowRepository,
    artifactRepository: report.artifactRepository,
    attachmentRepository: createInMemoryAttachmentRepository(),
    citationRepository: createInMemoryCitationRepository(),
    ...stores
  };
}
