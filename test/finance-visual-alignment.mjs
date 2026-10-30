import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(
  new URL("../apps/finance-web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");

/**
 * 金融 Web 视觉对齐验收：截图空态、设置弹窗与运行详情，并检查关键区域是否溢出。
 *
 * 用法：先启动 `pnpm --filter @aiagent/finance-web dev --port 4173`，
 * 再执行 `node test/finance-visual-alignment.mjs`。
 */
const baseUrl = process.env.FINANCE_WEB_URL ?? "http://127.0.0.1:4173";
const outputDir = resolve(
  process.cwd(),
  "test/artifacts/finance-visual-alignment",
);
await mkdir(outputDir, { recursive: true });

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

await page.route("**/api/models", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-models",
      data: {
        defaultModelId: "mock",
        models: [
          {
            id: "mock",
            label: "Mock Agent",
            provider: "mock",
            description: "Visual verification model",
            isDefault: true,
            capabilities: { structuredOutput: true, toolCalling: true },
          },
        ],
      },
    }),
  });
});
let releaseIdentity;
const identityGate = new Promise((resolveIdentity) => {
  releaseIdentity = resolveIdentity;
});
await page.route("**/api/identity/me", async (route) => {
  await identityGate;
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-identity",
      data: {
        userId: "user_visual_check",
        createdAt: "2026-10-30T00:00:00.000Z",
        qqBot: { enabled: false, status: "disabled" },
      },
    }),
  });
});
await page.route(/\/api\/conversations(?:\?.*)?$/, async (route) => {
  const items = page.url().includes("conversation=c1")
    ? [
        {
          conversationId: "c1",
          title: "已有会话",
          status: "active",
          createdAt: "2026-10-30T00:00:00.000Z",
          updatedAt: "2026-10-30T00:00:00.000Z",
          lastMessageAt: "2026-10-30T00:00:00.000Z",
        },
      ]
    : [];
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-conversations",
      data: { items },
    }),
  });
});
await page.route("**/api/conversations/c1/messages?*", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-messages",
      data: {
        items: [
          {
            messageId: "u1",
            conversationId: "c1",
            role: "user",
            content: "查询 000001.SZ 的 ROE",
            messageType: "normal",
            sequence: 1,
            createdAt: "2026-10-30T00:00:00.000Z",
          },
          {
            messageId: "a1",
            conversationId: "c1",
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-1",
                name: "query_metrics",
                arguments: { ticker: "000001.SZ" },
              },
              {
                type: "text",
                text: "ROE 为 12%。",
              },
            ],
            messageType: "normal",
            sequence: 2,
            createdAt: "2026-10-30T00:00:00.000Z",
            runId: "run-visual",
            modelId: "mock",
          },
        ],
      },
    }),
  });
});

await page.addInitScript(() =>
  localStorage.setItem("immersive.theme", "light"),
);
await page.goto(baseUrl);
await page.getByRole("region", { name: "Agent Chat 主区域" }).waitFor();
const pendingIdentityState = {
  loadingGateVisible: await page
    .getByText("正在识别当前浏览器")
    .isVisible()
    .catch(() => false),
  workbenchVisible: await page
    .getByRole("region", { name: "Agent Chat 主区域" })
    .isVisible(),
};
const composerPlaceholderState = {
  value: await page.getByRole("textbox").inputValue(),
  placeholder: await page.getByRole("textbox").getAttribute("placeholder"),
};
releaseIdentity();
await page.getByText("Financial Research Agent").waitFor();
await page.locator(".empty-brand-logo .lottie-player svg").waitFor();
await page.waitForTimeout(3_200);
await page.screenshot({
  path: resolve(outputDir, "desktop-empty.png"),
  fullPage: true,
});
const lottie = await page.evaluate(() => {
  const canvas = document.querySelector(".empty-brand-logo .lottie-player");
  const svg = canvas?.querySelector("svg");
  const fallback = canvas?.querySelector(".empty-brand-svg");
  const canvasRect =
    canvas instanceof HTMLElement ? canvas.getBoundingClientRect() : undefined;
  const fallbackRect =
    fallback instanceof HTMLElement
      ? fallback.getBoundingClientRect()
      : undefined;
  return {
    animationSvgWidth: svg?.getBoundingClientRect().width ?? null,
    canvasHeight: canvasRect?.height ?? null,
    canvasWidth: canvasRect?.width ?? null,
    fallbackWidth: fallbackRect?.width ?? null,
  };
});

const profileTrigger = page.getByRole("button", {
  name: /捡垃圾的小帅|不化妆的小美/,
});
await profileTrigger.click();
const profileEntries = await page
  .getByRole("menu", { name: "工作区二级入口" })
  .getByRole("menuitem")
  .allTextContents();
