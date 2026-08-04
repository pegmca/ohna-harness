import type {
  CitationRecord,
  CitationRepository,
  CitationVerifierUpdateResult
} from "@aiagent/rag";

interface StoredCitation extends CitationRecord {
  userId: string;
  messageId?: string;
  artifactId?: string;
}

/**
 * 创建内存版 Citation repository（仅测试显式使用）。
 *
 * 只保证 run-service 写入路径可用：saveMessageCitations 追加、
 * listMessageCitations 返回归属用户的引用；verifier 更新与 artifact 读取返回占位结果。
 *
 * @returns 测试用 CitationRepository。
 */
export function createInMemoryCitationRepository(): CitationRepository {
  const citations = new Map<string, StoredCitation>();

  return {
    async listMessageCitations(userId, messageId) {
      const owned = [...citations.values()].filter(
        (citation) => citation.userId === userId && citation.messageId === messageId
      );
      return owned.length > 0 ? owned.map((citation) => projectCitation(citation)) : [];
    },
    async saveMessageCitations(userId, messageId, inputs) {
      for (const input of inputs) {
        const citation: StoredCitation = {
          citationId: crypto.randomUUID(),
          userId,
          messageId,
          ordinal: input.ordinal,
          claim: input.claim,
          verifierStatus: input.verifierStatus ?? "unverified",
          createdAt: new Date().toISOString(),
          source: input.chunkId
            ? {
                status: "accessible",
                chunkId: input.chunkId,
                documentId: "",
                documentVersionId: "",
                sourceUri: "",
                chunkIndex: 0,
                quote: input.quote,
                ...(input.score !== undefined ? { score: input.score } : {})
              }
            : { status: "unresolved", quote: input.quote, ...(input.score !== undefined ? { score: input.score } : {}) }
        };
        citations.set(citation.citationId, citation);
      }
    },
    async listArtifactCitations() {
      return [];
    },
    async updateMessageCitationVerifierStatus() {
      return { status: "not_found" } as CitationVerifierUpdateResult;
    },
    async updateArtifactCitationVerifierStatus() {
      return { status: "not_found" } as CitationVerifierUpdateResult;
    }
  };
}

function projectCitation(citation: StoredCitation): CitationRecord {
  return {
    citationId: citation.citationId,
    ordinal: citation.ordinal,
    claim: citation.claim,
    verifierStatus: citation.verifierStatus,
    createdAt: citation.createdAt,
    source: citation.source
  };
}
