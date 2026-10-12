/**
 * JSONL 文件持久化记忆存储：episode 按行追加到 JSONL 文件（Node fs）。
 * 用「懒加载 + 追加写」模拟 pi 的会话树 JSONL 持久化思路，无需外部数据库即可跨会话留存，
 * 作为 PG + 向量库落地前的可测试占位实现。
 *
 * 注意：懒加载在首次访问时读入全部 episode 到内存；写入采用 appendFile 追加（单进程安全）。
 * 工作记忆默认仅存内存（会话内），可传 workingFilePath 落盘（异步、尽力而为）。
 */
import { promises as fs } from "node:fs";
import { cosineSimilarity } from "./similarity.js";
import type {
  EpisodeMemory,
  MemoryStore,
  RetrievedMemory,
  WorkingMemory,
} from "./types.js";

/** JsonlMemoryStore 构造选项。 */
export interface JsonlMemoryStoreOptions {
  /** episode 持久化的 JSONL 文件路径。 */
  filePath: string;
  /** 工作记忆持久化文件（可选；缺省则工作记忆仅存内存）。 */
  workingFilePath?: string;
}

/** 初始空工作记忆。 */
function emptyWorkingMemory(): WorkingMemory {
  return { summary: "", facts: [], updatedAt: 0 };
}

/**
 * 基于 Node fs 的 JSONL 记忆存储。
 * 通过懒加载（首次读写才读盘）避免构建期/空文件的报错，并保证只读一次。
 */
export class JsonlMemoryStore implements MemoryStore {
  private readonly filePath: string;
  private readonly workingFilePath?: string;
  private episodes: EpisodeMemory[] = [];
  private working: WorkingMemory = emptyWorkingMemory();
  private loaded = false;
  private loading?: Promise<void>;

  /**
   * @param options.filePath episode JSONL 路径；options.workingFilePath 工作记忆路径（可选）。
   */
  constructor(options: JsonlMemoryStoreOptions) {
    this.filePath = options.filePath;
    this.workingFilePath = options.workingFilePath;
  }

  /** 保证数据已从磁盘加载（幂等、并发安全）。 */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = this.doLoad();
    await this.loading;
  }

  /** 从磁盘读取 episode（与可选的工作记忆），文件不存在/损坏均以空存储兜底，不向上抛。 */
  private async doLoad(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      this.episodes = lines.map((line) => JSON.parse(line) as EpisodeMemory);
    } catch (error) {
      // ENOENT 表示首次使用；其他错误（损坏）同样以空存储兜底，符合「错误即数据」。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.episodes = [];
      }
    }
    if (this.workingFilePath) {
      try {
        const raw = await fs.readFile(this.workingFilePath, "utf8");
        this.working = JSON.parse(raw) as WorkingMemory;
      } catch {
        this.working = emptyWorkingMemory();
      }
    }
    this.loaded = true;
  }

  /** @inheritdoc 先确保加载，再追加写入（appendFile 行级追加）。 */
  async saveEpisode(episode: EpisodeMemory): Promise<void> {
    await this.ensureLoaded();
    this.episodes.push(episode);
    await fs.appendFile(this.filePath, JSON.stringify(episode) + "\n", "utf8");
  }

  /** @inheritdoc */
  async retrieve(query: string, k = 5): Promise<RetrievedMemory[]> {
    await this.ensureLoaded();
    const scored: RetrievedMemory[] = this.episodes.map((record) => ({
      record,
      score: cosineSimilarity(query, record.content),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }

  /** @inheritdoc 返回防御性副本。 */
  getWorkingMemory(): WorkingMemory {
    return { ...this.working, facts: [...this.working.facts] };
  }

  /** @inheritdoc 就地合并；若配了 workingFilePath 则异步落盘（尽力而为，失败静默）。 */
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
    if (this.workingFilePath) {
      void fs.writeFile(this.workingFilePath, JSON.stringify(this.working), "utf8").catch(() => undefined);
    }
  }

  /** @inheritdoc 返回防御性副本。 */
  async listEpisodes(): Promise<EpisodeMemory[]> {
    await this.ensureLoaded();
    return this.episodes.map((episode) => ({ ...episode }));
  }
}
