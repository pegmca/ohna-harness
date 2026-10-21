/**
 * 顶部主导航：「对话」与「设置」两个 tab，外加 chat 页的 Trace 抽屉开关。
 *
 * 背景（03 D6）：Trace 原先是独立路由 `/trace` 的三栏观测页，现已降级为 chat 页右侧抽屉，
 * 因此导航里不再有 Trace tab；chat 页用 {@link TraceToggle} 就地开关抽屉（D5：不发明第二套
 * tab 样式，沿用 `app-nav-tab`）。
 */
import { Activity } from "lucide-react";
import { NavLink } from "react-router-dom";

/**
 * 渲染主导航。
 *
 * @param props.active 当前高亮项。
 * @returns 导航条。
 */
export function WorkbenchNav(props: { active: "chat" | "settings" }) {
  return (
    <nav className="app-nav" aria-label="主导航">
      <NavLink className={`app-nav-tab ${props.active === "chat" ? "is-active" : ""}`} end to="/">
        对话
      </NavLink>
      <NavLink className={`app-nav-tab ${props.active === "settings" ? "is-active" : ""}`} to="/settings">
        设置
      </NavLink>
    </nav>
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
