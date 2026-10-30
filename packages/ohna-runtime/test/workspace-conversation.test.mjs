import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOhnaRuntime } from "../dist/index.js";

/** 最小可用模型：runtime 组合根只读取窗口与费率字段。 */
function makeModel() {
  return {
    id: "test-model",
    name: "Test Model",
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

/**
 * 会话创建必须走工作区授权：未注册的 workspaceId 一律拒绝，
 * 已注册的会话创建后要能凭持久化 workspaceId 反查授权。
 */
test("createConversation 拒绝未授权工作区，且授权后会话可反查", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ohna-conv-ws-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ohna-workspace-"));
  const runtime = await createOhnaRuntime({
    dataDir: dir,
    model: makeModel(),
    apiKey: "k",
    tools: [],
    autoApprove: true
  });

  try {
    await assert.rejects(
      () => runtime.createConversation({ title: "bad", workspaceId: "default" }),
      (error) => error.code === "workspace_unavailable"
    );

    const workspace = await runtime.registerWorkspace("ws-ok", workspaceRoot);
    const conversation = await runtime.createConversation({
      title: "ok",
      workspaceId: workspace.workspaceId
    });

    assert.equal(conversation.workspaceId, workspace.workspaceId);
    // 创建后 runtime 其他入口能反查同一工作区（否则 run 会报未绑定）。
    await runtime.updateConversation(conversation.conversationId, { title: "renamed" });
  } finally {
    await runtime.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerWorkspace 修复历史 default 会话归属", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ohna-conv-migrate-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ohna-workspace-"));
  const runtime = await createOhnaRuntime({
    dataDir: dir,
    model: makeModel(),
    apiKey: "k",
    tools: [],
    autoApprove: true
  });

  try {
    // 直接写一条旧数据形状：workspaceId 为未授权的 "default"。
    const { LocalSessionStore } = await import("../dist/store/index.js");
    const sessions = new LocalSessionStore(join(dir, "sessions"));
    const legacy = await sessions.create({
      id: "legacy-conversation",
      title: "旧会话",
      workspaceId: "default",
      workspaceRoot: "default"
    });

    const workspace = await runtime.registerWorkspace("ws-migrated", workspaceRoot);
    const migrated = await sessions.get(legacy.id);
    assert.equal(migrated.workspaceId, workspace.workspaceId);
    assert.equal(migrated.workspaceRoot, workspace.displayPath);
    await runtime.updateConversation(migrated.id, { title: "迁移后可用" });
  } finally {
    await runtime.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
