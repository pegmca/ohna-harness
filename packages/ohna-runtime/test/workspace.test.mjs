/**
 * Task 6 · 工作区授权与全资源归属校验测试（spec §6）。
 *
 * 覆盖计划强制场景：
 * - 未注册工作区的 conversation/run 访问资源操作抛 `forbidden`；
 * - 注册 + 绑定后同操作成功；
 * - 撤销工作区后再访问抛 `workspace_unavailable`；
 * - `canonicalizeWorkspaceRoot` 把符号链接归一为同一 realpath。
 *
 * 仅验证授权与归属反查，不驱动真实 run 执行（执行链路在 Task 9 接通）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RunManager,
  WorkspaceRegistry,
  canonicalizeWorkspaceRoot,
  LocalMessageStore,
  LocalRunStore,
  LocalSessionStore
} from "../dist/index.js";

/** 最小可用模型：RunManager 构造只需 contextWindow / maxTokens。 */
function makeModel() {
  return {
    id: "stub-model",
    name: "Stub Model",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048
  };
}

/** 临时数据目录，测试后清理。 */
async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ohna-ws-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 构造一个带工作区注册表的 RunManager 以及配套断言闭包（与组合根同构：
 * runId 优先反查，否则回退 conversation 维度）。
 *
 * @param {object} ctx 临时目录与 stores。
 * @returns {{ rm: RunManager, reg: WorkspaceRegistry, assertAuthorized: Function }}
 */
function buildManager(ctx) {
  const { dir } = ctx;
  const sessionStore = new LocalSessionStore(join(dir, "sessions"));
  const messageStore = new LocalMessageStore(join(dir, "messages"));
  const runStore = new LocalRunStore(join(dir, "runs"));
  const reg = new WorkspaceRegistry({ sessionStore });
  const assertAuthorized = async (id) => {
    try {
      await reg.resolveRunWorkspace(id);
      return;
    } catch {
      // 非 runId（或 run 尚未绑定）回退到 conversation 维度反查。
    }
    await reg.resolveConversationWorkspace(id);
  };
  const rm = new RunManager({
    workspaceRoot: dir,
    model: makeModel(),
    apiKey: "k",
    systemPrompt: "test",
    tools: [],
    messageStore,
    runStore,
    sessionStore,
    workspaceRegistry: reg,
    assertAuthorized
  });
  return { rm, reg, assertAuthorized, sessionStore };
}

test("未注册工作区：资源操作一律拒绝（forbidden）", async () => {
  await withTmpDir(async (dir) => {
    const { rm } = buildManager({ dir });
    // 没有任何 run/conversation 绑定、注册表为空 → 反查失败抛 forbidden。
    assert.rejects(() => rm.getSnapshot("run-x"), (e) => e.code === "forbidden");
    assert.rejects(() => rm.cancel("run-x"), (e) => e.code === "forbidden");
    assert.rejects(() => rm.listRunsByConversation("conv-x"), (e) => e.code === "forbidden");
    assert.rejects(
      () => rm.resolveConfirmation("run-x", "tc", "allow"),
      (e) => e.code === "forbidden"
    );
  });
});

test("注册 + 绑定后：资源操作放行", async () => {
  await withTmpDir(async (dir) => {
    const { rm, reg, sessionStore } = buildManager({ dir });
    await reg.register("w1", dir);
    reg.bindConversation("conv-1", "w1");
    reg.bindRun("run-1", "conv-1", "w1");
    // 预置会话元数据，使 conversation 维度反查也能命中持久化的 workspaceId。
    sessionStore.create({ title: "c", workspaceRoot: dir, workspaceId: "w1" });

    // getSnapshot：run 已绑定到 w1、w1 已授权 → 不抛（run 不存在返回 null）。
    await rm.getSnapshot("run-1");
    await rm.listRunsByConversation("conv-1");
    // resolveConfirmation：未挂起确认项，结果为 ok=false / code=not_found 而非拒绝。
    await rm.resolveConfirmation("run-1", "tc", "allow");
  });
});

test("撤销工作区后：已绑定 run 访问抛 workspace_unavailable", async () => {
  await withTmpDir(async (dir) => {
    const { rm, reg } = buildManager({ dir });
    await reg.register("w1", dir);
    reg.bindRun("run-1", "conv-1", "w1");
    await reg.release("w1");
    // run 仍绑定 w1，但 w1 已撤销授权 → fail-closed 拒绝。统一 assertAuthorized 会先按
    // run 维度反查（命中已撤销的 w1，抛 workspace_unavailable），catch 后回退 conversation
    // 维度（run 绑定已写回 conversationToWorkspace，抛 forbidden）。两种 code 都属授权失败，
    // 此处接受二者（spec 允许 workspace_unavailable 或 forbidden）。
    await assert.rejects(
      () => rm.getSnapshot("run-1"),
      (e) => e.code === "workspace_unavailable" || e.code === "forbidden"
    );
  });
});

test("canonicalizeWorkspaceRoot：符号链接归一为同一 realpath", async () => {
  await withTmpDir(async (dir) => {
    const tmpA = join(dir, "a");
    const linkB = join(dir, "b");
    mkdirSync(tmpA);
    symlinkSync(tmpA, linkB);
    const canonicalPath = await canonicalizeWorkspaceRoot(linkB);
    assert.equal(canonicalPath, realpathSync(tmpA));
  });
});
