/**
 * TC-L2-03 · `/trace` 路由已删除（03 D6 阻断性升级）。
 *
 * 路由面只剩 `/settings` 与 `*` 兜底；`/trace` 深链因此直接回落到 Workbench，
 * 不做重定向、也不再有独立的三栏观测页。这里直接断言路由表形状（lazy 组件由
 * 路由层按需加载，测试不渲染 router，避免 jsdom 下的 data router 依赖）。
 */
import { describe, expect, it } from "vitest";
import { router } from "./router";

describe("router（L2/L3）", () => {
  it("TC-L2-03: 不再注册 /trace 路由", () => {
    const paths = router.routes.map((route) => route.path);
    expect(paths).not.toContain("/trace");
    expect(paths).toContain("/settings");
    expect(paths).toContain("*");
  });

  it("兜底路由承接所有未注册路径（含已删除的 /trace）", () => {
    expect(router.routes).toHaveLength(2);
    expect(router.routes[router.routes.length - 1].path).toBe("*");
  });
});
