#!/usr/bin/env node
/**
 * ohna-web 布局对齐（docs/v1.4/03-web-layout-alignment.md L4）端到端验证。
 *
 * 不联网、不碰真实 `~/.ohna`：每个「工作区」都是临时目录 + 独立 dataDir 的 serve 实例，
 * 两个实例各自创建会话后，只把 **会话索引文件** 合并进同一个共享 dataDir，
 * 以此复现「多个 CLI 进程共享 `~/.ohna`，任一 web 实例都能看到全部工作区会话」的真实拓扑。
 *
 * 覆盖：
 * 1. TC-L4-01 / TC-L1-01：`GET /api/conversations` 每项 DTO 携带各自的 `workspaceRoot`，
 *    且 `?workspaceRoot=` 过滤只返回该工作区的会话（composer 选会话用）；
 * 2. 静态托管：`apps/ohna-web/dist` 存在时
 *    - `GET /settings` → 200（FR-001 后设置路由已删除，命中 `*` 兜底回到 Workbench）；
 *    - `GET /trace` → 200（路由已删除，命中 `*` 兜底回到 Workbench，不做重定向）；
 *    - dist 资产里不再有独立的 TracePage / SettingsPage chunk（L2 阻断性删除、FR-001 弹窗化），
 *      且 Workbench chunk 内含 `settings-dialog` 与 `settings-entry-button`（构建级证据）。
 *
 * 运行：
 *   pnpm --filter @aiagent/serve build
 *   pnpm --filter @aiagent/ohna-web build   # 可选，缺失时只跳过静态断言
 *   node test/verify-ohna-web-layout.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createOhnaServer } from "../packages/serve/dist/index.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = path.join(repoRoot, "apps/ohna-web/dist");

assert.ok(
  existsSync(path.join(repoRoot, "packages/serve/dist/index.js")),
  "请先 pnpm --filter @aiagent/serve build"
);

const MODEL = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "mock",
  baseUrl: "http://127.0.0.1/mock",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096
};

/** @param {string} message 通过的断言。 */
function pass(message) {
  process.stdout.write(`✓ ${message}\n`);
}

/** @param {string} message 跳过的检查。 */
function skip(message) {
  process.stdout.write(`- ${message}\n`);
}

/**
 * 在指定工作区起一个 serve 实例（独立 dataDir，避免实例间写同一批文件）。
 *
 * @param {string} workspaceRoot 工作区目录。
 * @param {string} dataDir 数据目录。
 * @param {string} title 预建会话标题。
 * @returns {Promise<{server: object, url: string, conversationId: string}>} 实例与地址。
 */
async function startInstance(workspaceRoot, dataDir, title) {
  await fs.mkdir(workspaceRoot, { recursive: true });
  const server = await createOhnaServer({
    workspaceRoot,
    dataDir,
    model: MODEL,
    apiKey: "test-key",
    systemPrompt: `verify-layout ${path.basename(workspaceRoot)}`,
    tools: [],
    staticDir: webDist
  });
  const { url } = await server.listen(0);
  const conversation = await server.createConversation(title);
  return { server, url, conversationId: conversation.conversationId };
}

/**
 * 把两个实例的 `sessions/index.jsonl` 合并进共享 dataDir，模拟「同一 ~/.ohna」。
 *
 * @param {string[]} sourceDataDirs 各实例数据目录。
 * @param {string} sharedDataDir 共享数据目录。
 * @returns {Promise<void>} 无返回值。
 */