await page.screenshot({ path: resolve(outputDir, "desktop-profile-menu.png") });
await page.getByRole("menuitem", { name: "Settings" }).click();
const settings = page.getByRole("dialog", { name: "设置" });
await settings.waitFor();
await page.screenshot({ path: resolve(outputDir, "desktop-settings.png") });
await page.keyboard.press("Escape");
await settings.waitFor({ state: "detached" });

await page.goto(`${baseUrl}/?conversation=c1`);
await page.getByText("ROE 为 12%。").waitFor();
await page.getByText("已完成").click();
await page.getByRole("button", { name: "查看开发者详情" }).click();
await page.getByRole("dialog", { name: "运行详情" }).waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(outputDir, "desktop-run-detail.png") });

const overflow = await page.evaluate(() => {
  const shell = document.querySelector(".agent-app-shell");
  const panel = shell?.querySelector(".run-detail-panel");
  const root = document.documentElement;
  const shellStyle =
    shell instanceof HTMLElement ? getComputedStyle(shell) : null;
  const panelStyle =
    panel instanceof HTMLElement ? getComputedStyle(panel) : null;
  return {
    shellClassName: shell?.className ?? null,
    shellGridTemplateColumns: shellStyle?.gridTemplateColumns ?? null,
    shellWidth:
      shell instanceof HTMLElement ? shell.getBoundingClientRect().width : null,
    panelPosition: panelStyle?.position ?? null,
    panelDisplay: panelStyle?.display ?? null,
    panelClass: panel?.className ?? null,
    bodyScrollWidth: document.body.scrollWidth,
    rootClientWidth: root.clientWidth,
    hasHorizontalOverflow: document.body.scrollWidth > root.clientWidth + 1,
    detailPanelWidth:
      panel instanceof HTMLElement ? panel.getBoundingClientRect().width : null,
  };
});

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const mobilePage = await mobile.newPage();
await mobilePage.addInitScript(() =>
  localStorage.setItem("immersive.theme", "light"),
);
await mobilePage.route("**/api/models", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-mobile-models",
      data: {
        defaultModelId: "mock",
        models: [
          {
            id: "mock",
            label: "Mock Agent",
            provider: "mock",
            description: "Visual verification model",
            isDefault: true,
            capabilities: { structuredOutput: true, toolCalling: true },
          },
        ],
      },
    }),
  });
});
await mobilePage.route("**/api/identity/me", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-mobile-identity",
      data: {
        userId: "user_visual_check_mobile",
        createdAt: "2026-10-30T00:00:00.000Z",
        qqBot: { enabled: false, status: "disabled" },
      },
    }),
  });
});
await mobilePage.route("**/api/conversations?*", async (route) => {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      requestId: "visual-mobile-conversations",
      data: { items: [] },
    }),
  });
});
await mobilePage.goto(baseUrl);
await mobilePage.getByRole("region", { name: "Agent Chat 主区域" }).waitFor();
await mobilePage.locator(".empty-brand-logo .lottie-player svg").waitFor();
await mobilePage.waitForTimeout(3_200);
await mobilePage.screenshot({
  path: resolve(outputDir, "mobile-empty.png"),
  fullPage: true,
});
const mobileOverflow = await mobilePage.evaluate(() => ({
  bodyScrollWidth: document.body.scrollWidth,
  rootClientWidth: document.documentElement.clientWidth,
  hasHorizontalOverflow:
    document.body.scrollWidth > document.documentElement.clientWidth + 1,
}));
await mobilePage.getByRole("button", { name: "打开会话列表" }).click();
await mobilePage
  .getByRole("button", { name: /捡垃圾的小帅|不化妆的小美/ })
  .click();
await mobilePage.getByRole("menuitem", { name: "Settings" }).click();
await mobilePage.getByRole("dialog", { name: "设置" }).waitFor();
await mobilePage.screenshot({
  path: resolve(outputDir, "mobile-settings.png"),
});

const failures = [
  overflow.hasHorizontalOverflow || mobileOverflow.hasHorizontalOverflow
    ? "horizontal overflow detected"
    : undefined,
  (overflow.detailPanelWidth ?? 0) < 390
    ? "desktop detail panel is narrower than 390px"
    : undefined,
  lottie.canvasWidth !== 144 || lottie.canvasHeight !== 144
    ? "empty-state Lottie canvas is not 144px"
    : undefined,
  profileEntries.length !== 6
    ? "profile menu does not contain all six entries"
    : undefined,
  pendingIdentityState.loadingGateVisible ||
  !pendingIdentityState.workbenchVisible
    ? "workbench was blocked by identity loading gate"
    : undefined,
  composerPlaceholderState.value !== "" ||
  composerPlaceholderState.placeholder !== "许下你的愿望..."
    ? "composer is not showing the empty wish placeholder"
    : undefined,
].filter(Boolean);
console.log(
  JSON.stringify(
    {
      outputDir,
      pendingIdentityState,
      composerPlaceholderState,
      lottie,
      profileEntries,
      overflow,
      mobileOverflow,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
await mobile.close();
await context.close();
await browser.close();
