/**
 * 内存版记忆存储：episode 存于数组、工作记忆存于对象。
 * 无外部依赖，适合单进程运行与单元测试；进程退出即丢失（跨会话需 Jsonl / PG 持久化）。
 */
import { cosineSimilarity } from "./similarity.js";
import type {
  EpisodeMemory,
  MemoryStore,
  RetrievedMemory,
  WorkingMemory,
} from "./types.js";

/** 初始空工作记忆。 */
function emptyWorkingMemory(): WorkingMemory {
  return { summary: "", facts: [], updatedAt: 0 };
}

/**
 * 内存记忆存储实现。
 * 语义检索为同步纯函数（本地余弦），故 retrieve 仅用 Promise 包装以保持接口一致。
 */
export class InMemoryMemoryStore implements MemoryStore {
  private episodes: EpisodeMemory[] = [];
  private working: WorkingMemory = emptyWorkingMemory();

  /** @inheritdoc */
  async saveEpisode(episode: EpisodeMemory): Promise<void> {
    this.episodes.push(episode);
  }

  /** @inheritdoc */
  async retrieve(query: string, k = 5): Promise<RetrievedMemory[]> {
    const scored: RetrievedMemory[] = this.episodes.map((record) => ({
      record,
      score: cosineSimilarity(query, record.content),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }

  /** @inheritdoc 返回防御性副本，避免外部直接改写内部状态。 */
  getWorkingMemory(): WorkingMemory {
    return { ...this.working, facts: [...this.working.facts] };
  }

  /** @inheritdoc summary 覆盖，facts 按 key 合并（同名覆盖）。 */
  updateWorkingMemory(patch: Partial<Omit<WorkingMemory, "updatedAt">>): void {
    if (typeof patch.summary === "string") {
      this.working.summary = patch.summary;
    }
    if (Array.isArray(patch.facts)) {
      const byKey = new Map(this.working.facts.map((fact) => [fact.key, fact]));
      for (const fact of patch.facts) {
        byKey.set(fact.key, fact);
      }
      this.working.facts = [...byKey.values()];
    }
    this.working.updatedAt = Date.now();
  }

  /** @inheritdoc 返回防御性副本。 */
  async listEpisodes(): Promise<EpisodeMemory[]> {
    return this.episodes.map((episode) => ({ ...episode }));
  }
}