async function mergeSessionIndexes(sourceDataDirs, sharedDataDir) {
  const sharedSessions = path.join(sharedDataDir, "sessions");
  await fs.mkdir(sharedSessions, { recursive: true });
  const lines = [];
  for (const dataDir of sourceDataDirs) {
    const file = path.join(dataDir, "sessions", "index.jsonl");
    if (!existsSync(file)) continue;
    const content = await fs.readFile(file, "utf8");
    lines.push(...content.split("\n").filter((line) => line.trim() !== ""));
  }
  await fs.writeFile(path.join(sharedSessions, "index.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/**
 * GET 一个 JSON 端点并返回解析后的 payload。
 *
 * @param {string} url 完整地址。
 * @returns {Promise<any>} 响应 JSON。
 */
async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} 应返回 200`);
  return response.json();
}

/** 主流程。 */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ohna-layout-verify-"));
  const sharedDataDir = path.join(root, "shared-data");
  const cleanups = [];

  try {
    // ---- 1. 两个工作区各起一个 serve（不同 dataDir），各建 1 个会话 ----
    const wsA = path.join(root, "code-a");
    const wsB = path.join(root, "code-b");
    const a = await startInstance(wsA, path.join(root, "data-a"), "工作区 A 会话");
    const b = await startInstance(wsB, path.join(root, "data-b"), "工作区 B 会话");
    cleanups.push(() => a.server.close(), () => b.server.close());

    const singleA = await getJson(`${a.url}/api/conversations?limit=30`);
    assert.equal(singleA.ok, true, "会话列表应为 ApiResult 成功信封");
    assert.equal(singleA.data.items.length, 1, "实例 A 只应看到自己的会话");
    assert.equal(singleA.data.items[0].workspaceRoot, wsA, "DTO 必填透出 workspaceRoot（实例 A）");
    pass(`TC-L1-01: 单实例 DTO 携带 workspaceRoot=${singleA.data.items[0].workspaceRoot}`);

    // ---- 2. 合并索引到共享 dataDir，再用一个实例读取全量 ----
    await mergeSessionIndexes(
      [path.join(root, "data-a"), path.join(root, "data-b")],
      sharedDataDir
    );
    const shared = await startInstance(wsA, sharedDataDir, "共享目录探针会话");
    cleanups.push(() => shared.server.close());

    const all = await getJson(`${shared.url}/api/conversations?limit=30`);
    assert.equal(all.ok, true, "共享目录会话列表应成功");
    // 共享实例自身也建了 1 个会话（探针），因此工作区根集合是 {A, A, B}。
    const roots = all.data.items.map((item) => item.workspaceRoot).sort();
    assert.deepEqual([...new Set(roots)].sort(), [wsA, wsB].sort(), "共享目录应同时返回两个工作区的会话");
    assert.equal(roots.length, 3, "共享目录应包含两个实例的全部会话（含探针会话）");
    assert.ok(
      all.data.items.every((item) => typeof item.workspaceRoot === "string" && item.workspaceRoot !== ""),
      "每个会话 DTO 都必须携带非空 workspaceRoot"
    );
    pass(`TC-L4-01: 共享 dataDir 下 ${all.data.items.length} 条会话分属 2 个工作区，DTO 字段完整`);

    // 前端分组依据：workspaceRoot → 目录 basename 分组（这里直接按字段验证可分组）。
    const grouped = new Map();
    for (const item of all.data.items) {
      const list = grouped.get(item.workspaceRoot) ?? [];
      list.push(item);
      grouped.set(item.workspaceRoot, list);
    }
    assert.equal(grouped.size, 2, "按 workspaceRoot 应恰好分成 2 组");
    pass("TC-L1-02（数据侧）: 按 workspaceRoot 分组得到 2 个组（渲染顺序由 web 侧 useMemo 决定）");

    // ---- 3. 工作区过滤（composer 选会话用） ----
    const filteredB = await getJson(`${shared.url}/api/conversations?limit=30&workspaceRoot=${encodeURIComponent(wsB)}`);
    assert.equal(filteredB.ok, true, "带 workspaceRoot 过滤的列表应成功");
    assert.ok(filteredB.data.items.length >= 1, "工作区 B 至少应有 1 个会话");
    assert.ok(
      filteredB.data.items.every((item) => item.workspaceRoot === wsB),
      "过滤结果只能包含工作区 B 的会话"
    );
    const filteredOther = await getJson(`${shared.url}/api/conversations?limit=30&workspaceRoot=${encodeURIComponent(path.join(root, "code-zzz"))}`);
    assert.equal(filteredOther.data.items.length, 0, "未知工作区应返回空列表");
    pass("TC-L1-04（数据侧）: workspaceRoot 过滤只返回本工作区会话");

    // ---- 4. 静态托管与路由形状 ----
    if (!existsSync(path.join(webDist, "index.html"))) {
      skip("apps/ohna-web/dist 不存在，跳过静态托管断言（先跑 pnpm --filter @aiagent/ohna-web build）");
      return;
    }

    for (const routePath of ["/settings", "/trace", "/"]) {
      const response = await fetch(`${shared.url}${routePath}`);
      assert.equal(response.status, 200, `${routePath} 应回落 200（SPA 兜底）`);
      const html = await response.text();
      assert.ok(html.includes("<div id=\"root\">"), `${routePath} 应返回 web 入口 HTML`);
    }
    pass("TC-L4-01 / TC-FR-001: GET /settings → 200 回落 Workbench（独立设置路由已删除，设置改为就地弹窗）");
    pass("TC-L2-03: GET /trace → 200 回落 Workbench（独立 Trace 路由已删除，无重定向）");

    const assets = await fs.readdir(path.join(webDist, "assets"));
    assert.equal(
      assets.some((name) => /TracePage/i.test(name)),
      false,
      "构建产物中不应再有独立 TracePage chunk（L2 删除）"
    );
    // FR-001：设置不再是 lazy 路由页，随 Workbench 一起打进同一个 chunk。
    assert.equal(
      assets.some((name) => /SettingsPage/i.test(name)),
      false,
      "构建产物中不应再有独立 SettingsPage chunk（FR-001：设置改为就地弹窗）"
    );
    assert.ok(
      assets.some((name) => /Workbench/i.test(name)),
      "构建产物应包含 Workbench chunk（唯一路由入口）"
    );
    const workbenchChunk = assets.find((name) => /Workbench.*\.js$/i.test(name));
    const workbenchSource = await fs.readFile(path.join(webDist, "assets", workbenchChunk), "utf8");
    assert.ok(
      workbenchSource.includes("settings-dialog") && workbenchSource.includes("settings-entry-button"),
      "Workbench chunk 应内含设置弹窗与左下角入口（FR-001）"
    );
    pass("TC-L2-03 / TC-FR-001（构建级）: 无 TracePage / SettingsPage chunk，Workbench chunk 含设置弹窗与入口");
  } finally {
    for (const cleanup of cleanups.reverse()) {
      await cleanup().catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.stdout.write("\nohna-web 布局对齐验证通过\n");
  })
  .catch((error) => {
    process.stderr.write(`\n验证失败：${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
