/**
 * reconcile / lock 测试（Task 10）。
 *
 * 覆盖三件事：
 *  (a) run 文件有 meta + 若干非终态事件、索引缺失 → reconcileOnStart 后索引补齐、
 *      快照终态收敛为 interrupted；
 *  (b) 事件尾部追加半行 JSON → listEvents 不抛错且保留前面事件；
 *  (c) 第二个并发 acquireDataDirLock 抛结构化错误，释放后第二次 acquire 成功。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDataDirLock } from "../dist/store/lock.js";
import { reconcileOnStart } from "../dist/store/reconcile.js";
import { LocalRunStore } from "../dist/store/run-store.js";
import { LocalMessageStore } from "../dist/store/message-store.js";
import { LocalSessionStore } from "../dist/store/session-store.js";

/** 临时数据目录，测试后清理（await 内部逻辑，避免 finally 抢删未完成的异步写入）。 */
async function withTmpDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ohna-reconcile-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 构造一个带 run_meta + 若干非终态事件的 run 文件（不写索引）。 */
function writeRunFile(runsDir, file) {
  mkdirSync(runsDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "run_meta",
      runId: file.runId,
      requestId: "req-1",
      conversationId: file.conversationId,
      modelId: "test-model",
      mode: "auto",
      source: "composer",
      userMessageId: "u1",
      createdAt: "2026-10-26T00:00:00.000Z"
    }),
    JSON.stringify({
      eventId: "e1",
      runId: file.runId,
      requestId: "req-1",
      conversationId: file.conversationId,
      sequence: 1,
      type: "agent_start",
      createdAt: "2026-10-26T00:00:01.000Z",
      payload: {}
    }),
    JSON.stringify({
      eventId: "e2",
      runId: file.runId,
      requestId: "req-1",
      conversationId: file.conversationId,
      sequence: 2,
      type: "tool_execution_start",
      createdAt: "2026-10-26T00:00:02.000Z",
      payload: {}
    })
  ];
  writeFileSync(join(runsDir, `${file.runId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

test("(a) 索引缺失时 reconcileOnStart 补齐索引并把非终态 run 收敛为 interrupted", async () => {
  await withTmpDataDir(async (dataDir) => {
    const runsDir = join(dataDir, "runs");
    writeRunFile(runsDir, { runId: "run-abc", conversationId: "conv-1" });

    const stores = {
      runStore: new LocalRunStore(runsDir),
      messageStore: new LocalMessageStore(join(dataDir, "conversations")),
      sessionStore: new LocalSessionStore(join(dataDir, "sessions"))
    };
    await reconcileOnStart(dataDir, stores);

    const metas = await stores.runStore.listRunsByConversation("conv-1");
    assert.equal(metas.length, 1, "索引应补齐该 run");
    assert.equal(metas[0].runId, "run-abc");

    const snapshot = await stores.runStore.getRun("run-abc");
    assert.ok(snapshot, "快照应存在");
    assert.equal(snapshot.status, "interrupted", "非终态 run 应收敛为 interrupted");
  });
});

test("(b) 事件尾部半行 JSON：listEvents 不抛错且保留前面事件", async () => {
  await withTmpDataDir(async (dataDir) => {
    const runsDir = join(dataDir, "runs");
    writeRunFile(runsDir, { runId: "run-half", conversationId: "conv-2" });
    // 追加半行 JSON（模拟崩溃残留）。
    const filePath = join(runsDir, "run-half.jsonl");
    writeFileSync(filePath, '{"eventId":"e3","runId":"run-half"', { flag: "a" });

    const runStore = new LocalRunStore(runsDir);
    const events = await runStore.listEvents("run-half");
    assert.equal(events.length, 2, "半行损坏事件应被跳过，保留前面 2 条");
    assert.equal(events[0].sequence, 1);
    assert.equal(events[1].sequence, 2);
  });
});

test("(c) 并发第二个 acquireDataDirLock 抛结构化错误，释放后再次 acquire 成功", async () => {
  await withTmpDataDir(async (dataDir) => {
    const first = await acquireDataDirLock(dataDir);
    await assert.rejects(
      async () => acquireDataDirLock(dataDir),
      (err) => {
        assert.ok(err instanceof Error, "应抛出错误");
        assert.equal(typeof err.code, "string", "应为结构化错误（带 code）");
        return true;
      }
    );
    await first.release();
    const second = await acquireDataDirLock(dataDir);
    assert.ok(second, "释放后应能再次获取锁");
    await second.release();
  });
});
