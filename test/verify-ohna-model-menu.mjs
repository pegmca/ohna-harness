/**
 * ohna 模型菜单视觉回归：真实渲染层 + 预置 SDK 数据，检查密度、视口边界与滚动归属。
 *
 * 用法：
 *   1. 启动 `pnpm --filter @aiagent/ohna-desktop dev`
 *   2. `node test/verify-ohna-model-menu.mjs`
 *
 * 输出截图与 metrics.json 到 `test/artifacts/ohna-model-menu/`。
 * 退出码非 0 即表示视口越界、重复信息、滚动归属错误或控制台报错，
 * 可直接列入 UI 体验用例的自动回归闸门。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  explainGeometryFailure,
  hasNoHorizontalOverflow,
  isRectWithinViewport,
  isVerticalScrollOwner
} from "./lib/ui-geometry.mjs";

const require = createRequire(new URL("../apps/finance-web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const baseUrl = process.env.OHNA_WEB_URL ?? "http://127.0.0.1:5173";
const outputRoot = join(process.cwd(), "test/artifacts/ohna-model-menu");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const modelGroups = [
  ["主力模型", ["hy3-x", "hy3", "hy4-preview"]],
  ["推理模型", ["deepseek-v4-pro", "kimi-k3.1-pro", "glm-5.3"]],
  ["快速模型", ["deepseek-v4.1-flash", "glm-5.3-flash", "minimax-m3.1-flash", "kimi-k3-1"]],
  ["多模态 / 视觉", ["glm-5v-turbo", "space-bunny"]],
  ["长上下文", ["step-5-preview", "kimi-k2.8-preview", "minimax-m3", "minimax-m2.7", "glm-5.2", "mimo-v2.6-pro"]]
];
const models = modelGroups.flatMap(([group, ids]) => ids.map((id) => ({
  id,
  label: id,
  provider: "bridge_ai",
  group,
  description: `${group} · ${id}`,
  isDefault: id === "hy3-x",
  capabilities: { structuredOutput: true, toolCalling: true },
  contextWindow: 128_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
})));

await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 960, height: 640 }
]) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.addInitScript((catalog) => {
    window.ohna = {
      workspaces: {
        list: async () => [{
          workspaceId: "ws-visual",
          displayPath: "/Users/example/an-extremely-long-visual-workspace-name-for-model-menu",
          status: "authorized"
        }],
        pick: async () => null,
        gitBranch: async () => "main"
      },
      conversations: {
        list: async () => [{
          conversationId: "conversation-visual",
          title: "模型菜单视觉回归",
          status: "active",
          createdAt: "2026-10-31T00:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
          lastMessageAt: "2026-10-31T00:00:00.000Z",
          workspaceId: "ws-visual"
        }],
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
      models: { list: async () => catalog },
      app: {
        getHealth: async () => ({
          status: "ok",
          protocolVersion: 1,
          modelCount: catalog.models.length,
          workspaceCount: 1
        })
      },
      settings: {
        get: async () => ({
          defaultProfile: "bridge_ai",
          providers: {
            bridge_ai: {
              baseUrl: "http://127.0.0.1:1234/v1",
              model: "hy3-x",
              models: catalog.models.map((model) => model.id),
              groups: [{
                name: "全部模型",
                models: catalog.models.map((model) => model.id)
              }],
              apiKey: "visual"
            }
          }
        }),
        save: async () => ({ path: "/tmp/settings.json" }),
        fetchModels: async () => catalog.models.map((model) => model.id)
      }
    };
  }, { defaultModelId: "hy3-x", models });

  await page.goto(`${baseUrl}/?conversation=conversation-visual`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "hy3-x" }).click();
  const list = page.getByRole("listbox", { name: "模型列表" });
  await list.waitFor();
  const metrics = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const box = element.getBoundingClientRect();
      return {
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        left: box.left,
        width: box.width,
        height: box.height,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY
      };
    };
    const list = document.querySelector(".model-list");
    const descriptions = [...document.querySelectorAll(".model-option small")]
      .map((element) => element.textContent ?? "");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      popover: rect(".model-popover"),
      list: rect(".model-list"),
      pageScrollWidth: document.documentElement.scrollWidth,
      pageScrollHeight: document.documentElement.scrollHeight,
      duplicatedDescriptions: descriptions.filter((text) => text.includes(" · ")),
      htmlOverflowX: getComputedStyle(document.documentElement).overflowX,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      listIsScrollable: Boolean(list && list.scrollHeight > list.clientHeight),
      firstOption: rect(".model-option")
    };
  });
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const afterScroll = await page.evaluate(() => {
    const popover = document.querySelector(".model-popover")?.getBoundingClientRect();
    return {
      popoverTop: popover?.top ?? null,
      popoverBottom: popover?.bottom ?? null,
      pageScrollY: window.scrollY
    };
  });
  await page.getByRole("option", { name: "选择模型 kimi-k3.1-pro" }).click();
  const selectedModel = await page.locator(".model-selector").textContent();
  await page.screenshot({
    path: join(outputRoot, `${viewport.width}x${viewport.height}.png`),
    fullPage: false
  });
  results.push({ viewport, consoleErrors, metrics, afterScroll, selectedModel });
  await page.close();
}

await browser.close();
await writeFile(join(outputRoot, "metrics.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(JSON.stringify(results, null, 2));

for (const result of results) {
  const { metrics, consoleErrors, viewport } = result;
  if (consoleErrors.length > 0) throw new Error(`Console errors at ${viewport.width}px: ${consoleErrors.join("; ")}`);
  const geometryFailure = explainGeometryFailure("model menu", {
    rect: metrics.popover,
    viewport,
    scrollWidth: metrics.pageScrollWidth,
    scrollContainer: metrics.list
  });
  if (geometryFailure) throw new Error(geometryFailure);
  if (metrics.duplicatedDescriptions.length > 0) throw new Error(`Duplicated model descriptions at ${viewport.width}px`);
  if (!isVerticalScrollOwner(metrics.list)) throw new Error(`Model list did not become scrollable at ${viewport.width}px`);
  if (!hasNoHorizontalOverflow(metrics.pageScrollWidth, viewport.width)) {
    throw new Error(`Horizontal page overflow at ${viewport.width}px`);
  }
  if (result.afterScroll.popoverTop === null || result.afterScroll.popoverBottom === null
    || !isRectWithinViewport({
      top: result.afterScroll.popoverTop,
      right: metrics.popover.right,
      bottom: result.afterScroll.popoverBottom,
      left: metrics.popover.left
    }, viewport)) {
    throw new Error(`Model popover escaped viewport after list scroll at ${viewport.width}px`);
  }
  if (result.selectedModel?.trim() !== "kimi-k3.1-pro") {
    throw new Error(`Model selection did not apply at ${viewport.width}px`);
  }
}
