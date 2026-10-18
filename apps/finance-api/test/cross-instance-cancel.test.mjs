import assert from "node:assert/strict";
import test from "node:test";
import { createSharedExecutionRegistry } from "../dist/adapters/execution-registry-shared.js";
import {
  createInMemoryRunCancelSignal,
  createInMemoryRunCancelStore
} from "../dist/adapters/in-memory-run-runtime.js";

/**
 * 跨实例取消单元用例（对应 P0 取消信号外置）。
 *
 * 用两个注册表实例共享同一「取消信号 + 取消标记存储」来模拟进程分离的真实部署：
 * 实例 B 发起 requestCancel（写 DB 标记 + 广播即时信号），实例 A 上正在执行的 run
 * 应经共享信号被本地 abort，且 DB 标记可被 execute 回查兜底 queued 竞态。
 *
 * 优先使用真实 `createPostgresRunCancelStore`（TEST_DATABASE_URL 存在时）；
 * 无 Postgres 时退化为内存 cancelStore（同接口语义），仍验证跨实例取消传播逻辑。
 */
const pgUrl = process.env.TEST_DATABASE_URL;

test("跨实例取消：实例 B 取消可中断实例 A 的 run 并经取消标记存储兜底", async () => {
  let pool = null;
  let cancelStore;
  if (pgUrl) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: pgUrl });
    const { createPostgresRunCancelStore } = await import("@aiagent/database");
    cancelStore = createPostgresRunCancelStore(pool);
  } else {
    // 无 Postgres：退化为内存 cancelStore，同样覆盖 createSharedExecutionRegistry 的跨实例传播路径。
    cancelStore = createInMemoryRunCancelStore();
  }

  const signal = createInMemoryRunCancelSignal();
  // 两个注册表共享 signal + cancelStore，模拟实例 A / B 进程分离但共享存储。
  const registryA = createSharedExecutionRegistry({ cancelSignal: signal, cancelStore });
  const registryB = createSharedExecutionRegistry({ cancelSignal: signal, cancelStore });

  const runId = "xrun-1";
  const controller = registryA.create(runId); // 实例 A 持有该 run 的本地 AbortController

  // 实例 B 发起跨实例取消：写 DB 标记 + 经共享信号广播。
  await registryB.requestCancel(runId);

  // 实例 A 的本地 AbortController 应经共享信号被中断。
  assert.equal(controller.signal.aborted, true, "共享取消信号应中断另一实例上执行的 run");
  // DB 标记持久化：execute 启动回查可兜底「广播早于订阅」的 queued 竞态。
  assert.equal(await cancelStore.isCancelled(runId), true, "取消标记应已持久化");

  registryA.delete(runId);
  if (pool) await pool.end();
});

test("跨实例取消：未取消的 run 不应被中断", async () => {
  const cancelStore = createInMemoryRunCancelStore();
  const signal = createInMemoryRunCancelSignal();
  const registryA = createSharedExecutionRegistry({ cancelSignal: signal, cancelStore });
  const controller = registryA.create("run-alive");
  assert.equal(controller.signal.aborted, false);
  assert.equal(await cancelStore.isCancelled("run-alive"), false);
  registryA.delete("run-alive");
});
