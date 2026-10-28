/**
 * Finance Golden Studio 修复后视觉检查。
 *
 * 使用真实本地 server fixture 与 Vite 页面，验证三个目标视口的布局、
 * 溢出、字号恢复和 mine 交互，并输出截图供人工复核。
 */
import { chromium } from "../apps/finance-web/node_modules/@playwright/test/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const executablePath = join(
  process.env.HOME,
  "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
);
const outputRoot = join(process.cwd(), "test/output/finance-golden-studio-visual");
await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 }
]) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      consoleErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Batches" }).waitFor();
  await page.screenshot({
    path: join(outputRoot, `batches-${viewport.width}.png`),
    fullPage: true
  });

  await page.getByRole("link", { name: "Golden" }).click();
  await page.getByRole("heading", { name: "Golden" }).waitFor();
  await page.getByText("Fresh", { exact: true }).waitFor();
  await page.screenshot({
    path: join(outputRoot, `golden-${viewport.width}.png`),
    fullPage: true
  });

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  await page.getByRole("radio", { name: "Large" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  const fontAttribute = await page.locator("html").getAttribute("data-font-size");
  await page.screenshot({
    path: join(outputRoot, `settings-${viewport.width}.png`),
    fullPage: true
  });

  await page.getByRole("link", { name: "Batches" }).click();
  await page.getByLabel("Batch name").fill(`visual-${viewport.width}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "candidates.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify([
        {
          ticker: "600000.SH",
          report_type: "annual",
          period: "2025",
          type: "numeric_fact"
        }
      ])
    )
  });
  await page.getByText(/1 candidate ready/).waitFor();
  await page.getByRole("button", { name: "Mine candidates" }).click();
  await page.getByRole("dialog", { name: "Mine candidates?" }).waitFor();
  await page.screenshot({
    path: join(outputRoot, `mine-confirm-${viewport.width}.png`),
    fullPage: true
  });
  await page
    .getByRole("dialog", { name: "Mine candidates?" })
    .getByRole("button", { name: "Mine candidates" })
    .click();
  await page.getByText("Mined 1 draft; skipped 0 candidates.").waitFor();
  await page.screenshot({
    path: join(outputRoot, `mine-result-${viewport.width}.png`),
    fullPage: true
  });

  const metrics = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom
      };
    };
    return {
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      fontAttribute: document.documentElement.dataset.fontSize,
      minePanel: rect(".mine-panel"),
      mineButton: rect(".mine-submit"),
      sidebar: rect(".sidebar"),
      main: rect(".main-area")
    };
  });
  results.push({ viewport, fontAttribute, consoleErrors, metrics });
  await page.close();
}

await browser.close();
await writeFile(
  join(outputRoot, "metrics.json"),
  `${JSON.stringify(results, null, 2)}\n`,
  "utf8"
);
console.log(JSON.stringify(results, null, 2));

for (const result of results) {
  if (result.fontAttribute !== "large") {
    throw new Error(`Font size did not survive reload at ${result.viewport.width}px.`);
  }
  if (result.metrics.scrollWidth > result.viewport.width + 1) {
    throw new Error(`Horizontal overflow at ${result.viewport.width}px.`);
  }
  if (result.consoleErrors.length > 0) {
    throw new Error(`Browser errors at ${result.viewport.width}px: ${result.consoleErrors.join("; ")}`);
  }
}
