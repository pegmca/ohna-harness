/**
 * 顶部主导航：对话（chat）与 Trace 观测台两个 tab。
 *
 * 只做路由跳转，不持有数据；chat 主页与 trace 页各自渲染同一份导航，视觉一致
 * （`md-tabs` 语义来自 DESIGN.md，不自造第二套 tab 样式）。
 */
import { NavLink } from "react-router-dom";

/**
 * 渲染主导航。
 *
 * @param props.active 当前高亮项。
 * @returns 两个 tab 的导航条。
 */
export function WorkbenchNav(props: { active: "chat" | "trace" }) {
  return (
    <nav className="app-nav" aria-label="主导航">
      <NavLink className={`app-nav-tab ${props.active === "chat" ? "is-active" : ""}`} end to="/">
        对话
      </NavLink>
      <NavLink className={`app-nav-tab ${props.active === "trace" ? "is-active" : ""}`} to="/trace">
        Trace
      </NavLink>
    </nav>
  );
}
