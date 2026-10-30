/**
 * UX-107 · 侧栏密集状态几何验收。
 *
 * 用真实 renderer 和预置 SDK 数据检查长工作区名 / 长标题 / 归档按钮 / 横向溢出。
 *
 * 用法：启动 ohna-desktop dev 后运行：
 *   node test/verify-ohna-sidebar-dense.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { hasNoHorizontalOverflow, isRectWithinViewport } from "./lib/ui-geometry.mjs";

const require = createRequire(new URL("../apps/finance-web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const baseUrl = process.env.OHNA_WEB_URL ?? "http://127.0.0.1:5173";
const outputRoot = join(process.cwd(), "test/artifacts/ohna-sidebar-dense");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const workspaceId = "ws-a-really-long-workspace-name-for-sidebar-layout-regression";
const conversations = Array.from({ length: 10 }, (_, index) => ({
  conversationId: `conversation-${index + 1}`,
  title: `这是一个非常长的会话标题用于检查侧栏省略与归档按钮是否仍然可见 ${index + 1}`,
  status: "active",
  createdAt: `2026-10-31T00:0${index}:00.000Z`,
  updatedAt: `2026-10-31T00:0${index}:00.000Z`,
  lastMessageAt: `2026-10-31T00:0${index}:00.000Z`,
  workspaceId
}));

await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 960, height: 640 }
]) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.addInitScript(({ conversations: items, workspaceId: id }) => {
    window.ohna = {
      workspaces: {
        list: async () => [{
          workspaceId: id,
          displayPath: "/Users/example/a-really-long-workspace-name-for-sidebar-layout-regression",
          status: "authorized"
        }],
        pick: async () => null,
        gitBranch: async () => "feature/a-really-long-branch-name"
      },
      conversations: {
        list: async () => items,
        listMessages: async () => ({ items: [], nextCursor: null }),
        create: async () => { throw new Error("not needed"); },
        update: async () => null,
        generateTitle: async () => undefined
      },
      runs: {
        start: async () => { throw new Error("not needed"); },
        snapshot: async () => null,
        list: async () => [],
        cancel: async () => null,
        resolveConfirmation: async () => undefined
      },
      events: {
        subscribeRun: async () => () => undefined,
        subscribeConversation: async () => () => undefined
      },
      models: {
        list: async () => ({
          defaultModelId: "model-a",
          models: [{
            id: "model-a",
            label: "Model A",
            provider: "mock",
            description: "Model A",
            isDefault: true,
            capabilities: { structuredOutput: true, toolCalling: true },
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }]
        })
      },
      app: {
        getHealth: async () => ({
          status: "ok",
          protocolVersion: 1,
          modelCount: 1,
          workspaceCount: 1
        })
      },
      settings: {
        get: async () => ({
          defaultProfile: "mock",
          providers: {
            mock: {
              baseUrl: "http://127.0.0.1:1234/v1",
              model: "model-a",
              models: ["model-a"],
              groups: [{ name: "测试组", models: ["model-a"] }],
              apiKey: "visual"
            }
          }
        }),
        save: async () => ({ path: "/tmp/settings.json" }),
        fetchModels: async () => ["model-a"]
      }
    };
  }, { conversations, workspaceId });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".conversation-sidebar").waitFor();
  const metrics = await page.evaluate(() => {
    const rect = (element) => {
      if (!(element instanceof HTMLElement)) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    };
    const titles = [...document.querySelectorAll(".conversation-title")];
    const archiveButtons = [...document.querySelectorAll(".conversation-archive")];
    const groupLabels = [...document.querySelectorAll(".conversation-group-label")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageScrollWidth: document.documentElement.scrollWidth,
      sidebar: rect(document.querySelector(".conversation-sidebar")),
      groupLabel: rect(groupLabels[0]),
      firstTitle: rect(titles[0]),
      firstArchive: rect(archiveButtons[0]),
      archivedVisible: archiveButtons.length === 10 && archiveButtons.every((button) => {
        const box = button.getBoundingClientRect();
        const sidebar = document.querySelector(".conversation-sidebar")?.getBoundingClientRect();
        return box.width > 0 && box.right <= (sidebar?.right ?? 0) + 1;
      }),
      titleOverflow: titles.every((title) => getComputedStyle(title).textOverflow === "ellipsis"),
      titleNowrap: titles.every((title) => getComputedStyle(title).whiteSpace === "nowrap"),
      groupOverflow: getComputedStyle(groupLabels[0]).textOverflow === "ellipsis",
      count: titles.length
    };
  });
  await page.screenshot({
    path: join(outputRoot, `${viewport.width}x${viewport.height}.png`),
    fullPage: false
  });
  results.push({ viewport, consoleErrors, metrics });
  await page.close();
}

await browser.close();
await writeFile(join(outputRoot, "metrics.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(JSON.stringify(results, null, 2));

for (const result of results) {
  const { viewport, consoleErrors, metrics } = result;
  if (consoleErrors.length > 0) throw new Error(`Console errors at ${viewport.width}px: ${consoleErrors.join("; ")}`);
  if (!metrics.sidebar || !metrics.groupLabel || !metrics.firstTitle || !metrics.firstArchive) {
    throw new Error(`Missing sidebar geometry at ${viewport.width}px`);
  }
  if (!hasNoHorizontalOverflow(metrics.pageScrollWidth, viewport.width)) {
    throw new Error(`Page horizontal overflow at ${viewport.width}px`);
  }
  if (!isRectWithinViewport(metrics.sidebar, viewport)
    || !isRectWithinViewport(metrics.firstTitle, viewport)
    || !isRectWithinViewport(metrics.firstArchive, viewport)) {
    throw new Error(`Sidebar element outside viewport at ${viewport.width}px`);
  }
  if (!metrics.archivedVisible) throw new Error(`Archive button is not visible at ${viewport.width}px`);
  if (!metrics.titleOverflow || !metrics.titleNowrap || !metrics.groupOverflow) {
    throw new Error(`Long title/group is not ellipsized at ${viewport.width}px`);
  }
  if (metrics.count !== 10) throw new Error(`Expected 10 conversations at ${viewport.width}px`);
}
