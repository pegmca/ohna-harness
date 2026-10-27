/**
 * 启动期崩溃对账（spec §8.3 / §8.4）。
 *
 * 进程异常退出可能留下「run 文件有 meta + 若干事件、但索引缺失」或「run 处于非终态」
 * 的状态。对账原则：
 *  - 只重建读模型（补齐索引）、把非终态 run 的快照收敛为 `interrupted`（依赖
 *    `getRun` 已有的「非终态 → interrupted」回退）；
 *  - 不写合成事件、不自动重放、不删除任何已落盘数据；
 *  - 半行/损坏行已被 `readJsonlLines` 跳过，对账本身不会因坏行抛错。
 *
 * 这里只差集回填 run 索引（`LocalRunStore` 的私有 backfill 在 `ensureIndexBackfilled`
 * 内已覆盖，但只在 list 时触发；显式调用 `reconcileIndex` 让「启动即一致」不依赖
 * 首次 list 时机）。索引补齐后，非终态收敛由 `listRunsByConversation` 经 `getRun`
 * 自然得到 `interrupted`，无需额外写。
 */
import { ensureDir } from "./jsonl.js";
import type { LocalRunStore } from "./run-store.js";
import type { LocalMessageStore } from "./message-store.js";
import type { LocalSessionStore } from "./session-store.js";

/** reconcileOnStart 依赖的 store 集合（至少含 runStore）。 */
export interface ReconcileStores {
  /** run 事件 / 索引存储（必填）。 */
  runStore: LocalRunStore;
  /** 线性消息存储（预留，当前对账不依赖其写入）。 */
  messageStore: LocalMessageStore;
  /** 会话元数据存储（预留，当前对账不依赖其写入）。 */
  sessionStore: LocalSessionStore;
}

/**
 * 启动期对账：确保 run 索引已从磁盘完全回填，使重启后侧栏不漏 run、非终态 run 收敛
 * 为 interrupted。
 *
 * @param dataDir 数据目录根（保留参数以便未来扩展 message/session 对账）。
 * @param stores 已构造的 store 集合（至少含 runStore）。
 */
export async function reconcileOnStart(dataDir: string, stores: ReconcileStores): Promise<void> {
  // 保证所有子目录存在，避免 backfill 扫描到「目录不存在」而误判无数据。
  await ensureDir(dataDir).catch(() => undefined);
  // 差集回填索引：目录内 run 文件 ↔ 索引已有 runId 做差集，补齐缺失项。
  // 这一步幂等、确定性，且不会因半行/坏行抛错（坏行在 readJsonlLines 内已被跳过）。
  await stores.runStore.reconcileIndex();
}
