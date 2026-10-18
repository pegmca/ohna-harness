// 调试脚本：定位导致页面最外层出现滚动条的溢出元素。
// 用法：先启动 `pnpm --filter @aiagent/finance-web dev`，再运行 `node test/debug-page-scrollbar.mjs [url]`
// 从 apps/finance-web 解析 playwright（pnpm 不向根目录提升该依赖）。
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/finance-web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const url = process.argv[2] ?? "http://localhost:5199/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 后端不在本地运行时（传入 --mock），用最小假数据放行身份门禁并渲染主界面。
const useMock = process.argv.includes("--mock");
if (useMock) {
  const json = (data) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  await page.route("**/api/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/identity/me") {
      return route.fulfill(json({ userId: "debug-user", createdAt: new Date().toISOString(), qqBot: { enabled: false, status: "disabled" } }));
    }
    if (pathname === "/api/models") {
      return route.fulfill(json({ defaultModelId: "mock", models: [{ id: "mock", label: "Mock", provider: "mock", description: "", isDefault: true, capabilities: { structuredOutput: true, toolCalling: true } }] }));
    }
    if (pathname === "/api/conversations") {
      return route.fulfill(json({ items: [], nextCursor: null }));
    }
    return route.fulfill(json(null));
  });
}

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  const de = document.documentElement;
  const body = document.body;
  const info = {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    documentElement: { scrollW: de.scrollWidth, scrollH: de.scrollHeight, clientW: de.clientWidth, clientH: de.clientHeight, offsetH: de.offsetHeight },
    body: { scrollW: body.scrollWidth, scrollH: body.scrollHeight, offsetH: body.offsetHeight },
    verticalOverflow: de.scrollHeight - de.clientHeight,
    horizontalOverflow: de.scrollWidth - de.clientWidth,
    offenders: [],
  };
  const bodyRect = body.getBoundingClientRect();
  for (const el of body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > bodyRect.height + 1 || r.top < -1) {
      info.offenders.push({
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === "string" ? el.className : "",
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
      });
    }
  }
  info.offenders = info.offenders.slice(0, 20);
  return info;
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
