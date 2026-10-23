/**
 * 顶部主导航：「对话」tab，外加 chat 页的 Trace 抽屉开关。
 *
 * 背景（03 D6 / 05 FR-001）：导航只承载「视图切换」。Trace 原先是独立路由 `/trace` 的
 * 三栏观测页，已降级为 chat 页右侧抽屉；设置也由 `/settings` 路由改为 chat 页左下角入口
 * 触发的就地弹窗——两者都不再占用 tab（D5：不发明第二套 tab 样式，临时开关沿用 `app-nav-tab`）。
 */
import { Activity } from "lucide-react";
import { NavLink } from "react-router-dom";

/**
 * 渲染主导航 tab（目前只有「对话」）。只产出 tab 片段、不自带 `<nav>`：
 * chat 头部把它与 `TraceToggle` 放进同一个 `工作台导航` 容器，避免嵌套两个 landmark。
 *
 * @returns 导航 tab 片段。
 */
export function WorkbenchNav() {
  return (
    <NavLink className="app-nav-tab is-active" end to="/">
      对话
    </NavLink>
  );
}

/**
 * Trace 抽屉开关（chat 页头部动作位）：激活态即抽屉展开。
 *
 * @param props.isOpen 抽屉是否展开。
 * @param props.onToggle 开关回调。
 * @returns 开关按钮。
 */
export function TraceToggle(props: { isOpen: boolean; onToggle: () => void }) {
  return (
    <button
      aria-expanded={props.isOpen}
      aria-pressed={props.isOpen}
      className={`app-nav-tab trace-toggle ${props.isOpen ? "is-active" : ""}`}
      onClick={props.onToggle}
      type="button"
    >
      <Activity className="icon-size" />
      Trace
    </button>
  );
}
