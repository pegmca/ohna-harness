/**
 * TC-L2-03 / TC-FR-001 · 路由面收敛为一个兜底入口。
 *
 * `/trace` 已删除（03 D6），`/settings` 也已删除（05 FR-001：设置改为 chat 页左下角就地弹窗）。
 * 因此两者深链都直接回落到 Workbench，不做重定向、也没有独立页面。
 * 这里直接断言路由表形状（lazy 组件由路由层按需加载，测试不渲染 router，
 * 避免 jsdom 下的 data router 依赖）。
 */
import { describe, expect, it } from "vitest";
import { router } from "./router";

describe("router（L2 / FR-001）", () => {
  it("TC-L2-03: 不再注册 /trace 路由", () => {
    const paths = router.routes.map((route) => route.path);
    expect(paths).not.toContain("/trace");
  });

  it("TC-FR-001: 不再注册 /settings 路由，设置改为就地弹窗", () => {
    const paths = router.routes.map((route) => route.path);
    expect(paths).not.toContain("/settings");
    expect(paths).toEqual(["*"]);
  });

  it("兜底路由承接所有未注册路径（含已删除的 /trace 与 /settings）", () => {
    expect(router.routes).toHaveLength(1);
    expect(router.routes[router.routes.length - 1].path).toBe("*");
  });
});
