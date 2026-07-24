import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/identity/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        requestId: "identity_test",
        data: {
          userId: "user_browser_test",
          createdAt: "2026-07-24T00:00:00.000Z",
          qqBot: { enabled: false, status: "disabled" }
        }
      })
    });
  });
});

test("chat shell is accessible and responsive", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Agent Chat 主区域" })).toBeVisible();
  await expect(page.getByRole("textbox")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);

  if (testInfo.project.name === "mobile") {
    await page.getByRole("button", { name: "打开会话列表" }).click();
    await expect(page.getByRole("complementary", { name: "会话列表" })).toHaveClass(/is-open/);
  }
});
